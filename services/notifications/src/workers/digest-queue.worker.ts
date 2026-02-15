/**
 * Digest Queue Worker
 *
 * BullMQ worker that processes periodic digest email jobs:
 *   - Queries unread digest-tier notifications per user (respecting last-run markers)
 *   - Batches 2+ notifications into a single digest email via `renderDigest` template
 *   - Sends single notifications as individual emails (not digest template)
 *   - Creates delivery records for each notification included
 *   - Updates `digestRunMarkers` with new last-run timestamp and count
 *   - Supports cron-based repeatable scheduling
 *
 * Schedule: Cron-based (e.g., every 4 hours)
 * Concurrency: 1 (single digest run at a time)
 */

import { Worker } from 'bullmq';
import type { Job, Queue } from 'bullmq';
import {
  createQueue,
  buildJobEnvelope,
  parseRedisUrl,
} from '@arda/jobs';
import type { JobEnvelope } from '@arda/jobs';
import { createLogger } from '@arda/config';
import { db, schema } from '@arda/db';
import { eq, and, gt, inArray } from 'drizzle-orm';
import { DIGEST_TIER_TYPES } from '../services/tier-classification.js';
import { renderDigest, type DigestItem } from '../templates/digest.js';
import { resolveTemplateType, renderTemplate } from '../templates/index.js';
import { createEmailProvider } from '../services/email-provider.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface DigestJobPayload {
  triggeredAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────

export const QUEUE_NAME = 'notifications:digest';
const JOB_TYPE = 'notifications.digest_send';
const MAX_ATTEMPTS = 1;

const log = createLogger('digest-queue-worker');

/** All digest-tier notification type values as an array for SQL IN clause */
const DIGEST_TYPE_VALUES = [...DIGEST_TIER_TYPES] as [
  typeof schema.notifications.type.enumValues[number],
  ...typeof schema.notifications.type.enumValues[number][],
];

// ─── Queue Factory ────────────────────────────────────────────────────

export function createDigestQueue(
  redisUrl: string,
): Queue<JobEnvelope<DigestJobPayload>> {
  return createQueue<DigestJobPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface UserNotifications {
  userId: string;
  notifications: Array<{
    id: string;
    type: string;
    title: string;
    body: string;
    actionUrl: string | null;
    createdAt: Date;
  }>;
}

/**
 * Query unread digest-tier notifications grouped by user for a tenant,
 * respecting per-user last-run markers.
 */
async function getUnreadDigestNotificationsByUser(
  tenantId: string,
): Promise<UserNotifications[]> {
  // 1. Get all last-run markers for this tenant
  const markers = await db
    .select()
    .from(schema.digestRunMarkers)
    .where(eq(schema.digestRunMarkers.tenantId, tenantId));

  const markerByUser = new Map(markers.map((m) => [m.userId, m.lastRunAt]));

  // 2. Get all unread digest-tier notifications for this tenant
  const allNotifications = await db
    .select({
      id: schema.notifications.id,
      userId: schema.notifications.userId,
      type: schema.notifications.type,
      title: schema.notifications.title,
      body: schema.notifications.body,
      actionUrl: schema.notifications.actionUrl,
      createdAt: schema.notifications.createdAt,
    })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.tenantId, tenantId),
        eq(schema.notifications.isRead, false),
        inArray(schema.notifications.type, DIGEST_TYPE_VALUES),
      ),
    );

  // 3. Group by user and filter by last-run marker
  const byUser = new Map<string, UserNotifications['notifications']>();

  for (const n of allNotifications) {
    const lastRun = markerByUser.get(n.userId);
    // Skip notifications that were already included in a prior digest run
    if (lastRun && n.createdAt <= lastRun) {
      continue;
    }

    if (!byUser.has(n.userId)) {
      byUser.set(n.userId, []);
    }
    byUser.get(n.userId)!.push(n);
  }

  return Array.from(byUser.entries()).map(([userId, notifications]) => ({
    userId,
    notifications: notifications.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    ),
  }));
}

/**
 * Create delivery records for each notification in a digest batch.
 */
async function createDeliveryRecords(
  tenantId: string,
  userId: string,
  notificationIds: string[],
  provider: string,
  providerMessageId: string,
): Promise<void> {
  const now = new Date();
  await db.insert(schema.notificationDeliveries).values(
    notificationIds.map((notificationId) => ({
      tenantId,
      notificationId,
      userId,
      channel: 'email' as const,
      status: 'delivered' as const,
      provider,
      providerMessageId,
      attemptCount: 1,
      deliveredAt: now,
      lastAttemptAt: now,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    })),
  );
}

/**
 * Upsert the digest run marker for a user.
 */
async function upsertDigestMarker(
  tenantId: string,
  userId: string,
  lastRunAt: Date,
  notificationCount: number,
): Promise<void> {
  // Check if marker exists
  const [existing] = await db
    .select()
    .from(schema.digestRunMarkers)
    .where(
      and(
        eq(schema.digestRunMarkers.tenantId, tenantId),
        eq(schema.digestRunMarkers.userId, userId),
      ),
    );

  if (existing) {
    await db
      .update(schema.digestRunMarkers)
      .set({
        lastRunAt,
        notificationCount,
        updatedAt: new Date(),
      })
      .where(eq(schema.digestRunMarkers.id, existing.id));
  } else {
    await db.insert(schema.digestRunMarkers).values({
      tenantId,
      userId,
      lastRunAt,
      notificationCount,
    });
  }
}

