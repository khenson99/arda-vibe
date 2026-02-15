/**
 * Bounce Rate Monitor Worker
 *
 * BullMQ repeatable job that runs hourly to detect high bounce rates:
 *   - Aggregates email delivery stats per tenant for the lookback window
 *   - Pauses outbound email for tenants exceeding the bounce rate threshold
 *   - Creates a system alert notification for tenant admins on pause
 *
 * Safeguards:
 *   - Minimum sample size guard to avoid false positives on low volume
 *   - Threshold is strictly greater-than (>5%) — exactly 5% does NOT trigger
 *   - Idempotent: re-running will re-evaluate current window, already-paused tenants
 *     simply get an update to their settings (no-op effect)
 *
 * Schedule: Hourly at :15 past (configurable via cron)
 * Concurrency: 1 (serial to avoid contention)
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
import { eq, and, gte, sql } from 'drizzle-orm';
import { getEventBus } from '@arda/events';

// ─── Types ────────────────────────────────────────────────────────────

export interface BounceRateMonitorJobPayload {
  /** Triggering timestamp for determinism in tests */
  triggeredAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────

export const QUEUE_NAME = 'notifications:bounce-rate-monitor';
const JOB_TYPE = 'notifications.bounce_rate_monitor';
const DEFAULT_CRON_SCHEDULE = '15 * * * *'; // every hour at :15

/**
 * Configuration-driven bounce rate thresholds.
 * These can be overridden via environment variables.
 */
export const BOUNCE_RATE_CONFIG = {
  /** Bounce rate threshold in percent — tenants exceeding this get paused (default: 5) */
  BOUNCE_RATE_THRESHOLD_PERCENT: parseInt(
    process.env.BOUNCE_RATE_THRESHOLD_PERCENT || '5',
    10,
  ),
  /** Minimum email deliveries in the lookback window to evaluate (default: 10) */
  MIN_SAMPLE_SIZE: parseInt(
    process.env.BOUNCE_RATE_MIN_SAMPLE_SIZE || '10',
    10,
  ),
  /** Hours to look back for delivery stats (default: 24) */
  LOOKBACK_HOURS: parseInt(
    process.env.BOUNCE_RATE_LOOKBACK_HOURS || '24',
    10,
  ),
} as const;

const log = createLogger('bounce-rate-monitor-worker');

// ─── Queue Factory ────────────────────────────────────────────────────

