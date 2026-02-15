import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { JobEnvelope } from '@arda/jobs';

// ─── Mocks ────────────────────────────────────────────────────────────

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock drizzle-orm
const mockLt = vi.fn((...args: unknown[]) => ({ op: 'lt', args }));
const mockEq = vi.fn((...args: unknown[]) => ({ op: 'eq', args }));
const mockAnd = vi.fn((...args: unknown[]) => ({ op: 'and', args }));
const mockSql = vi.fn((...args: unknown[]) => args);

vi.mock('drizzle-orm', () => ({
  lt: (...args: unknown[]) => mockLt(...args),
  eq: (...args: unknown[]) => mockEq(...args),
  and: (...args: unknown[]) => mockAnd(...args),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (s: string) => s },
  ),
}));

// Mock db and schema
const mockDbDelete = vi.fn();
const mockDbDeleteWhere = vi.fn();
const mockDbSelect = vi.fn();
const mockDbSelectFrom = vi.fn();
const mockDbSelectWhere = vi.fn();

vi.mock('@arda/db', () => {
  const notificationsTable = {
    id: 'notifications.id',
    tenantId: 'notifications.tenant_id',
    createdAt: 'notifications.created_at',
  };

  const deliveriesTable = {
    id: 'notification_deliveries.id',
    tenantId: 'notification_deliveries.tenant_id',
    createdAt: 'notification_deliveries.created_at',
    status: 'notification_deliveries.status',
    channel: 'notification_deliveries.channel',
  };

  return {
    db: {
      delete: (...args: unknown[]) => {
        mockDbDelete(...args);
        return {
          where: (...whereArgs: unknown[]) => {
            mockDbDeleteWhere(...whereArgs);
            return Promise.resolve([{ count: 42 }]);
          },
        };
      },
      select: (...args: unknown[]) => {
        mockDbSelect(...args);
        return {
          from: (...fromArgs: unknown[]) => {
            mockDbSelectFrom(...fromArgs);
            return {
              where: (...whereArgs: unknown[]) => {
                mockDbSelectWhere(...whereArgs);
                return Promise.resolve([{ count: '0' }]);
              },
            };
          },
        };
      },
    },
    schema: {
      notifications: notificationsTable,
      notificationDeliveries: deliveriesTable,
    },
  };
});

// Mock @arda/jobs
const mockCreateQueue = vi.fn();
const mockBuildJobEnvelope = vi.fn();
const mockParseRedisUrl = vi.fn((_url?: string) => ({
  host: 'localhost',
  port: 6379,
  password: undefined,
  username: undefined,
  db: 0,
}));

vi.mock('@arda/jobs', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...(args as [unknown])),
  buildJobEnvelope: (...args: unknown[]) => mockBuildJobEnvelope(...(args as [unknown])),
  parseRedisUrl: (url: string) => mockParseRedisUrl(url),
}));

// Mock BullMQ
const mockWorkerOn = vi.fn();
const mockWorkerInstance = {
  on: mockWorkerOn,
  close: vi.fn(),
};

vi.mock('bullmq', () => {
  const MockWorker = vi.fn(function MockWorker() {
    return mockWorkerInstance;
  });
  return {
    Worker: MockWorker,
    Queue: vi.fn(),
  };
});

// ─── Import after mocks ──────────────────────────────────────────────

import {
  QUEUE_NAME,
  RETENTION_CONFIG,
  createRetentionCleanupQueue,
  createRetentionCleanupWorker,
  scheduleRetentionCleanupJob,
} from './retention-cleanup.worker.js';
import type { RetentionCleanupJobPayload } from './retention-cleanup.worker.js';
import { Worker as BullMQWorker } from 'bullmq';

// ─── Tests ────────────────────────────────────────────────────────────

