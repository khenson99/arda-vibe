/**
 * Kanban Workers — Barrel Export
 *
 * Initializes and manages all background job workers for the kanban service.
 */

import type { Queue, Worker } from 'bullmq';
import type { JobEnvelope } from '@arda/jobs';

import {
  startReloWisaRecalcWorker,
  createReloWisaRecalcQueue,
  enqueueReloWisaRecalc,
} from './relowisa-recalc.worker.js';
import type { ReloWisaRecalcPayload } from './relowisa-recalc.worker.js';

import {
  startStaleCardCleanupWorker,
  createStaleCardCleanupQueue,
  enqueueStaleCardCleanup,
} from './stale-card-cleanup.worker.js';
import type { StaleCardCleanupPayload } from './stale-card-cleanup.worker.js';

// ─── Re-exports ─────────────────────────────────────────────────────

export {
  // ReLoWiSa
  startReloWisaRecalcWorker,
  createReloWisaRecalcQueue,
  enqueueReloWisaRecalc,
  // Stale card cleanup
  startStaleCardCleanupWorker,
  createStaleCardCleanupQueue,
  enqueueStaleCardCleanup,
};

export type { ReloWisaRecalcPayload, StaleCardCleanupPayload };

// ─── Combined Startup ───────────────────────────────────────────────

export interface KanbanWorkerInstances {
  reloWisaRecalc: {
    worker: Worker<JobEnvelope<ReloWisaRecalcPayload>>;
    queue: Queue<JobEnvelope<ReloWisaRecalcPayload>>;
  };
  staleCardCleanup: {
    worker: Worker<JobEnvelope<StaleCardCleanupPayload>>;
    queue: Queue<JobEnvelope<StaleCardCleanupPayload>>;
  };
}

/**
 * Initialize all kanban background workers.
 *
 * Call this from the service entrypoint after the HTTP server starts.
 * Returns handles to all worker/queue pairs for health checks and
 * graceful shutdown.
 *
 * @param redisUrl - Redis connection URL
 * @returns Worker and queue instances for all kanban workers
 */
export function startKanbanWorkers(redisUrl: string): KanbanWorkerInstances {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'kanban',
      msg: 'Starting kanban background workers',
    }),
  );

  const reloWisaRecalc = startReloWisaRecalcWorker(redisUrl);
  const staleCardCleanup = startStaleCardCleanupWorker(redisUrl);

  console.log(
    JSON.stringify({
      level: 'info',
      service: 'kanban',
      workers: ['relowisa-recalc', 'stale-card-cleanup'],
      msg: 'All kanban workers started',
    }),
  );

  return { reloWisaRecalc, staleCardCleanup };
}

/**
 * Gracefully shut down all kanban workers.
 *
 * Closes workers first (stops processing), then closes queues (disconnects from Redis).
 *
 * @param instances - Worker instances returned by startKanbanWorkers
 */
export async function stopKanbanWorkers(instances: KanbanWorkerInstances): Promise<void> {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'kanban',
      msg: 'Shutting down kanban workers',
    }),
  );

  await Promise.allSettled([
    instances.reloWisaRecalc.worker.close(),
    instances.staleCardCleanup.worker.close(),
  ]);

  await Promise.allSettled([
    instances.reloWisaRecalc.queue.close(),
    instances.staleCardCleanup.queue.close(),
  ]);

  console.log(
    JSON.stringify({
      level: 'info',
      service: 'kanban',
      msg: 'All kanban workers stopped',
    }),
  );
}
