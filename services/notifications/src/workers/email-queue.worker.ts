/**
 * Email Queue Worker
 *
 * BullMQ worker that processes email delivery jobs with:
 *   - Custom exponential backoff with jitter (60s +/-15s, 300s +/-60s)
 *   - Max 3 attempts before moving to DLQ
 *   - Delivery record lifecycle updates on each attempt
 *   - Dead letter queue for permanently failed jobs
 *
 * Schedule: On-demand (event-driven, not cron)
 * Concurrency: 5
 */

import { Worker } from 'bullmq';
import type { Job, Queue } from 'bullmq';
import {
  createQueue,
  buildJobEnvelope,
  createDLQ,
  moveToDeadLetterQueue,
  parseRedisUrl,
} from '@arda/jobs';
import type { JobEnvelope, DLQEntry } from '@arda/jobs';
import { createLogger } from '@arda/config';
import { db, schema } from '@arda/db';
import { eq } from 'drizzle-orm';
import { createEmailProvider } from '../services/email-provider.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface EmailJobPayload {
  deliveryId: string;
  notificationId: string;
  tenantId: string;
  userId: string;
  to: string;
  subject: string;
  html: string;
  from?: string;
  headers?: Record<string, string>;
}

// ─── Constants ────────────────────────────────────────────────────────

export const QUEUE_NAME = 'notifications:email';
const JOB_TYPE = 'notifications.email_send';
const MAX_ATTEMPTS = 3;

const log = createLogger('email-queue-worker');

// ─── Jitter Backoff ───────────────────────────────────────────────────

/**
 * Backoff schedule with jitter:
 *   Attempt 1 -> 2: 60s +/- 15s  (45,000ms - 75,000ms)
 *   Attempt 2 -> 3: 300s +/- 60s (240,000ms - 360,000ms)
 */
const BACKOFF_SCHEDULE = [
  { base: 60_000, jitter: 15_000 },   // attempt 1 delay
  { base: 300_000, jitter: 60_000 },   // attempt 2 delay
] as const;

/**
 * Calculate backoff delay with jitter for a given attempt number.
 * Returns the delay in milliseconds.
 */
export function calculateBackoffDelay(attemptsMade: number): number {
  const index = Math.min(attemptsMade - 1, BACKOFF_SCHEDULE.length - 1);
  const { base, jitter } = BACKOFF_SCHEDULE[index];
  // Random jitter in range [-jitter, +jitter]
  const offset = Math.floor(Math.random() * (2 * jitter + 1)) - jitter;
  return base + offset;
}

// ─── Queue Factory ────────────────────────────────────────────────────

export function createEmailQueue(
  redisUrl: string,
): Queue<JobEnvelope<EmailJobPayload>> {
  return createQueue<EmailJobPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
}

// ─── Delivery Record Helpers ──────────────────────────────────────────

async function markAttemptStarted(deliveryId: string, attemptCount: number): Promise<void> {
  await db
    .update(schema.notificationDeliveries)
    .set({
      attemptCount,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.notificationDeliveries.id, deliveryId));
}

async function markDelivered(
  deliveryId: string,
  provider: string,
  providerMessageId: string,
): Promise<void> {
  await db
    .update(schema.notificationDeliveries)
    .set({
      status: 'delivered',
      provider,
      providerMessageId,
      deliveredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.notificationDeliveries.id, deliveryId));
}

async function markAttemptFailed(deliveryId: string, error: string): Promise<void> {
  await db
    .update(schema.notificationDeliveries)
    .set({
      lastError: error,
      updatedAt: new Date(),
    })
    .where(eq(schema.notificationDeliveries.id, deliveryId));
}

async function markPermanentlyFailed(deliveryId: string, error: string): Promise<void> {
  await db
    .update(schema.notificationDeliveries)
    .set({
      status: 'failed',
      lastError: error,
      updatedAt: new Date(),
    })
    .where(eq(schema.notificationDeliveries.id, deliveryId));
}