// ─── Processor ────────────────────────────────────────────────────────

async function processDigestJob(
  job: Job<JobEnvelope<DigestJobPayload>>,
): Promise<void> {
  const { tenantId, payload } = job.data;
  const triggeredAt = new Date(payload.triggeredAt);

  log.info(
    { jobId: job.data.id, tenantId, triggeredAt: payload.triggeredAt },
    'Processing digest job',
  );

  // 1. Get unread digest notifications grouped by user
  const userGroups = await getUnreadDigestNotificationsByUser(tenantId);

  if (userGroups.length === 0) {
    log.info({ tenantId }, 'No users with unread digest notifications');
    return;
  }

  const emailProvider = createEmailProvider();

  // 2. Process each user's batch
  for (const { userId, notifications } of userGroups) {
    if (notifications.length === 0) continue;

    try {
      let result: { provider: string; messageId: string };

      if (notifications.length >= 2) {
        // ─── Multi-item: Digest template ─────────────────────
        const digestItems: DigestItem[] = notifications.map((n) => ({
          type: n.type,
          title: n.title,
          body: n.body,
          actionUrl: n.actionUrl ?? undefined,
          timestamp: n.createdAt.toISOString(),
        }));

        const { subject, html } = renderDigest({
          period: 'Digest',
          items: digestItems,
          allNotificationsUrl: '/notifications',
        });

        result = await emailProvider.send({
          to: userId, // resolved by provider
          subject,
          html,
        });
      } else {
        // ─── Single-item: Individual email template ──────────
        const notification = notifications[0];
        const templateType = resolveTemplateType(notification.type);

        let subject: string;
        let html: string;

        if (templateType) {
          const rendered = renderTemplate(templateType, {
            title: notification.title,
            body: notification.body,
            actionUrl: notification.actionUrl,
          });
          subject = rendered.subject;
          html = rendered.html;
        } else {
          // Fallback to basic rendering
          subject = notification.title;
          html = `<p>${notification.body}</p>`;
        }

        result = await emailProvider.send({
          to: userId,
          subject,
          html,
        });
      }

      // 3. Create delivery records
      await createDeliveryRecords(
        tenantId,
        userId,
        notifications.map((n) => n.id),
        result.provider,
        result.messageId,
      );

      // 4. Update digest run marker
      await upsertDigestMarker(
        tenantId,
        userId,
        triggeredAt,
        notifications.length,
      );

      log.info(
        {
          userId,
          tenantId,
          notificationCount: notifications.length,
          mode: notifications.length >= 2 ? 'digest' : 'single',
        },
        'Digest processed for user',
      );
    } catch (err) {
      log.error(
        {
          userId,
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to process digest for user',
      );
      throw err;
    }
  }

  log.info(
    { tenantId, usersProcessed: userGroups.length },
    'Digest job completed',
  );
}

// ─── Worker Factory ───────────────────────────────────────────────────

export function createDigestWorker(
  redisUrl: string,
): Worker<JobEnvelope<DigestJobPayload>> {
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<JobEnvelope<DigestJobPayload>>(
    QUEUE_NAME,
    async (job) => {
      await processDigestJob(job);
    },
    {
      connection,
      prefix: 'arda',
      concurrency: 1,
      lockDuration: 120_000, // 2 min lock for potentially long digest runs
    },
  );

  // ─── Event Handlers ───────────────────────────────────────────────

  worker.on('completed', (job) => {
    log.info(
      { jobId: job.data.id, tenantId: job.data.tenantId },
      'Digest job completed',
    );
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    log.error(
      {
        jobId: job.data.id,
        tenantId: job.data.tenantId,
        error: err.message,
      },
      'Digest job failed',
    );
  });

  log.info({ worker: QUEUE_NAME }, 'Digest queue worker started');

  return worker;
}

// ─── Convenience: Schedule a repeatable digest job ───────────────────

/**
 * Schedule a repeatable digest job with a cron pattern.
 *
 * @param queue - The digest queue instance
 * @param cronPattern - Cron expression (e.g., '0 *​/4 * * *' for every 4 hours)
 */
export async function scheduleDigestJob(
  queue: Queue<JobEnvelope<DigestJobPayload>>,
  cronPattern: string,
): Promise<void> {
  const envelope = buildJobEnvelope<DigestJobPayload>(
    JOB_TYPE,
    'system', // tenant is resolved at processing time
    { triggeredAt: new Date().toISOString() },
    MAX_ATTEMPTS,
  );

  await queue.add(JOB_TYPE, envelope, {
    repeat: {
      pattern: cronPattern,
    },
    jobId: 'digest-repeatable',
  });

  log.info({ cronPattern }, 'Digest repeatable job scheduled');
}