export function createBounceRateMonitorQueue(
  redisUrl: string,
): Queue<JobEnvelope<BounceRateMonitorJobPayload>> {
  return createQueue<BounceRateMonitorJobPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: 1, // don't retry — repeatable jobs will pick up next cycle
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface TenantBounceStats {
  tenantId: string;
  total: string;
  bounced: string;
}

/**
 * Query email delivery stats grouped by tenant for the lookback window.
 * Returns total email deliveries and bounced count per tenant.
 */
async function getTenantBounceStats(
  lookbackDate: Date,
): Promise<TenantBounceStats[]> {
  const stats = await db
    .select({
      tenantId: schema.notificationDeliveries.tenantId,
      total: sql<string>`count(*)`,
      bounced: sql<string>`count(*) filter (where ${schema.notificationDeliveries.status} = 'bounced')`,
    })
    .from(schema.notificationDeliveries)
    .where(
      and(
        eq(schema.notificationDeliveries.channel, 'email'),
        gte(schema.notificationDeliveries.createdAt, lookbackDate),
      ),
    )
    .groupBy(schema.notificationDeliveries.tenantId);

  return stats as TenantBounceStats[];
}

/**
 * Pause outbound email for a tenant by setting emailPaused in tenant settings.
 */
async function pauseTenantEmail(tenantId: string, bounceRate: number): Promise<void> {
  await db
    .update(schema.tenants)
    .set({
      settings: sql`jsonb_set(
        coalesce(${schema.tenants.settings}, '{}'),
        '{emailPaused}',
        'true'
      )`,
    })
    .where(eq(schema.tenants.id, tenantId));

  log.warn(
    {
      tenantId,
      bounceRate: `${bounceRate.toFixed(2)}%`,
      threshold: `${BOUNCE_RATE_CONFIG.BOUNCE_RATE_THRESHOLD_PERCENT}%`,
    },
    'Paused outbound email for tenant due to high bounce rate',
  );
}

/**
 * Create a system alert notification for the tenant admin about the email pause.
 */
async function createBounceAlertNotification(
  tenantId: string,
  bounceRate: number,
): Promise<void> {
  try {
    // Insert alert notification — visible to admin users
    await db
      .insert(schema.notifications)
      .values({
        tenantId,
        userId: 'system', // system-generated notification
        type: 'system_alert',
        title: 'Outbound Email Paused — High Bounce Rate',
        body: `Outbound email has been automatically paused for your organization. ` +
          `The bounce rate of ${bounceRate.toFixed(1)}% exceeds the ${BOUNCE_RATE_CONFIG.BOUNCE_RATE_THRESHOLD_PERCENT}% safety threshold. ` +
          `Please review your email delivery health and contact support to resume.`,
        metadata: {
          bounceRate,
          threshold: BOUNCE_RATE_CONFIG.BOUNCE_RATE_THRESHOLD_PERCENT,
          action: 'email_paused',
        },
      })
      .returning({ id: schema.notifications.id });

    // Publish event for real-time listeners
    const eventBus = getEventBus();
    await eventBus.publish({
      type: 'notification.created',
      tenantId,
      userId: 'system',
      notificationId: `bounce-alert-${tenantId}-${Date.now()}`,
      notificationType: 'system_alert',
      title: 'Outbound Email Paused — High Bounce Rate',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Don't fail the entire job if alerting fails — the pause is the critical action
    log.error(
      {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to create bounce alert notification (email still paused)',
    );
  }
}

// ─── Processor ────────────────────────────────────────────────────────

async function processBounceRateMonitorJob(
  job: Job<JobEnvelope<BounceRateMonitorJobPayload>>,
): Promise<void> {
  const triggeredAt = new Date(job.data.payload.triggeredAt);

  log.info(
    {
      jobId: job.data.id,
      triggeredAt: triggeredAt.toISOString(),
      thresholdPercent: BOUNCE_RATE_CONFIG.BOUNCE_RATE_THRESHOLD_PERCENT,
      minSampleSize: BOUNCE_RATE_CONFIG.MIN_SAMPLE_SIZE,
      lookbackHours: BOUNCE_RATE_CONFIG.LOOKBACK_HOURS,
    },
    'Processing bounce rate monitor job',
  );

  // 1. Calculate lookback window
  const lookbackDate = new Date(triggeredAt);
  lookbackDate.setHours(lookbackDate.getHours() - BOUNCE_RATE_CONFIG.LOOKBACK_HOURS);

  // 2. Get per-tenant bounce stats
  const tenantStats = await getTenantBounceStats(lookbackDate);

  if (tenantStats.length === 0) {
    log.info('No email deliveries found in lookback window — nothing to check');
    return;
  }

  // 3. Evaluate each tenant
  let pausedCount = 0;

  for (const stats of tenantStats) {
    const total = parseInt(stats.total, 10);
    const bounced = parseInt(stats.bounced, 10);

    // Skip tenants below minimum sample size
    if (total < BOUNCE_RATE_CONFIG.MIN_SAMPLE_SIZE) {
      log.debug(
        {
          tenantId: stats.tenantId,
          total,
          minSampleSize: BOUNCE_RATE_CONFIG.MIN_SAMPLE_SIZE,
        },
        'Skipping tenant — below minimum sample size',
      );
      continue;
    }

    const bounceRate = (bounced / total) * 100;

    // Strictly greater-than: exactly at threshold does NOT trigger
    if (bounceRate > BOUNCE_RATE_CONFIG.BOUNCE_RATE_THRESHOLD_PERCENT) {
      log.warn(
        {
          tenantId: stats.tenantId,
          bounceRate: `${bounceRate.toFixed(2)}%`,
          total,
          bounced,
          threshold: `${BOUNCE_RATE_CONFIG.BOUNCE_RATE_THRESHOLD_PERCENT}%`,
        },
        'Tenant exceeds bounce rate threshold — pausing email',
      );

      // Pause email for this tenant
      await pauseTenantEmail(stats.tenantId, bounceRate);

      // Create alert notification
      await createBounceAlertNotification(stats.tenantId, bounceRate);

      pausedCount++;
    } else {
      log.debug(
        {
          tenantId: stats.tenantId,
          bounceRate: `${bounceRate.toFixed(2)}%`,
          total,
          bounced,
        },
        'Tenant bounce rate within acceptable range',
      );
    }
  }

  log.info(
    {
      tenantsEvaluated: tenantStats.length,
      tenantsPaused: pausedCount,
    },
    'Bounce rate monitor job completed',
  );
}

// ─── Worker Factory ───────────────────────────────────────────────────

export function createBounceRateMonitorWorker(
  redisUrl: string,
): Worker<JobEnvelope<BounceRateMonitorJobPayload>> {
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<JobEnvelope<BounceRateMonitorJobPayload>>(
    QUEUE_NAME,
    async (job) => {
      try {
        await processBounceRateMonitorJob(job);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        log.error(
          {
            jobId: job.data.id,
            error: errorMessage,
          },
          'Bounce rate monitor job failed with exception',
        );

        throw err;
      }
    },
    {
      connection,
      prefix: 'arda',
      concurrency: 1, // serial — one check at a time
      lockDuration: 300_000, // 5 min — aggregation queries can be slow
    },
  );

  worker.on('completed', (job) => {
    log.info(
      { jobId: job.data.id },
      'Bounce rate monitor job completed',
    );
  });

  worker.on('failed', (job, err) => {
    if (!job) return;

    log.error(
      {
        jobId: job.data.id,
        error: err.message,
      },
      'Bounce rate monitor job failed',
    );
  });

  log.info({ worker: QUEUE_NAME }, 'Bounce rate monitor worker started');

  return worker;
}

// ─── Schedule ─────────────────────────────────────────────────────────

/**
 * Schedule a repeatable bounce rate monitor job with the configured cron.
 */
export async function scheduleBounceRateMonitorJob(
  queue: Queue<JobEnvelope<BounceRateMonitorJobPayload>>,
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
  const envelope = buildJobEnvelope<BounceRateMonitorJobPayload>(
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

  log.info({ cronSchedule }, 'Bounce rate monitor job scheduled');
}
