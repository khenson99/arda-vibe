/**
 * @arda/jobs — BullMQ queue framework
 *
 * Provides queue creation, worker management, dead letter queues,
 * and health monitoring for background job processing.
 */

// Queue and worker factories
export { createQueue, createWorker, buildJobEnvelope, parseRedisUrl } from './queue.js';
export type { RedisConnectionOptions } from './queue.js';

// Dead letter queue
export { createDLQ, moveToDeadLetterQueue, listDLQEntries, replayFromDLQ } from './dlq.js';

// Health checks
export { getQueueHealth, getAggregatedHealth, healthCheckHandler } from './health.js';

// Types
export type {
  JobEnvelope,
  CreateQueueOptions,
  CreateWorkerOptions,
  DLQEntry,
  QueueHealthStatus,
} from './types.js';
