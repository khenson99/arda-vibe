/**
 * Resilience / Fault-Injection Tests — Queue & DLQ
 *
 * Ticket #88 — Phase 2: Worker retry & DLQ escalation
 *
 * Validates system behaviour under:
 * - Malformed Redis URLs in parseRedisUrl
 * - Queue/Worker factory configuration defaults and overrides
 * - buildJobEnvelope structure, UUID generation, and edge cases
 * - moveToDeadLetterQueue fault scenarios (dlq.add throws, missing data)
 * - replayFromDLQ fault scenarios (job not found, add throws, remove throws)
 * - listDLQEntries edge cases (empty, getJobs throws)
 * - Full lifecycle: job fails → DLQ → replay → re-queue
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────

const { mockQueueAdd, mockQueueGetJobs, mockQueueGetJob, mockJobRemove } =
  vi.hoisted(() => ({
    mockQueueAdd: vi.fn(),
    mockQueueGetJobs: vi.fn(),
    mockQueueGetJob: vi.fn(),
    mockJobRemove: vi.fn(),
  }));

vi.mock('bullmq', () => {
  class MockQueue {
    name: string;
    opts: Record<string, unknown>;

    constructor(name: string, opts: Record<string, unknown>) {
      this.name = name;
      this.opts = opts;
    }

    add = mockQueueAdd;
    getJobs = mockQueueGetJobs;
    getJob = mockQueueGetJob;
  }

  class MockWorker {
    name: string;
    processor: unknown;
    opts: Record<string, unknown>;

    constructor(
      name: string,
      processor: unknown,
      opts: Record<string, unknown>,
    ) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
    }
  }

  return { Queue: MockQueue, Worker: MockWorker };
});

import {
  parseRedisUrl,
  createQueue,
  createWorker,
  buildJobEnvelope,
} from '../../queue.js';
import {
  createDLQ,
  moveToDeadLetterQueue,
  listDLQEntries,
  replayFromDLQ,
} from '../../dlq.js';
import type { JobEnvelope, DLQEntry } from '../../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function buildEnvelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    id: 'job-001',
    type: 'order.created',
    tenantId: 'tenant-01',
    payload: { orderId: 'po-123' },
    attempts: 1,
    maxRetries: 3,
    createdAt: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildDLQEntry(overrides: Partial<DLQEntry> = {}): DLQEntry {
  return {
    job: buildEnvelope(),
    error: 'Connection refused',
    stack: 'Error: Connection refused\n    at ...',
    failedAt: '2025-06-01T01:00:00.000Z',
    sourceQueue: 'orders',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Queue & DLQ — Resilience / Fault Injection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── 1. parseRedisUrl ───────────────────────────────────────────────

  describe('parseRedisUrl', () => {
    it('parses a standard Redis URL correctly', () => {
      const result = parseRedisUrl('redis://localhost:6379');

      expect(result.host).toBe('localhost');
      expect(result.port).toBe(6379);
      expect(result.password).toBeUndefined();
      expect(result.username).toBeUndefined();
      expect(result.db).toBe(0);
    });

    it('parses URL with auth credentials', () => {
      const result = parseRedisUrl('redis://admin:secret@redis.example.com:6380/2');

      expect(result.host).toBe('redis.example.com');
      expect(result.port).toBe(6380);
      expect(result.password).toBe('secret');
      expect(result.username).toBe('admin');
      expect(result.db).toBe(2);
    });

    it('defaults port to 6379 when omitted', () => {
      const result = parseRedisUrl('redis://localhost');

      expect(result.port).toBe(6379);
    });

    it('defaults db to 0 when pathname is empty', () => {
      const result = parseRedisUrl('redis://localhost:6379');

      expect(result.db).toBe(0);
    });

    it('defaults db to 0 for non-numeric pathname', () => {
      const result = parseRedisUrl('redis://localhost:6379/abc');

      expect(result.db).toBe(0);
    });

    it('throws on completely invalid URL', () => {
      expect(() => parseRedisUrl('not-a-url')).toThrow();
    });

    it('throws on empty string', () => {
      expect(() => parseRedisUrl('')).toThrow();
    });

    it('handles URL-encoded password (preserves raw form from URL parser)', () => {
      const result = parseRedisUrl('redis://:p%40ssw0rd@localhost:6379');

      // new URL().password returns the percent-encoded form
      expect(result.password).toBe('p%40ssw0rd');
    });
  });

  // ── 2. createQueue Defaults & Overrides ────────────────────────────

  describe('createQueue', () => {
    it('creates a queue with default configuration', () => {
      const queue = createQueue('orders');

      expect(queue.name).toBe('orders');
      expect(queue.opts).toMatchObject({
        prefix: 'arda',
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      });
    });

    it('overrides attempts when provided', () => {
      const queue = createQueue('orders', {
        defaultJobOptions: { attempts: 5 },
      });

      expect(queue.opts).toMatchObject({
        defaultJobOptions: expect.objectContaining({ attempts: 5 }),
      });
    });

    it('overrides backoff strategy when provided', () => {
      const queue = createQueue('orders', {
        defaultJobOptions: {
          backoff: { type: 'fixed', delay: 2000 },
        },
      });

      expect(queue.opts).toMatchObject({
        defaultJobOptions: expect.objectContaining({
          backoff: { type: 'fixed', delay: 2000 },
        }),
      });
    });

    it('uses custom Redis URL when provided', () => {
      const queue = createQueue('orders', {
        redisUrl: 'redis://custom-host:6380/3',
      });

      expect(queue.opts).toMatchObject({
        connection: expect.objectContaining({
          host: 'custom-host',
          port: 6380,
          db: 3,
        }),
      });
    });
  });

  // ── 3. createWorker Defaults & Overrides ───────────────────────────

  describe('createWorker', () => {
    const noop = async () => {};

    it('creates a worker with default configuration', () => {
      const worker = createWorker('orders', noop);

      expect(worker.name).toBe('orders');
      expect(worker.opts).toMatchObject({
        prefix: 'arda',
        concurrency: 5,
        lockDuration: 30_000,
        stalledInterval: 30_000,
      });
    });

    it('overrides concurrency when provided', () => {
      const worker = createWorker('orders', noop, { concurrency: 10 });

      expect(worker.opts).toMatchObject({
        concurrency: 10,
      });
    });

    it('overrides lockDuration when provided', () => {
      const worker = createWorker('orders', noop, { lockDuration: 60_000 });

      expect(worker.opts).toMatchObject({
        lockDuration: 60_000,
      });
    });

    it('overrides stalledInterval when provided', () => {
      const worker = createWorker('orders', noop, { stalledInterval: 15_000 });

      expect(worker.opts).toMatchObject({
        stalledInterval: 15_000,
      });
    });

    it('uses custom Redis URL when provided', () => {
      const worker = createWorker('orders', noop, {
        redisUrl: 'redis://worker-host:6381',
      });

      expect(worker.opts).toMatchObject({
        connection: expect.objectContaining({
          host: 'worker-host',
          port: 6381,
        }),
      });
    });
  });

  // ── 4. buildJobEnvelope ────────────────────────────────────────────

  describe('buildJobEnvelope', () => {
    it('returns a well-formed envelope', () => {
      const envelope = buildJobEnvelope('order.created', 'tenant-01', {
        orderId: 'po-1',
      });

      expect(envelope.type).toBe('order.created');
      expect(envelope.tenantId).toBe('tenant-01');
      expect(envelope.payload).toEqual({ orderId: 'po-1' });
      expect(envelope.attempts).toBe(1);
      expect(envelope.maxRetries).toBe(3);
      expect(envelope.id).toBeDefined();
      expect(envelope.createdAt).toBeDefined();
    });

    it('generates unique IDs on consecutive calls', () => {
      const a = buildJobEnvelope('test', 'T1', {});
      const b = buildJobEnvelope('test', 'T1', {});

      expect(a.id).not.toBe(b.id);
    });

    it('defaults maxRetries to 3', () => {
      const envelope = buildJobEnvelope('test', 'T1', {});

      expect(envelope.maxRetries).toBe(3);
    });

    it('accepts custom maxRetries', () => {
      const envelope = buildJobEnvelope('test', 'T1', {}, 10);

      expect(envelope.maxRetries).toBe(10);
    });

    it('produces a valid ISO 8601 createdAt timestamp', () => {
      const envelope = buildJobEnvelope('test', 'T1', {});
      const parsed = new Date(envelope.createdAt);

      expect(parsed.getTime()).not.toBeNaN();
    });

    it('preserves complex payload structures', () => {
      const payload = {
        items: [{ sku: 'A', qty: 5 }, { sku: 'B', qty: 10 }],
        metadata: { priority: 'high' },
      };
      const envelope = buildJobEnvelope('order.created', 'T1', payload);

      expect(envelope.payload).toEqual(payload);
    });
  });

  // ── 5. createDLQ ───────────────────────────────────────────────────

  describe('createDLQ', () => {
    it('creates a DLQ with :dlq suffix', () => {
      const dlq = createDLQ('orders');

      expect(dlq.name).toBe('orders:dlq');
    });

    it('disables removeOnComplete and removeOnFail', () => {
      const dlq = createDLQ('orders');

      expect(dlq.opts).toMatchObject({
        defaultJobOptions: expect.objectContaining({
          removeOnComplete: false,
          removeOnFail: false,
        }),
      });
    });

    it('sets attempts to 1 (no DLQ retries)', () => {
      const dlq = createDLQ('orders');

      expect(dlq.opts).toMatchObject({
        defaultJobOptions: expect.objectContaining({
          attempts: 1,
        }),
      });
    });

    it('uses arda prefix', () => {
      const dlq = createDLQ('orders');

      expect(dlq.opts).toMatchObject({ prefix: 'arda' });
    });

    it('uses custom Redis URL', () => {
      const dlq = createDLQ('orders', 'redis://dlq-host:6382/1');

      expect(dlq.opts).toMatchObject({
        connection: expect.objectContaining({
          host: 'dlq-host',
          port: 6382,
          db: 1,
        }),
      });
    });
  });

  // ── 6. moveToDeadLetterQueue Fault Scenarios ───────────────────────

  describe('moveToDeadLetterQueue', () => {
    it('adds job to DLQ with correct metadata', async () => {
      mockQueueAdd.mockResolvedValueOnce({});

      const dlq = createDLQ('orders');
      const job = {
        data: buildEnvelope(),
        queueName: 'orders',
      } as any;

      await moveToDeadLetterQueue(dlq, job, new Error('DB timeout'));

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [jobName, entry, opts] = mockQueueAdd.mock.calls[0];
      expect(jobName).toBe('dlq:order.created');
      expect(entry.error).toBe('DB timeout');
      expect(entry.sourceQueue).toBe('orders');
      expect(entry.job).toEqual(job.data);
      expect(opts.jobId).toBe('dlq:job-001');
    });

    it('propagates error when dlq.add throws', async () => {
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection lost'));

      const dlq = createDLQ('orders');
      const job = {
        data: buildEnvelope(),
        queueName: 'orders',
      } as any;

      await expect(
        moveToDeadLetterQueue(dlq, job, new Error('original failure')),
      ).rejects.toThrow('Redis connection lost');
    });

    it('captures error stack in DLQ entry', async () => {
      mockQueueAdd.mockResolvedValueOnce({});

      const dlq = createDLQ('orders');
      const err = new Error('Stack test');
      const job = {
        data: buildEnvelope(),
        queueName: 'orders',
      } as any;

      await moveToDeadLetterQueue(dlq, job, err);

      const entry = mockQueueAdd.mock.calls[0][1];
      expect(entry.stack).toContain('Stack test');
    });

    it('records failedAt timestamp', async () => {
      mockQueueAdd.mockResolvedValueOnce({});

      const dlq = createDLQ('orders');
      const job = {
        data: buildEnvelope(),
        queueName: 'orders',
      } as any;

      await moveToDeadLetterQueue(dlq, job, new Error('fail'));

      const entry = mockQueueAdd.mock.calls[0][1];
      const parsed = new Date(entry.failedAt);
      expect(parsed.getTime()).not.toBeNaN();
    });
  });

  // ── 7. listDLQEntries Fault Scenarios ──────────────────────────────

  describe('listDLQEntries', () => {
    it('returns empty array when DLQ has no entries', async () => {
      mockQueueGetJobs.mockResolvedValueOnce([]);

      const dlq = createDLQ('orders');
      const entries = await listDLQEntries(dlq);

      expect(entries).toEqual([]);
      expect(mockQueueGetJobs).toHaveBeenCalledWith(
        ['waiting', 'delayed'],
        0,
        100,
      );
    });

    it('returns mapped DLQ entries', async () => {
      const dlqEntry = buildDLQEntry();
      mockQueueGetJobs.mockResolvedValueOnce([
        { data: dlqEntry },
        { data: buildDLQEntry({ error: 'Second failure' }) },
      ]);

      const dlq = createDLQ('orders');
      const entries = await listDLQEntries(dlq);

      expect(entries).toHaveLength(2);
      expect(entries[0].error).toBe('Connection refused');
      expect(entries[1].error).toBe('Second failure');
    });

    it('passes custom start/end to getJobs', async () => {
      mockQueueGetJobs.mockResolvedValueOnce([]);

      const dlq = createDLQ('orders');
      await listDLQEntries(dlq, 10, 50);

      expect(mockQueueGetJobs).toHaveBeenCalledWith(
        ['waiting', 'delayed'],
        10,
        50,
      );
    });

    it('propagates error when getJobs throws', async () => {
      mockQueueGetJobs.mockRejectedValueOnce(new Error('Redis READONLY'));

      const dlq = createDLQ('orders');

      await expect(listDLQEntries(dlq)).rejects.toThrow('Redis READONLY');
    });
  });

  // ── 8. replayFromDLQ Fault Scenarios ───────────────────────────────

  describe('replayFromDLQ', () => {
    it('throws when DLQ job is not found', async () => {
      mockQueueGetJob.mockResolvedValueOnce(null);

      const sourceQueue = createQueue('orders');
      const dlq = createDLQ('orders');

      await expect(
        replayFromDLQ(sourceQueue, dlq, 'nonexistent-id'),
      ).rejects.toThrow('DLQ job not found: nonexistent-id');
    });

    it('replays job to source queue with reset attempts', async () => {
      const envelope = buildEnvelope({ attempts: 3 });
      const dlqEntry = buildDLQEntry({ job: envelope });

      mockQueueGetJob.mockResolvedValueOnce({
        data: dlqEntry,
        remove: mockJobRemove.mockResolvedValueOnce(undefined),
      });
      mockQueueAdd.mockResolvedValueOnce({});

      const sourceQueue = createQueue('orders');
      const dlq = createDLQ('orders');

      await replayFromDLQ(sourceQueue, dlq, 'dlq:job-001');

      // Verify job added to source queue
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [jobType, replayedEnvelope, opts] = mockQueueAdd.mock.calls[0];
      expect(jobType).toBe('order.created');
      expect(replayedEnvelope.attempts).toBe(1); // reset
      expect(replayedEnvelope.id).toBe(envelope.id); // same job ID
      expect(opts.jobId).toBe(`replay:${envelope.id}`);

      // Verify DLQ job removed
      expect(mockJobRemove).toHaveBeenCalledTimes(1);
    });

    it('propagates error when sourceQueue.add throws', async () => {
      const dlqEntry = buildDLQEntry();

      mockQueueGetJob.mockResolvedValueOnce({
        data: dlqEntry,
        remove: mockJobRemove,
      });
      mockQueueAdd.mockRejectedValueOnce(new Error('Queue add failed'));

      const sourceQueue = createQueue('orders');
      const dlq = createDLQ('orders');

      await expect(
        replayFromDLQ(sourceQueue, dlq, 'dlq:job-001'),
      ).rejects.toThrow('Queue add failed');

      // Remove should NOT have been called (add failed first)
      expect(mockJobRemove).not.toHaveBeenCalled();
    });

    it('propagates error when dlqJob.remove throws', async () => {
      const dlqEntry = buildDLQEntry();

      mockQueueGetJob.mockResolvedValueOnce({
        data: dlqEntry,
        remove: mockJobRemove.mockRejectedValueOnce(
          new Error('Redis DEL failed'),
        ),
      });
      mockQueueAdd.mockResolvedValueOnce({});

      const sourceQueue = createQueue('orders');
      const dlq = createDLQ('orders');

      await expect(
        replayFromDLQ(sourceQueue, dlq, 'dlq:job-001'),
      ).rejects.toThrow('Redis DEL failed');
    });

    it('updates createdAt timestamp on replay', async () => {
      const oldDate = '2025-01-01T00:00:00.000Z';
      const envelope = buildEnvelope({ createdAt: oldDate });
      const dlqEntry = buildDLQEntry({ job: envelope });

      mockQueueGetJob.mockResolvedValueOnce({
        data: dlqEntry,
        remove: mockJobRemove.mockResolvedValueOnce(undefined),
      });
      mockQueueAdd.mockResolvedValueOnce({});

      const sourceQueue = createQueue('orders');
      const dlq = createDLQ('orders');

      await replayFromDLQ(sourceQueue, dlq, 'dlq:job-001');

      const replayedEnvelope = mockQueueAdd.mock.calls[0][1];
      expect(replayedEnvelope.createdAt).not.toBe(oldDate);
      // Should be a valid ISO timestamp
      expect(new Date(replayedEnvelope.createdAt).getTime()).not.toBeNaN();
    });
  });

  // ── 9. Full Lifecycle: Job Fails → DLQ → Replay ────────────────────

  describe('full lifecycle', () => {
    it('job fails → moves to DLQ → lists in DLQ → replays to source queue', async () => {
      // Step 1: Build the envelope that "failed"
      const envelope = buildEnvelope({
        id: 'lifecycle-001',
        type: 'order.process',
        tenantId: 'tenant-lifecycle',
        attempts: 3,
        maxRetries: 3,
      });

      // Step 2: Move to DLQ
      mockQueueAdd.mockResolvedValueOnce({}); // DLQ add
      const dlq = createDLQ('orders');
      const failedJob = { data: envelope, queueName: 'orders' } as any;
      await moveToDeadLetterQueue(dlq, failedJob, new Error('Fatal: OOM'));

      // Verify DLQ entry was created
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const dlqEntry = mockQueueAdd.mock.calls[0][1];
      expect(dlqEntry.error).toBe('Fatal: OOM');
      expect(dlqEntry.sourceQueue).toBe('orders');

      // Step 3: List DLQ entries
      mockQueueGetJobs.mockResolvedValueOnce([{ data: dlqEntry }]);
      const listed = await listDLQEntries(dlq);
      expect(listed).toHaveLength(1);
      expect(listed[0].job.id).toBe('lifecycle-001');

      // Step 4: Replay from DLQ
      vi.resetAllMocks(); // reset for replay phase
      mockQueueGetJob.mockResolvedValueOnce({
        data: dlqEntry,
        remove: mockJobRemove.mockResolvedValueOnce(undefined),
      });
      mockQueueAdd.mockResolvedValueOnce({}); // source queue add

      const sourceQueue = createQueue('orders');
      await replayFromDLQ(sourceQueue, dlq, 'dlq:lifecycle-001');

      // Verify replay: attempts reset, new timestamp, same original ID
      const replayedEnvelope = mockQueueAdd.mock.calls[0][1];
      expect(replayedEnvelope.id).toBe('lifecycle-001');
      expect(replayedEnvelope.attempts).toBe(1);
      expect(replayedEnvelope.tenantId).toBe('tenant-lifecycle');
      expect(mockJobRemove).toHaveBeenCalledTimes(1);
    });

    it('DLQ replay fails → original DLQ entry preserved', async () => {
      const envelope = buildEnvelope({ id: 'preserve-001' });
      const dlqEntry = buildDLQEntry({ job: envelope });

      mockQueueGetJob.mockResolvedValueOnce({
        data: dlqEntry,
        remove: mockJobRemove,
      });
      mockQueueAdd.mockRejectedValueOnce(new Error('Source queue unavailable'));

      const sourceQueue = createQueue('orders');
      const dlq = createDLQ('orders');

      await expect(
        replayFromDLQ(sourceQueue, dlq, 'dlq:preserve-001'),
      ).rejects.toThrow('Source queue unavailable');

      // DLQ job.remove should NOT have been called — entry preserved
      expect(mockJobRemove).not.toHaveBeenCalled();
    });
  });
});
