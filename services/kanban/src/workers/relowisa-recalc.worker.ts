/**
 * ReLoWiSa Recalculation Worker
 *
 * Periodically recalculates inventory metrics for kanban loops:
 *   - Re: Reorder point
 *   - Lo: Low-stock threshold
 *   - Wi: Wish-list (suggested order qty)
 *   - Sa: Sales-velocity (consumption rate)
 *
 * Schedule: Daily at 02:00 UTC
 * Concurrency: 2
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
import { eq, and, gte, sql } from 'drizzle-orm';

const {
  kanbanLoops,
  kanbanCards,
  cardStageTransitions,
  reloWisaRecommendations,
} = schema;

// ─── Payload Types ──────────────────────────────────────────────────

export interface ReloWisaRecalcPayload {
  /** Run recalculation for all active loops in this tenant */
  scope: 'tenant';
  /** Number of days of transition history to analyze */
  lookbackDays?: number;
}

interface VelocityMetrics {
  loopId: string;
  avgCycleDays: number;
  cycleCount: number;
  avgDailyDemand: number;
  recommendedMinQty: number;
  recommendedOrderQty: number;
  recommendedCards: number;
  confidence: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const QUEUE_NAME = 'kanban:relowisa-recalc';
const JOB_TYPE = 'kanban.relowisa_recalc';
const DEFAULT_LOOKBACK_DAYS = 90;
const MIN_CYCLES_FOR_RECOMMENDATION = 3;

// ─── Queue Factory ──────────────────────────────────────────────────

export function createReloWisaRecalcQueue(redisUrl: string): Queue<JobEnvelope<ReloWisaRecalcPayload>> {
  return createQueue<ReloWisaRecalcPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
}

// ─── Processor ──────────────────────────────────────────────────────

async function calculateLoopVelocity(
  tenantId: string,
  loopId: string,
  lookbackDays: number,
): Promise<VelocityMetrics | null> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

  // Get completed cycle transitions (restocked -> created/triggered)
  // We measure full cycle time from 'triggered' to 'restocked'
  const transitions = await db
    .select({
      cycleNumber: cardStageTransitions.cycleNumber,
      toStage: cardStageTransitions.toStage,
      transitionedAt: cardStageTransitions.transitionedAt,
    })
    .from(cardStageTransitions)
    .where(
      and(
        eq(cardStageTransitions.tenantId, tenantId),
        eq(cardStageTransitions.loopId, loopId),
        gte(cardStageTransitions.transitionedAt, cutoffDate),
      ),
    )
    .orderBy(cardStageTransitions.cycleNumber, cardStageTransitions.transitionedAt);

  if (transitions.length < 2) return null;

  // Group by cycle and compute cycle durations
  const cycleMap = new Map<number, { triggered?: Date; restocked?: Date }>();
  for (const t of transitions) {
    const cycle = cycleMap.get(t.cycleNumber) ?? {};
    if (t.toStage === 'triggered' && !cycle.triggered) {
      cycle.triggered = t.transitionedAt;
    }
    if (t.toStage === 'restocked') {
      cycle.restocked = t.transitionedAt;
    }
    cycleMap.set(t.cycleNumber, cycle);
  }

  const cycleDurations: number[] = [];
  for (const cycle of cycleMap.values()) {
    if (cycle.triggered && cycle.restocked) {
      const durationMs = cycle.restocked.getTime() - cycle.triggered.getTime();
      const durationDays = durationMs / (1000 * 60 * 60 * 24);
      if (durationDays > 0) cycleDurations.push(durationDays);
    }
  }

  if (cycleDurations.length < MIN_CYCLES_FOR_RECOMMENDATION) return null;

  // Get current loop parameters
  const [loop] = await db
    .select()
    .from(kanbanLoops)
    .where(and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)))
    .limit(1);

  if (!loop) return null;

  const avgCycleDays = cycleDurations.reduce((a, b) => a + b, 0) / cycleDurations.length;
  const avgDailyDemand = loop.orderQuantity / avgCycleDays;

  // Lead time factor: use stated lead time or estimate from cycle data
  const leadTimeDays = loop.statedLeadTimeDays ?? Math.ceil(avgCycleDays * 0.6);
  const safetyFactor = Number(loop.safetyStockDays) || 2;

  // Recommended parameters
  const recommendedMinQty = Math.ceil(avgDailyDemand * (leadTimeDays + safetyFactor));
  const recommendedOrderQty = Math.ceil(avgDailyDemand * avgCycleDays);
  const recommendedCards = Math.max(1, Math.ceil(recommendedMinQty / recommendedOrderQty) + 1);

  // Confidence: higher with more data points, capped at 95
  const confidence = Math.min(95, 50 + cycleDurations.length * 5);

  return {
    loopId,
    avgCycleDays,
    cycleCount: cycleDurations.length,
    avgDailyDemand,
    recommendedMinQty,
    recommendedOrderQty,
    recommendedCards,
    confidence,
  };
}

