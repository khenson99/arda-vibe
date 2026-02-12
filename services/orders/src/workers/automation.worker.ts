/**
 * Automation Worker
 *
 * BullMQ worker that processes TCAAF automation pipeline jobs.
 * Each job contains an AutomationJobPayload which is passed
 * directly to the AutomationOrchestrator.
 *
 * Features:
 *   - 3 retries with exponential backoff (5s base)
 *   - Dead letter queue for permanently failed jobs
 *   - Concurrency of 5 (automation actions are mostly I/O)
 *   - Idempotency handled by the orchestrator layer
 *
 * Schedule: On-demand (event-driven, not cron)
 * Concurrency: 5
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
import { config } from '@arda/config';
import { AutomationOrchestrator } from '../services/automation/index.js';
import type { AutomationJobPayload, ActionExecutionResult } from '../services/automation/index.js';

// ─── Payload Type ──────────────────────────────────────────────────

export type AutomationWorkerPayload = AutomationJobPayload;

// ─── Constants ─────────────────────────────────────────────────────

const QUEUE_NAME = 'orders:automation';
const JOB_TYPE = 'orders.automation_pipeline';

// ─── Queue Factory ─────────────────────────────────────────────────

export function createAutomationQueue(
  redisUrl: string,
): Queue<JobEnvelope<AutomationWorkerPayload>> {
  return createQueue<AutomationWorkerPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
}

// ─── Processor ─────────────────────────────────────────────────────

async function processAutomationJob(
  job: Job<JobEnvelope<AutomationWorkerPayload>>,
  orchestrator: AutomationOrchestrator,
): Promise<ActionExecutionResult> {
  const { tenantId, payload } = job.data;

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      actionType: payload.actionType,
      ruleId: payload.ruleId,
      idempotencyKey: payload.idempotencyKey,
      msg: 'Processing automation job',
    }),
  );

  const result = await orchestrator.executePipeline(payload);

  console.log(
    JSON.stringify({
      level: result.success ? 'info' : 'warn',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      actionType: payload.actionType,
      success: result.success,
      wasReplay: result.wasReplay,
      durationMs: result.durationMs,
      error: result.error,
      msg: result.success
        ? 'Automation job completed'
        : 'Automation job completed with failure',
    }),
  );

  // If the orchestrator reports failure but it's not an exception
  // (e.g., denied by rule, guardrail violation), we don't throw —
  // BullMQ treats the job as completed. Only unexpected errors
  // from executePipeline throw and trigger retries.
  return result;
}

// ─── Worker Factory ────────────────────────────────────────────────

export function startAutomationWorker(redisUrl: string): {
  worker: Worker<JobEnvelope<AutomationWorkerPayload>>;
  queue: Queue<JobEnvelope<AutomationWorkerPayload>>;
  orchestrator: AutomationOrchestrator;
} {
  const queue = createAutomationQueue(redisUrl);
  const dlq = createDLQ(QUEUE_NAME, redisUrl);
  const orchestrator = new AutomationOrchestrator(redisUrl);

  const worker = createWorker<AutomationWorkerPayload>(
    QUEUE_NAME,
    async (job) => {
      try {
        await processAutomationJob(job, orchestrator);
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'error',
            worker: QUEUE_NAME,
            jobId: job.data.id,
            tenantId: job.data.tenantId,
            actionType: job.data.payload.actionType,
            error: err instanceof Error ? err.message : String(err),
            attempt: job.attemptsMade,
            msg: 'Automation job failed with exception',
          }),
        );
        throw err;
      }
    },
    { redisUrl, concurrency: 10 },
  );

  worker.on('completed', (job) => {
    console.log(
      JSON.stringify({
        level: 'info',
        worker: QUEUE_NAME,
        jobId: job.data.id,
        tenantId: job.data.tenantId,
        actionType: job.data.payload.actionType,
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
        actionType: job.data.payload.actionType,
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
          tenantId: job.data.tenantId,
          actionType: job.data.payload.actionType,
          msg: 'Job moved to dead letter queue',
        }),
      );
    }
  });

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      msg: 'Automation worker started',
    }),
  );

  return { worker, queue, orchestrator };
}

// ─── Convenience: Enqueue an automation job ────────────────────────

export function enqueueAutomationJob(
  queue: Queue<JobEnvelope<AutomationWorkerPayload>>,
  tenantId: string,
  payload: AutomationJobPayload,
) {
  const envelope = buildJobEnvelope<AutomationWorkerPayload>(
    JOB_TYPE,
    tenantId,
    payload,
  );

  return queue.add(JOB_TYPE, envelope, {
    jobId: `automation:${payload.idempotencyKey}`,
  });
}
