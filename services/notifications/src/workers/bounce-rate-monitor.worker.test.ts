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
const mockEq = vi.fn((...args: unknown[]) => ({ op: 'eq', args }));
const mockAnd = vi.fn((...args: unknown[]) => ({ op: 'and', args }));
const mockGte = vi.fn((...args: unknown[]) => ({ op: 'gte', args }));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => mockEq(...args),
  and: (...args: unknown[]) => mockAnd(...args),
  gte: (...args: unknown[]) => mockGte(...args),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (s: string) => s },
  ),
}));

// Mock db and schema
const mockDbSelect = vi.fn();
const mockDbSelectFrom = vi.fn();
const mockDbSelectWhere = vi.fn();
const mockDbSelectGroupBy = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbUpdateSet = vi.fn();
const mockDbUpdateWhere = vi.fn();
const mockDbInsert = vi.fn();
const mockDbInsertValues = vi.fn();
const mockDbInsertReturning = vi.fn();

// Store the bounce data to return from queries
let mockBounceData: Array<{ tenantId: string; total: string; bounced: string }> = [];
let mockTenantSettings: Record<string, unknown> = {};

vi.mock('@arda/db', () => {
  const deliveriesTable = {
    id: 'notification_deliveries.id',
    tenantId: 'notification_deliveries.tenant_id',
    status: 'notification_deliveries.status',
    channel: 'notification_deliveries.channel',
    createdAt: 'notification_deliveries.created_at',
  };

  const tenantsTable = {
    id: 'tenants.id',
    settings: 'tenants.settings',
  };

  const notificationsTable = {
    id: 'notifications.id',
    tenantId: 'notifications.tenant_id',
    userId: 'notifications.user_id',
    type: 'notifications.type',
    title: 'notifications.title',
    body: 'notifications.body',
    isRead: 'notifications.is_read',
    metadata: 'notifications.metadata',
    createdAt: 'notifications.created_at',
  };

  const usersTable = {
    id: 'users.id',
    tenantId: 'users.tenant_id',
    isActive: 'users.is_active',
    role: 'users.role',
    email: 'users.email',
  };

  return {
    db: {
      select: (...args: unknown[]) => {
        mockDbSelect(...args);
        return {
          from: (...fromArgs: unknown[]) => {
            mockDbSelectFrom(...fromArgs);
            return {
              where: (...whereArgs: unknown[]) => {
                mockDbSelectWhere(...whereArgs);
                return {
                  groupBy: (...groupArgs: unknown[]) => {
                    mockDbSelectGroupBy(...groupArgs);
                    return Promise.resolve(mockBounceData);
                  },
                };
              },
              // For simple selects without where
              groupBy: (...groupArgs: unknown[]) => {
                mockDbSelectGroupBy(...groupArgs);
                return Promise.resolve(mockBounceData);
              },
            };
          },
        };
      },
      update: (...args: unknown[]) => {
        mockDbUpdate(...args);
        return {
          set: (...setArgs: unknown[]) => {
            mockDbUpdateSet(...setArgs);
            return {
              where: (...whereArgs: unknown[]) => {
                mockDbUpdateWhere(...whereArgs);
                return Promise.resolve();
              },
            };
          },
        };
      },
      insert: (...args: unknown[]) => {
        mockDbInsert(...args);
        return {
          values: (...valArgs: unknown[]) => {
            mockDbInsertValues(...valArgs);
            return {
              returning: (...retArgs: unknown[]) => {
                mockDbInsertReturning(...retArgs);
                return Promise.resolve([{ id: 'notif-uuid-1' }]);
              },
            };
          },
        };
      },
    },
    schema: {
      notificationDeliveries: deliveriesTable,
      tenants: tenantsTable,
      notifications: notificationsTable,
      users: usersTable,
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

// Mock event bus
const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@arda/events', () => ({
  getEventBus: () => ({
    publish: mockPublish,
    ping: vi.fn().mockResolvedValue(true),
  }),
}));

// ─── Import after mocks ──────────────────────────────────────────────

import {
  QUEUE_NAME,
  BOUNCE_RATE_CONFIG,
  createBounceRateMonitorQueue,
  createBounceRateMonitorWorker,
  scheduleBounceRateMonitorJob,
} from './bounce-rate-monitor.worker.js';
import type { BounceRateMonitorJobPayload } from './bounce-rate-monitor.worker.js';
import { Worker as BullMQWorker } from 'bullmq';

// ─── Tests ────────────────────────────────────────────────────────────

describe('bounce-rate-monitor.worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBounceData = [];
    mockTenantSettings = {};
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
    it('equals notifications:bounce-rate-monitor', () => {
      expect(QUEUE_NAME).toBe('notifications:bounce-rate-monitor');
    });
  });

  describe('BOUNCE_RATE_CONFIG', () => {
    it('has a default threshold of 5%', () => {
      expect(BOUNCE_RATE_CONFIG.BOUNCE_RATE_THRESHOLD_PERCENT).toBe(5);
    });

    it('has a minimum sample size to avoid false positives', () => {
      expect(BOUNCE_RATE_CONFIG.MIN_SAMPLE_SIZE).toBeGreaterThan(0);
    });

    it('has a lookback window in hours', () => {
      expect(BOUNCE_RATE_CONFIG.LOOKBACK_HOURS).toBeGreaterThan(0);
    });
  });

  // ─── Queue Factory ────────────────────────────────────────────────

  describe('createBounceRateMonitorQueue', () => {
    it('creates a queue with correct name and options', () => {
      const redisUrl = 'redis://localhost:6379';
      createBounceRateMonitorQueue(redisUrl);

      expect(mockCreateQueue).toHaveBeenCalledTimes(1);
      expect(mockCreateQueue).toHaveBeenCalledWith(
        'notifications:bounce-rate-monitor',
        expect.objectContaining({
          redisUrl,
        }),
      );
    });
  });

  // ─── Worker Factory ───────────────────────────────────────────────

  describe('createBounceRateMonitorWorker', () => {
    it('creates a BullMQ Worker with correct config', () => {
      createBounceRateMonitorWorker('redis://localhost:6379');

      expect(BullMQWorker).toHaveBeenCalledTimes(1);
      expect(BullMQWorker).toHaveBeenCalledWith(
        'notifications:bounce-rate-monitor',
        expect.any(Function),
        expect.objectContaining({
          prefix: 'arda',
          concurrency: 1,
        }),
      );
    });
  });

  // ─── Processor: No Bounces ────────────────────────────────────────

  describe('worker processor - no bounces', () => {
    it('does nothing when there are no email deliveries', async () => {
      mockBounceData = [];

      createBounceRateMonitorWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<BounceRateMonitorJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.bounce_rate_monitor',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<BounceRateMonitorJobPayload>>;

      await processor(job);

      // Should not update any tenant settings
      expect(mockDbUpdate).not.toHaveBeenCalled();
    });
  });

  // ─── Processor: Below Threshold ───────────────────────────────────

  describe('worker processor - bounce rate below threshold', () => {
    it('does not pause email for tenant with bounce rate under 5%', async () => {
      // 2% bounce rate: 2 bounced out of 100 total
      mockBounceData = [
        { tenantId: 'tenant-1', total: '100', bounced: '2' },
      ];

      createBounceRateMonitorWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<BounceRateMonitorJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.bounce_rate_monitor',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<BounceRateMonitorJobPayload>>;

      await processor(job);

      // Should not update tenant settings (no pause needed)
      expect(mockDbUpdate).not.toHaveBeenCalled();
    });
  });

  // ─── Processor: Above Threshold ───────────────────────────────────

  describe('worker processor - bounce rate above threshold', () => {
    it('pauses outbound email for tenant with bounce rate >5%', async () => {
      // 8% bounce rate: 8 bounced out of 100 total
      mockBounceData = [
        { tenantId: 'tenant-1', total: '100', bounced: '8' },
      ];

      createBounceRateMonitorWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<BounceRateMonitorJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.bounce_rate_monitor',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<BounceRateMonitorJobPayload>>;

      await processor(job);

      // Should update tenant settings to pause email
      expect(mockDbUpdate).toHaveBeenCalled();
    });
  });

  // ─── Processor: Below Min Sample Size ─────────────────────────────

  describe('worker processor - below minimum sample size', () => {
    it('does not pause when sample size is too small even with high bounce rate', async () => {
      // 50% bounce rate but only 5 total (below default min of 10)
      mockBounceData = [
        { tenantId: 'tenant-1', total: '5', bounced: '3' },
      ];

      createBounceRateMonitorWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<BounceRateMonitorJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.bounce_rate_monitor',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<BounceRateMonitorJobPayload>>;

      await processor(job);

      // Should not update (sample too small)
      expect(mockDbUpdate).not.toHaveBeenCalled();
    });
  });

  // ─── Processor: Multiple Tenants ──────────────────────────────────

  describe('worker processor - multiple tenants', () => {
    it('only pauses tenants that exceed threshold', async () => {
      mockBounceData = [
        { tenantId: 'tenant-good', total: '100', bounced: '1' }, // 1% — safe
        { tenantId: 'tenant-bad', total: '100', bounced: '10' },  // 10% — should be paused
        { tenantId: 'tenant-ok', total: '100', bounced: '3' },    // 3% — safe
      ];

      createBounceRateMonitorWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<BounceRateMonitorJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.bounce_rate_monitor',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<BounceRateMonitorJobPayload>>;

      await processor(job);

      // Should update only the bad tenant
      expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Processor: Boundary — Exactly 5% ─────────────────────────────

  describe('worker processor - boundary: exactly 5%', () => {
    it('does not pause at exactly the 5% threshold (must exceed)', async () => {
      // Exactly 5% — should NOT pause (threshold is >5%)
      mockBounceData = [
        { tenantId: 'tenant-1', total: '100', bounced: '5' },
      ];

      createBounceRateMonitorWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<BounceRateMonitorJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.bounce_rate_monitor',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<BounceRateMonitorJobPayload>>;

      await processor(job);

      // Should not pause (5% is not > 5%)
      expect(mockDbUpdate).not.toHaveBeenCalled();
    });
  });

  // ─── Schedule ─────────────────────────────────────────────────────

  describe('scheduleBounceRateMonitorJob', () => {
    it('adds a repeatable job with hourly cron schedule', async () => {
      const mockAdd = vi.fn().mockResolvedValue({ id: 'scheduled-id' });
      const mockGetRepeatableJobs = vi.fn().mockResolvedValue([]);
      const queue = {
        add: mockAdd,
        getRepeatableJobs: mockGetRepeatableJobs,
        removeRepeatableByKey: vi.fn(),
      } as unknown as Queue<JobEnvelope<BounceRateMonitorJobPayload>>;

      await scheduleBounceRateMonitorJob(queue);

      expect(mockAdd).toHaveBeenCalledWith(
        'notifications.bounce_rate_monitor',
        expect.anything(),
        expect.objectContaining({
          repeat: expect.objectContaining({
            pattern: expect.stringContaining('*'),
          }),
        }),
      );
    });
  });

  // ─── Idempotency ──────────────────────────────────────────────────

  describe('idempotency', () => {
    it('is safe to run multiple times without side effects for clean tenants', async () => {
      mockBounceData = [
        { tenantId: 'tenant-clean', total: '100', bounced: '1' },
      ];

      createBounceRateMonitorWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<BounceRateMonitorJobPayload>>,
      ) => Promise<void>;

      const job = {
        data: {
          id: 'job-uuid-1',
          type: 'notifications.bounce_rate_monitor',
          tenantId: 'system',
          payload: { triggeredAt: new Date().toISOString() },
          attempts: 1,
          maxRetries: 1,
          createdAt: new Date().toISOString(),
        },
        attemptsMade: 0,
      } as unknown as Job<JobEnvelope<BounceRateMonitorJobPayload>>;

      await processor(job);
      await expect(processor(job)).resolves.not.toThrow();
    });
  });
});
