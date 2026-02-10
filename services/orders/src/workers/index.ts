/**
 * Orders Workers — Barrel Export
 *
 * Initializes and manages all background job workers for the orders service.
 */

import type { Queue, Worker } from 'bullmq';
import type { JobEnvelope } from '@arda/jobs';

import {
  startOrderAgingWorker,
  createOrderAgingQueue,
  enqueueOrderAgingCheck,
} from './order-aging.worker.js';
import type { OrderAgingPayload } from './order-aging.worker.js';

import {
  startDataExportWorker,
  createDataExportQueue,
  enqueueDataExport,
} from './data-export.worker.js';
import type {
  DataExportPayload,
  DataExportResult,
  ExportFormat,
  ExportOrderType,
} from './data-export.worker.js';

// ─── Re-exports ─────────────────────────────────────────────────────

export {
  // Order aging
  startOrderAgingWorker,
  createOrderAgingQueue,
  enqueueOrderAgingCheck,
  // Data export
  startDataExportWorker,
  createDataExportQueue,
  enqueueDataExport,
};

export type {
  OrderAgingPayload,
  DataExportPayload,
  DataExportResult,
  ExportFormat,
  ExportOrderType,
};

// ─── Combined Startup ───────────────────────────────────────────────

export interface OrderWorkerInstances {
  orderAging: {
    worker: Worker<JobEnvelope<OrderAgingPayload>>;
    queue: Queue<JobEnvelope<OrderAgingPayload>>;
  };
  dataExport: {
    worker: Worker<JobEnvelope<DataExportPayload>>;
    queue: Queue<JobEnvelope<DataExportPayload>>;
  };
}

/**
 * Initialize all orders background workers.
 *
 * Call this from the service entrypoint after the HTTP server starts.
 * Returns handles to all worker/queue pairs for health checks and
 * graceful shutdown.
 *
 * @param redisUrl - Redis connection URL
 * @returns Worker and queue instances for all orders workers
 */
export function startOrderWorkers(redisUrl: string): OrderWorkerInstances {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'orders',
      msg: 'Starting orders background workers',
    }),
  );

  const orderAging = startOrderAgingWorker(redisUrl);
  const dataExport = startDataExportWorker(redisUrl);

  console.log(
    JSON.stringify({
      level: 'info',
      service: 'orders',
      workers: ['order-aging', 'data-export'],
      msg: 'All orders workers started',
    }),
  );

  return { orderAging, dataExport };
}

/**
 * Gracefully shut down all orders workers.
 *
 * Closes workers first (stops processing), then closes queues (disconnects from Redis).
 *
 * @param instances - Worker instances returned by startOrderWorkers
 */
export async function stopOrderWorkers(instances: OrderWorkerInstances): Promise<void> {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'orders',
      msg: 'Shutting down orders workers',
    }),
  );

  await Promise.allSettled([
    instances.orderAging.worker.close(),
    instances.dataExport.worker.close(),
  ]);

  await Promise.allSettled([
    instances.orderAging.queue.close(),
    instances.dataExport.queue.close(),
  ]);

  console.log(
    JSON.stringify({
      level: 'info',
      service: 'orders',
      msg: 'All orders workers stopped',
    }),
  );
}