describe('retention-cleanup.worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateQueue.mockReturnValue({
      add: vi.fn(),
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
      removeRepeatableByKey: vi.fn(),
    });
    mockBuildJobEnvelope.mockImplementation((type, tenantId, payload, maxRetries) => ({
      id: 'envelope-uuid-1',
      type,
      tenantId,
      payload,
      attempts: 1,
      maxRetries: maxRetries ?? 1,
      createdAt: new Date().toISOString(),
    }));
  });

  // ─── Constants ────────────────────────────────────────────────────

  describe('QUEUE_NAME', () => {
    it('equals notifications:retention-cleanup', () => {
      expect(QUEUE_NAME).toBe('notifications:retention-cleanup');
    });
  });

  describe('RETENTION_CONFIG', () => {
    it('has 90 days for notification retention', () => {
      expect(RETENTION_CONFIG.NOTIFICATION_RETENTION_DAYS).toBe(90);
    });

    it('has 180 days for delivery audit retention', () => {
      expect(RETENTION_CONFIG.DELIVERY_AUDIT_RETENTION_DAYS).toBe(180);
    });

    it('has a batch size for purge operations', () => {
      expect(RETENTION_CONFIG.PURGE_BATCH_SIZE).toBeGreaterThan(0);
    });
  });

  // ─── Queue Factory ────────────────────────────────────────────────

  describe('createRetentionCleanupQueue', () => {
    it('creates a queue with correct name and options', () => {
      const redisUrl = 'redis://localhost:6379';
      createRetentionCleanupQueue(redisUrl);

      expect(mockCreateQueue).toHaveBeenCalledTimes(1);
      expect(mockCreateQueue).toHaveBeenCalledWith(
        'notifications:retention-cleanup',
        expect.objectContaining({
          redisUrl,
          defaultJobOptions: expect.objectContaining({
            attempts: 1,
          }),
        }),
      );
    });
  });

  // ─── Worker Factory ───────────────────────────────────────────────

  describe('createRetentionCleanupWorker', () => {
    it('creates a BullMQ Worker with correct config', () => {
      createRetentionCleanupWorker('redis://localhost:6379');

      expect(BullMQWorker).toHaveBeenCalledTimes(1);
      expect(BullMQWorker).toHaveBeenCalledWith(
        'notifications:retention-cleanup',
        expect.any(Function),
        expect.objectContaining({
          prefix: 'arda',
          concurrency: 1,
        }),
      );
    });

    it('registers completed and failed event handlers', () => {
      createRetentionCleanupWorker('redis://localhost:6379');

      const onCalls = mockWorkerOn.mock.calls;
      const eventNames = onCalls.map((c: unknown[]) => c[0]);
      expect(eventNames).toContain('completed');
      expect(eventNames).toContain('failed');
    });
  });

  // ─── Worker Processor ─────────────────────────────────────────────

  describe('worker processor', () => {
    it('calls db.delete for notifications older than 90 days', async () => {
      createRetentionCleanupWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<RetentionCleanupJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.retention_cleanup',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<RetentionCleanupJobPayload>>;

      await processor(job);

      // Should delete from notifications table
      expect(mockDbDelete).toHaveBeenCalled();
      expect(mockDbDeleteWhere).toHaveBeenCalled();
    });

    it('calls db.delete for delivery audit rows older than 180 days', async () => {
      createRetentionCleanupWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<RetentionCleanupJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.retention_cleanup',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<RetentionCleanupJobPayload>>;

      await processor(job);

      // Should delete from both tables (notifications + deliveries)
      expect(mockDbDelete).toHaveBeenCalledTimes(2);
    });

    it('is idempotent — re-running the job does not error', async () => {
      createRetentionCleanupWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<RetentionCleanupJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.retention_cleanup',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<RetentionCleanupJobPayload>>;

      // First run
      await processor(job);
      // Second run — should not throw
      await expect(processor(job)).resolves.not.toThrow();
    });
  });

  // ─── Schedule ─────────────────────────────────────────────────────

  describe('scheduleRetentionCleanupJob', () => {
    it('adds a repeatable job with daily cron schedule', async () => {
      const mockAdd = vi.fn().mockResolvedValue({ id: 'scheduled-id' });
      const mockGetRepeatableJobs = vi.fn().mockResolvedValue([]);
      const queue = {
        add: mockAdd,
        getRepeatableJobs: mockGetRepeatableJobs,
        removeRepeatableByKey: vi.fn(),
      } as unknown as Queue<JobEnvelope<RetentionCleanupJobPayload>>;

      await scheduleRetentionCleanupJob(queue);

      expect(mockAdd).toHaveBeenCalledWith(
        'notifications.retention_cleanup',
        expect.anything(),
        expect.objectContaining({
          repeat: expect.objectContaining({
            pattern: expect.stringContaining('*'), // cron pattern
          }),
        }),
      );
    });

    it('removes existing repeatable jobs before adding new one', async () => {
      const mockRemoveRepeatableByKey = vi.fn();
      const mockGetRepeatableJobs = vi.fn().mockResolvedValue([
        { name: 'notifications.retention_cleanup', key: 'existing-key' },
      ]);
      const queue = {
        add: vi.fn().mockResolvedValue({ id: 'scheduled-id' }),
        getRepeatableJobs: mockGetRepeatableJobs,
        removeRepeatableByKey: mockRemoveRepeatableByKey,
      } as unknown as Queue<JobEnvelope<RetentionCleanupJobPayload>>;

      await scheduleRetentionCleanupJob(queue);

      expect(mockRemoveRepeatableByKey).toHaveBeenCalledWith('existing-key');
    });
  });
});