// ─── Processor ────────────────────────────────────────────────────────

async function processEmailJob(
  job: Job<JobEnvelope<EmailJobPayload>>,
): Promise<void> {
  const { payload, tenantId } = job.data;
  const { deliveryId, to, subject, html, from, headers } = payload;
  const attemptNumber = job.attemptsMade + 1;

  log.info(
    {
      jobId: job.data.id,
      deliveryId,
      tenantId,
      to,
      attempt: attemptNumber,
      maxAttempts: MAX_ATTEMPTS,
    },
    'Processing email job',
  );

  // 1. Mark attempt started
  await markAttemptStarted(deliveryId, attemptNumber);

  // 2. Send the email
  const provider = createEmailProvider();
  const result = await provider.send({ to, subject, html, from, headers });

  // 3. Mark as delivered
  await markDelivered(deliveryId, result.provider, result.messageId);

  log.info(
    {
      jobId: job.data.id,
      deliveryId,
      tenantId,
      provider: result.provider,
      messageId: result.messageId,
    },
    'Email delivered successfully',
  );
}

// ─── Worker Factory ───────────────────────────────────────────────────

export function createEmailWorker(
  redisUrl: string,
): Worker<JobEnvelope<EmailJobPayload>> {
  const dlq = createDLQ(QUEUE_NAME, redisUrl);
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<JobEnvelope<EmailJobPayload>>(
    QUEUE_NAME,
    async (job) => {
      try {
        await processEmailJob(job);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const { payload, tenantId } = job.data;

        log.error(
          {
            jobId: job.data.id,
            deliveryId: payload.deliveryId,
            tenantId,
            attempt: job.attemptsMade + 1,
            maxAttempts: MAX_ATTEMPTS,
            error: errorMessage,
          },
          'Email job failed with exception',
        );

        // Update delivery record with the error
        await markAttemptFailed(payload.deliveryId, errorMessage);

        throw err;
      }
    },
    {
      connection,
      prefix: 'arda',
      concurrency: 5,
      lockDuration: 30_000,
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          return calculateBackoffDelay(attemptsMade);
        },
      },
    },
  );

  // ─── Event Handlers ───────────────────────────────────────────────

  worker.on('completed', (job) => {
    log.info(
      {
        jobId: job.data.id,
        deliveryId: job.data.payload.deliveryId,
        tenantId: job.data.tenantId,
      },
      'Email job completed',
    );
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;

    log.error(
      {
        jobId: job.data.id,
        deliveryId: job.data.payload.deliveryId,
        tenantId: job.data.tenantId,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        error: err.message,
      },
      'Email job failed',
    );

    // If all attempts exhausted, move to DLQ and mark as permanently failed
    if (job.attemptsMade >= (job.opts.attempts ?? MAX_ATTEMPTS)) {
      await markPermanentlyFailed(job.data.payload.deliveryId, err.message);
      await moveToDeadLetterQueue(dlq, job, err);

      log.warn(
        {
          jobId: job.data.id,
          deliveryId: job.data.payload.deliveryId,
          tenantId: job.data.tenantId,
        },
        'Email job moved to dead letter queue',
      );
    }
  });

  log.info({ worker: QUEUE_NAME }, 'Email queue worker started');

  return worker;
}

// ─── Convenience: Enqueue an email job ────────────────────────────────

export function enqueueEmail(
  queue: Queue<JobEnvelope<EmailJobPayload>>,
  payload: EmailJobPayload,
): Promise<Job<JobEnvelope<EmailJobPayload>>> {
  const envelope = buildJobEnvelope<EmailJobPayload>(
    JOB_TYPE,
    payload.tenantId,
    payload,
    MAX_ATTEMPTS,
  );

  return queue.add(JOB_TYPE, envelope, {
    jobId: `email:${payload.deliveryId}`,
    backoff: { type: 'custom' },
  });
}
