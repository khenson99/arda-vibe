/**
 * Stale Card Cleanup Worker
 *
 * Finds kanban cards that haven't had any stage transitions in 90+ days
 * and archives them by setting isActive = false. Cards stuck in
 * non-terminal stages (created, triggered, ordered, in_transit) are
 * the primary targets — cards in 'restocked' are normal idle state.
 *
 * Schedule: Daily at 03:00 UTC
 * Concurrency: 1
 */

import type { Job, Queue, Worker } from 'bullmq';
import {
  createQueue,
  createWorker,
  buildJobEnvelope,
  createDLQ,
  moveToDeadLetterQueue,
} from '@arda/jobs';
import type { JobEnvelope } from '@arda/jobs';
import { db, schema } from '@arda/db';
import { eq, and, lt, inArray } from 'drizzle-orm';

const { kanbanCards, cardStageTransitions } = schema;

// ─── Payload Types ──────────────────────────────────────────────────

export interface StaleCardCleanupPayload {
  /** Number of days without activity before a card is considered stale */
  staleDays?: number;
  /** If true, only report stale cards without archiving */
  dryRun?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────

const QUEUE_NAME = 'kanban:stale-card-cleanup';
const JOB_TYPE = 'kanban.stale_card_cleanup';
const DEFAULT_STALE_DAYS = 90;

/** Terminal stages where cards are expected to sit idle */
const TERMINAL_STAGES = ['restocked'] as const;

/** Stages where being stale is a problem */
const STALE_CONCERN_STAGES = ['created', 'triggered', 'ordered', 'in_transit', 'received'] as const;

// ─── Queue Factory ──────────────────────────────────────────────────

export function createStaleCardCleanupQueue(redisUrl: string): Queue<JobEnvelope<StaleCardCleanupPayload>> {
  return createQueue<StaleCardCleanupPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 50,
      removeOnFail: 200,
    },
  });
}

// ─── Processor ──────────────────────────────────────────────────────

async function processStaleCardCleanup(
  job: Job<JobEnvelope<StaleCardCleanupPayload>>,
): Promise<void> {
  const { tenantId, payload } = job.data;
  const staleDays = payload.staleDays ?? DEFAULT_STALE_DAYS;
  const dryRun = payload.dryRun ?? false;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - staleDays);

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      staleDays,
      dryRun,
      cutoffDate: cutoffDate.toISOString(),
      msg: 'Starting stale card cleanup',
    }),
  );

  // Find active cards that are in concerning stages and whose
  // currentStageEnteredAt is older than the cutoff
  const staleCandidates = await db
    .select({
      id: kanbanCards.id,
      currentStage: kanbanCards.currentStage,
      currentStageEnteredAt: kanbanCards.currentStageEnteredAt,
      loopId: kanbanCards.loopId,
    })
    .from(kanbanCards)
    .where(
      and(
        eq(kanbanCards.tenantId, tenantId),
        eq(kanbanCards.isActive, true),
        lt(kanbanCards.currentStageEnteredAt, cutoffDate),
        // Only target cards stuck in non-terminal stages
        inArray(kanbanCards.currentStage, [...STALE_CONCERN_STAGES]),
      ),
    );

  if (staleCandidates.length === 0) {
    console.log(
      JSON.stringify({
        level: 'info',
        worker: QUEUE_NAME,
        jobId: job.data.id,
        tenantId,
        msg: 'No stale cards found',
      }),
    );
    return;
  }

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      staleCardCount: staleCandidates.length,
      byStage: staleCandidates.reduce(
        (acc, c) => {
          acc[c.currentStage] = (acc[c.currentStage] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
      msg: dryRun ? 'Stale cards found (dry run, no changes)' : 'Archiving stale cards',
    }),
  );

  if (dryRun) return;

  // Archive in batches of 50 to avoid locking too many rows
  const BATCH_SIZE = 50;
  let archivedCount = 0;

  for (let i = 0; i < staleCandidates.length; i += BATCH_SIZE) {
    const batch = staleCandidates.slice(i, i + BATCH_SIZE);
    const batchIds = batch.map((c) => c.id);

    await db
      .update(kanbanCards)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(kanbanCards.tenantId, tenantId),
          inArray(kanbanCards.id, batchIds),
        ),
      );

    // Record a transition for audit purposes
    const transitionValues = batch.map((card) => ({
      tenantId,
      cardId: card.id,
      loopId: card.loopId,
      cycleNumber: 0, // cleanup transition, not a real cycle
      fromStage: card.currentStage,
      toStage: 'created' as const, // reset stage
      method: 'system',
      notes: `Archived by stale-card-cleanup worker after ${staleDays} days of inactivity`,
      metadata: { archivedAt: new Date().toISOString(), previousStage: card.currentStage },
    }));

    if (transitionValues.length > 0) {
      await db.insert(cardStageTransitions).values(transitionValues);
    }

    archivedCount += batch.length;
  }

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      archivedCount,
      msg: 'Stale card cleanup complete',
    }),
  );
}

// ─── Worker Startup ─────────────────────────────────────────────────

export function startStaleCardCleanupWorker(redisUrl: string): {
  worker: Worker<JobEnvelope<StaleCardCleanupPayload>>;
  queue: Queue<JobEnvelope<StaleCardCleanupPayload>>;
} {
  const queue = createStaleCardCleanupQueue(redisUrl);
  const dlq = createDLQ(QUEUE_NAME, redisUrl);

  const worker = createWorker<StaleCardCleanupPayload>(
    QUEUE_NAME,
    async (job) => {
      try {
        await processStaleCardCleanup(job);
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'error',
            worker: QUEUE_NAME,
            jobId: job.data.id,
            tenantId: job.data.tenantId,
            error: err instanceof Error ? err.message : String(err),
            attempt: job.attemptsMade,
            msg: 'Stale card cleanup failed',
          }),
        );
        throw err;
      }
    },
    { redisUrl, concurrency: 1 },
  );

  worker.on('completed', (job) => {
    console.log(
      JSON.stringify({
        level: 'info',
        worker: QUEUE_NAME,
        jobId: job.data.id,
        tenantId: job.data.tenantId,
        msg: 'Job completed',
      }),
    );
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    console.log(
      JSON.stringify({
        level: 'error',
        worker: QUEUE_NAME,
        jobId: job.data.id,
        tenantId: job.data.tenantId,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        error: err.message,
        msg: 'Job failed',
      }),
    );

    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      await moveToDeadLetterQueue(dlq, job, err);
      console.log(
        JSON.stringify({
          level: 'warn',
          worker: QUEUE_NAME,
          jobId: job.data.id,
          msg: 'Job moved to dead letter queue',
        }),
      );
    }
  });

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      msg: 'Stale card cleanup worker started',
    }),
  );

  return { worker, queue };
}

// ─── Convenience: Enqueue a cleanup job for a specific tenant ───────

export function enqueueStaleCardCleanup(
  queue: Queue<JobEnvelope<StaleCardCleanupPayload>>,
  tenantId: string,
  options?: { staleDays?: number; dryRun?: boolean },
) {
  const envelope = buildJobEnvelope<StaleCardCleanupPayload>(
    JOB_TYPE,
    tenantId,
    { staleDays: options?.staleDays, dryRun: options?.dryRun },
  );

  return queue.add(JOB_TYPE, envelope, {
    jobId: `stale-cleanup:${tenantId}:${new Date().toISOString().slice(0, 10)}`,
  });
}
