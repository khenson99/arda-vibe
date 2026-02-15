/**
 * Retention Cleanup Worker
 *
 * BullMQ repeatable job that runs daily to purge stale data:
 *   - Notification rows older than 90 days (configurable)
 *   - Delivery audit rows older than 180 days (configurable)
 *
 * The job is idempotent: re-running it will simply delete rows
 * that match the retention window — already-purged rows won't match.
 *
 * Schedule: Daily at 03:00 UTC (configurable via cron)
 * Concurrency: 1 (serial to avoid contention on large deletes)
 */

import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';
import {
  createQueue,
  buildJobEnvelope,
  parseRedisUrl,
} from '@arda/jobs';
import type { JobEnvelope } from '@arda/jobs';
import { createLogger } from '@arda/config';
import { db, schema } from '@arda/db';
import { lt, sql } from 'drizzle-orm';

// ─── Types ────────────────────────────────────────────────────────────

export interface RetentionCleanupJobPayload {
  /** Triggering timestamp for determinism in tests */
  triggeredAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────

export const QUEUE_NAME = 'notifications:retention-cleanup';
const JOB_TYPE = 'notifications.retention_cleanup';
const DEFAULT_CRON_SCHEDULE = '0 3 * * *'; // daily at 03:00 UTC

/**
 * Configuration-driven retention thresholds.
 * These can be overridden via environment variables.
 */
export const RETENTION_CONFIG = {
  /** Days to retain notification rows (default: 90) */
  NOTIFICATION_RETENTION_DAYS: parseInt(
    process.env.NOTIFICATION_RETENTION_DAYS || '90',
    10,
  ),
  /** Days to retain delivery audit rows (default: 180) */
  DELIVERY_AUDIT_RETENTION_DAYS: parseInt(
    process.env.DELIVERY_AUDIT_RETENTION_DAYS || '180',
    10,
  ),
  /** Batch size for large delete operations */
  PURGE_BATCH_SIZE: parseInt(
    process.env.RETENTION_PURGE_BATCH_SIZE || '5000',
    10,
  ),
} as const;

const log = createLogger('retention-cleanup-worker');

// ─── Queue Factory ────────────────────────────────────────────────────

export function createRetentionCleanupQueue(
  redisUrl: string,
): Queue<JobEnvelope<RetentionCleanupJobPayload>> {
  return createQueue<RetentionCleanupJobPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: 1, // don't retry — repeatable jobs will pick up next cycle
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });
}

// ─── Purge Helpers ────────────────────────────────────────────────────

/**
 * Delete notification rows older than the configured retention window.
 * Returns the number of rows deleted.
 */
async function purgeOldNotifications(cutoffDate: Date): Promise<number> {
  const result = await db
    .delete(schema.notifications)
    .where(lt(schema.notifications.createdAt, cutoffDate));

  // Drizzle returns an array; use length as proxy for affected rows
  const count = Array.isArray(result) ? result.length : 0;
  return count;
}

/**
 * Delete delivery audit rows older than the configured retention window.
 * Returns the number of rows deleted.
 */
async function purgeOldDeliveryAuditRows(cutoffDate: Date): Promise<number> {
  const result = await db
    .delete(schema.notificationDeliveries)
    .where(lt(schema.notificationDeliveries.createdAt, cutoffDate));

  const count = Array.isArray(result) ? result.length : 0;
  return count;
}

// ─── Processor ────────────────────────────────────────────────────────

async function processRetentionCleanupJob(
  job: Job<JobEnvelope<RetentionCleanupJobPayload>>,
): Promise<void> {
  const triggeredAt = new Date(job.data.payload.triggeredAt);

  log.info(
    {
      jobId: job.data.id,
      triggeredAt: triggeredAt.toISOString(),
      notificationRetentionDays: RETENTION_CONFIG.NOTIFICATION_RETENTION_DAYS,
      deliveryRetentionDays: RETENTION_CONFIG.DELIVERY_AUDIT_RETENTION_DAYS,
    },
    'Processing retention cleanup job',
  );

  // 1. Calculate cutoff dates
  const notificationCutoff = new Date(triggeredAt);
  notificationCutoff.setDate(
    notificationCutoff.getDate() - RETENTION_CONFIG.NOTIFICATION_RETENTION_DAYS,
  );

  const deliveryCutoff = new Date(triggeredAt);
  deliveryCutoff.setDate(
    deliveryCutoff.getDate() - RETENTION_CONFIG.DELIVERY_AUDIT_RETENTION_DAYS,
  );

  // 2. Purge old notifications
  const notificationsPurged = await purgeOldNotifications(notificationCutoff);
  log.info(
    {
      purgedCount: notificationsPurged,
      cutoffDate: notificationCutoff.toISOString(),
      retentionDays: RETENTION_CONFIG.NOTIFICATION_RETENTION_DAYS,
    },
    'Purged old notification rows',
  );

  // 3. Purge old delivery audit rows
  const deliveriesPurged = await purgeOldDeliveryAuditRows(deliveryCutoff);
  log.info(
    {
      purgedCount: deliveriesPurged,
      cutoffDate: deliveryCutoff.toISOString(),
      retentionDays: RETENTION_CONFIG.DELIVERY_AUDIT_RETENTION_DAYS,
    },
    'Purged old delivery audit rows',
  );

  log.info(
    {
      notificationsPurged,
      deliveriesPurged,
    },
    'Retention cleanup job completed',
  );
}

// ─── Worker Factory ───────────────────────────────────────────────────

export function createRetentionCleanupWorker(
  redisUrl: string,
): Worker<JobEnvelope<RetentionCleanupJobPayload>> {
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<JobEnvelope<RetentionCleanupJobPayload>>(
    QUEUE_NAME,
    async (job) => {
      try {
        await processRetentionCleanupJob(job);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        log.error(
          {
            jobId: job.data.id,
            error: errorMessage,
          },
          'Retention cleanup job failed with exception',
        );

        throw err;
      }
    },
    {
      connection,
      prefix: 'arda',
      concurrency: 1, // serial — one cleanup at a time
      lockDuration: 600_000, // 10 min — large deletes can be slow
    },
  );

  worker.on('completed', (job) => {
    log.info(
      { jobId: job.data.id },
      'Retention cleanup job completed',
    );
  });

  worker.on('failed', (job, err) => {
    if (!job) return;

    log.error(
      {
        jobId: job.data.id,
        error: err.message,
      },
      'Retention cleanup job failed',
    );
  });

  log.info({ worker: QUEUE_NAME }, 'Retention cleanup worker started');

  return worker;
}

// ─── Schedule ─────────────────────────────────────────────────────────

/**
 * Schedule a repeatable retention cleanup job with the configured cron.
 */
export async function scheduleRetentionCleanupJob(
  queue: Queue<JobEnvelope<RetentionCleanupJobPayload>>,
  cronSchedule: string = DEFAULT_CRON_SCHEDULE,
): Promise<void> {
  // Remove any existing repeatable jobs first
  const repeatableJobs = await queue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    if (job.name === JOB_TYPE) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  // Add new repeatable job
  const envelope = buildJobEnvelope<RetentionCleanupJobPayload>(
    JOB_TYPE,
    'system', // tenant-agnostic
    { triggeredAt: new Date().toISOString() },
    1,
  );

  await queue.add(JOB_TYPE, envelope, {
    repeat: {
      pattern: cronSchedule,
    },
  });

  log.info({ cronSchedule }, 'Retention cleanup job scheduled');
}
