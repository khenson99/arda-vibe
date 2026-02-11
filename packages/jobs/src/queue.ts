/**
 * @arda/jobs — Queue and Worker factory functions
 *
 * Wraps BullMQ with Arda conventions: tenant-aware job envelopes,
 * sensible retry defaults, and structured logging.
 */

import { Queue, Worker, type Processor } from 'bullmq';
import type { CreateQueueOptions, CreateWorkerOptions, JobEnvelope } from './types.js';

/** Default Redis URL when not provided */
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/** Single-node Redis connection options returned by parseRedisUrl. */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  password: string | undefined;
  username: string | undefined;
  db: number;
}

/**
 * Parse a Redis URL into single-node Redis connection options.
 */
export function parseRedisUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    username: parsed.username || undefined,
    db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
  };
}

/**
 * Queue name prefix for all Arda queues.
 */
const QUEUE_PREFIX = 'arda';

/**
 * Create a BullMQ queue with Arda conventions.
 *
 * @param name - Queue name (e.g. "orders", "notifications", "emails")
 * @param opts - Optional queue configuration
 * @returns A configured BullMQ Queue instance
 *
 * @example
 * ```ts
 * const orderQueue = createQueue('orders');
 * await orderQueue.add('order.created', envelope);
 * ```
 */
export function createQueue<T = unknown>(
  name: string,
  opts?: CreateQueueOptions,
): Queue<JobEnvelope<T>> {
  const redisUrl = opts?.redisUrl ?? DEFAULT_REDIS_URL;
  const connection = parseRedisUrl(redisUrl);

  return new Queue<JobEnvelope<T>>(name, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: opts?.defaultJobOptions?.attempts ?? 3,
      backoff: opts?.defaultJobOptions?.backoff ?? {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: opts?.defaultJobOptions?.removeOnComplete ?? 1000,
      removeOnFail: opts?.defaultJobOptions?.removeOnFail ?? 5000,
    },
  });
}

/**
 * Create a BullMQ worker with Arda conventions.
 *
 * @param name - Queue name to process (must match a queue created with createQueue)
 * @param processor - Job processing function
 * @param opts - Optional worker configuration
 * @returns A configured BullMQ Worker instance
 *
 * @example
 * ```ts
 * const worker = createWorker('orders', async (job) => {
 *   const envelope = job.data;
 *   console.log(`Processing ${envelope.type} for tenant ${envelope.tenantId}`);
 * });
 * ```
 */
export function createWorker<T = unknown>(
  name: string,
  processor: Processor<JobEnvelope<T>>,
  opts?: CreateWorkerOptions,
): Worker<JobEnvelope<T>> {
  const redisUrl = opts?.redisUrl ?? DEFAULT_REDIS_URL;
  const connection = parseRedisUrl(redisUrl);

  return new Worker<JobEnvelope<T>>(name, processor, {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency: opts?.concurrency ?? 5,
    lockDuration: opts?.lockDuration ?? 30_000,
    stalledInterval: opts?.stalledInterval ?? 30_000,
  });
}

/**
 * Build a JobEnvelope for submitting to a queue.
 *
 * @param type - Job type name
 * @param tenantId - Tenant ID
 * @param payload - Job payload data
 * @param maxRetries - Maximum retries (default: 3)
 * @returns A well-formed JobEnvelope
 */
export function buildJobEnvelope<T>(
  type: string,
  tenantId: string,
  payload: T,
  maxRetries = 3,
): JobEnvelope<T> {
  return {
    id: crypto.randomUUID(),
    type,
    tenantId,
    payload,
    attempts: 1,
    maxRetries,
    createdAt: new Date().toISOString(),
  };
}