async function processReloWisaRecalc(
  job: Job<JobEnvelope<ReloWisaRecalcPayload>>,
): Promise<void> {
  const { tenantId, payload } = job.data;
  const lookbackDays = payload.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      lookbackDays,
      msg: 'Starting ReLoWiSa recalculation',
    }),
  );

  // Fetch all active loops for the tenant
  const activeLoops = await db
    .select({ id: kanbanLoops.id })
    .from(kanbanLoops)
    .where(and(eq(kanbanLoops.tenantId, tenantId), eq(kanbanLoops.isActive, true)));

  let processedCount = 0;
  let recommendationCount = 0;
  const errors: Array<{ loopId: string; error: string }> = [];

  for (const loop of activeLoops) {
    try {
      const metrics = await calculateLoopVelocity(tenantId, loop.id, lookbackDays);

      if (metrics) {
        // Insert recommendation for human review
        await db.insert(reloWisaRecommendations).values({
          tenantId,
          loopId: loop.id,
          status: 'pending',
          recommendedMinQuantity: metrics.recommendedMinQty,
          recommendedOrderQuantity: metrics.recommendedOrderQty,
          recommendedNumberOfCards: metrics.recommendedCards,
          confidenceScore: metrics.confidence.toFixed(2),
          reasoning: `Based on ${metrics.cycleCount} cycles over ${lookbackDays} days. ` +
            `Avg cycle: ${metrics.avgCycleDays.toFixed(1)}d, ` +
            `Daily demand: ${metrics.avgDailyDemand.toFixed(2)} units/day.`,
          dataPointsUsed: metrics.cycleCount,
          projectedImpact: {
            estimatedTurnImprovement: metrics.avgCycleDays > 0
              ? Number(((365 / metrics.avgCycleDays) * 0.05).toFixed(2))
              : undefined,
          },
        });
        recommendationCount++;
      }

      processedCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ loopId: loop.id, error: message });
      console.log(
        JSON.stringify({
          level: 'warn',
          worker: QUEUE_NAME,
          jobId: job.data.id,
          tenantId,
          loopId: loop.id,
          error: message,
          msg: 'Failed to recalculate loop',
        }),
      );
    }
  }

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      totalLoops: activeLoops.length,
      processedCount,
      recommendationCount,
      errorCount: errors.length,
      msg: 'ReLoWiSa recalculation complete',
    }),
  );

  // If more than half of loops failed, consider the job partially failed
  if (errors.length > activeLoops.length / 2) {
    throw new Error(
      `ReLoWiSa recalculation had too many failures: ${errors.length}/${activeLoops.length} loops failed`,
    );
  }
}

// ─── Worker Startup ─────────────────────────────────────────────────

export function startReloWisaRecalcWorker(redisUrl: string): {
  worker: Worker<JobEnvelope<ReloWisaRecalcPayload>>;
  queue: Queue<JobEnvelope<ReloWisaRecalcPayload>>;
} {
  const queue = createReloWisaRecalcQueue(redisUrl);
  const dlq = createDLQ(QUEUE_NAME, redisUrl);

  const worker = createWorker<ReloWisaRecalcPayload>(
    QUEUE_NAME,
    async (job) => {
      try {
        await processReloWisaRecalc(job);
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'error',
            worker: QUEUE_NAME,
            jobId: job.data.id,
            tenantId: job.data.tenantId,
            error: err instanceof Error ? err.message : String(err),
            attempt: job.attemptsMade,
            msg: 'ReLoWiSa recalculation failed',
          }),
        );
        throw err;
      }
    },
    { redisUrl, concurrency: 2 },
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

    // Move to DLQ after exhausting retries
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

  // Set up the repeatable schedule: daily at 02:00 UTC
  // Note: The actual tenant-specific jobs are enqueued by a scheduler
  // that iterates tenants and calls buildJobEnvelope for each.
  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      msg: 'ReLoWiSa recalculation worker started',
    }),
  );

  return { worker, queue };
}

// ─── Convenience: Enqueue a recalc job for a specific tenant ────────

export function enqueueReloWisaRecalc(
  queue: Queue<JobEnvelope<ReloWisaRecalcPayload>>,
  tenantId: string,
  lookbackDays?: number,
) {
  const envelope = buildJobEnvelope<ReloWisaRecalcPayload>(
    JOB_TYPE,
    tenantId,
    { scope: 'tenant', lookbackDays },
  );

  return queue.add(JOB_TYPE, envelope, {
    jobId: `relowisa:${tenantId}:${new Date().toISOString().slice(0, 10)}`,
  });
}
