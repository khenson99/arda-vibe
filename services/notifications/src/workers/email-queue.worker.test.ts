import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { JobEnvelope, DLQEntry } from '@arda/jobs';

// ─── Mocks ────────────────────────────────────────────────────────────

// Mock @arda/config
vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock drizzle-orm eq function
const mockEq = vi.fn((...args: unknown[]) => ({ op: 'eq', args }));
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => mockEq(...args),
}));

// Mock db and schema
const mockDbUpdate = vi.fn();
const mockDbSet = vi.fn();
const mockDbWhere = vi.fn();

vi.mock('@arda/db', () => {
  const deliveriesTable = {
    id: 'notification_deliveries.id',
    status: 'notification_deliveries.status',
    attemptCount: 'notification_deliveries.attempt_count',
    lastAttemptAt: 'notification_deliveries.last_attempt_at',
    lastError: 'notification_deliveries.last_error',
    provider: 'notification_deliveries.provider',
    providerMessageId: 'notification_deliveries.provider_message_id',
    deliveredAt: 'notification_deliveries.delivered_at',
    updatedAt: 'notification_deliveries.updated_at',
  };

  return {
    db: {
      update: (...args: unknown[]) => {
        mockDbUpdate(...args);
        return {
          set: (...setArgs: unknown[]) => {
            mockDbSet(...setArgs);
            return {
              where: (...whereArgs: unknown[]) => {
                mockDbWhere(...whereArgs);
                return Promise.resolve();
              },
            };
          },
        };
      },
    },
    schema: {
      notificationDeliveries: deliveriesTable,
    },
  };
});

// Mock @arda/jobs
const mockCreateQueue = vi.fn();
const mockCreateDLQ = vi.fn();
const mockMoveToDeadLetterQueue = vi.fn();
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
  createWorker: vi.fn(),
  buildJobEnvelope: (...args: unknown[]) => mockBuildJobEnvelope(...(args as [unknown])),
  createDLQ: (...args: unknown[]) => mockCreateDLQ(...(args as [unknown])),
  moveToDeadLetterQueue: (...args: unknown[]) => mockMoveToDeadLetterQueue(...(args as [unknown])),
  parseRedisUrl: (url: string) => mockParseRedisUrl(url),
}));

// Mock BullMQ Worker constructor
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

// Mock email provider
const mockEmailSend = vi.fn();
const mockProvider = {
  name: 'sendgrid',
  send: mockEmailSend,
};

vi.mock('../services/email-provider.js', () => ({
  createEmailProvider: () => mockProvider,
}));

// ─── Import after mocks ──────────────────────────────────────────────

import {
  QUEUE_NAME,
  createEmailQueue,
  createEmailWorker,
  enqueueEmail,
  calculateBackoffDelay,
} from './email-queue.worker.js';
import type { EmailJobPayload } from './email-queue.worker.js';
import { Worker as BullMQWorker } from 'bullmq';

// ─── Test Data ────────────────────────────────────────────────────────

function buildTestPayload(overrides?: Partial<EmailJobPayload>): EmailJobPayload {
  return {
    deliveryId: 'delivery-uuid-1',
    notificationId: 'notif-uuid-1',
    tenantId: 'tenant-uuid-1',
    userId: 'user-uuid-1',
    to: 'user@example.com',
    subject: 'Test Email',
    html: '<p>Hello</p>',
    ...overrides,
  };
}

function buildTestJob(
  payload: EmailJobPayload,
  attemptsMade = 0,
  maxAttempts = 3,
): Job<JobEnvelope<EmailJobPayload>> {
  return {
    data: {
      id: 'job-uuid-1',
      type: 'notifications.email_send',
      tenantId: payload.tenantId,
      payload,
      attempts: 1,
      maxRetries: maxAttempts,
      createdAt: new Date().toISOString(),
    },
    attemptsMade,
    opts: { attempts: maxAttempts },
    queueName: QUEUE_NAME,
  } as unknown as Job<JobEnvelope<EmailJobPayload>>;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('email-queue.worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateQueue.mockReturnValue({ add: vi.fn() });
    mockCreateDLQ.mockReturnValue({ add: vi.fn() });
    mockMoveToDeadLetterQueue.mockResolvedValue(undefined);
    mockBuildJobEnvelope.mockImplementation((type, tenantId, payload, maxRetries) => ({
      id: 'envelope-uuid-1',
      type,
      tenantId,
      payload,
      attempts: 1,
      maxRetries: maxRetries ?? 3,
      createdAt: new Date().toISOString(),
    }));
    mockEmailSend.mockResolvedValue({
      messageId: 'msg-123',
      provider: 'sendgrid',
    });
  });

  // ─── QUEUE_NAME constant ──────────────────────────────────────────

  describe('QUEUE_NAME', () => {
    it('equals notifications:email', () => {
      expect(QUEUE_NAME).toBe('notifications:email');
    });
  });

  // ─── createEmailQueue ─────────────────────────────────────────────

  describe('createEmailQueue', () => {
    it('creates a queue with correct name and options', () => {
      const redisUrl = 'redis://localhost:6379';
      createEmailQueue(redisUrl);

      expect(mockCreateQueue).toHaveBeenCalledTimes(1);
      expect(mockCreateQueue).toHaveBeenCalledWith(
        'notifications:email',
        expect.objectContaining({
          redisUrl,
          defaultJobOptions: expect.objectContaining({
            attempts: 3,
            removeOnComplete: 100,
            removeOnFail: 500,
          }),
        }),
      );
    });
  });

  // ─── createEmailWorker ────────────────────────────────────────────

  describe('createEmailWorker', () => {
    it('creates a BullMQ Worker with correct config', () => {
      const redisUrl = 'redis://localhost:6379';
      createEmailWorker(redisUrl);

      expect(BullMQWorker).toHaveBeenCalledTimes(1);
      expect(BullMQWorker).toHaveBeenCalledWith(
        'notifications:email',
        expect.any(Function),
        expect.objectContaining({
          prefix: 'arda',
          concurrency: 5,
          lockDuration: 30_000,
          settings: expect.objectContaining({
            backoffStrategy: expect.any(Function),
          }),
        }),
      );
    });

    it('creates a DLQ for the email queue', () => {
      const redisUrl = 'redis://localhost:6379';
      createEmailWorker(redisUrl);

      expect(mockCreateDLQ).toHaveBeenCalledWith('notifications:email', redisUrl);
    });

    it('registers completed and failed event handlers', () => {
      createEmailWorker('redis://localhost:6379');

      const onCalls = mockWorkerOn.mock.calls;
      const eventNames = onCalls.map((c: unknown[]) => c[0]);
      expect(eventNames).toContain('completed');
      expect(eventNames).toContain('failed');
    });
  });

  // ─── Worker Processor (success path) ──────────────────────────────

  describe('worker processor - success', () => {
    it('processes email job and updates delivery record on success', async () => {
      createEmailWorker('redis://localhost:6379');

      // Extract the processor function passed to the Worker constructor
      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<EmailJobPayload>>,
      ) => Promise<void>;

      const payload = buildTestPayload();
      const job = buildTestJob(payload, 0);

      await processor(job);

      // Should have called db.update to mark attempt started
      expect(mockDbUpdate).toHaveBeenCalled();
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptCount: 1,
          lastAttemptAt: expect.any(Date),
        }),
      );

      // Should have called email provider send
      expect(mockEmailSend).toHaveBeenCalledWith({
        to: 'user@example.com',
        subject: 'Test Email',
        html: '<p>Hello</p>',
        from: undefined,
        headers: undefined,
      });

      // Should mark as delivered
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'delivered',
          provider: 'sendgrid',
          providerMessageId: 'msg-123',
          deliveredAt: expect.any(Date),
        }),
      );
    });
  });

  // ─── Worker Processor (failure path) ──────────────────────────────

  describe('worker processor - failure', () => {
    it('updates delivery record with error on failure and rethrows', async () => {
      const sendError = new Error('SMTP connection refused');
      mockEmailSend.mockRejectedValueOnce(sendError);

      createEmailWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<EmailJobPayload>>,
      ) => Promise<void>;

      const payload = buildTestPayload();
      const job = buildTestJob(payload, 0);

      await expect(processor(job)).rejects.toThrow('SMTP connection refused');

      // Should have updated delivery record with the error
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          lastError: 'SMTP connection refused',
        }),
      );
    });
  });

  // ─── DLQ Routing ──────────────────────────────────────────────────

  describe('DLQ routing on terminal failure', () => {
    it('moves job to DLQ and marks delivery as failed when max attempts exhausted', async () => {
      createEmailWorker('redis://localhost:6379');

      // Find the 'failed' event handler
      const failedHandler = mockWorkerOn.mock.calls.find(
        (c: unknown[]) => c[0] === 'failed',
      )?.[1] as (job: Job<JobEnvelope<EmailJobPayload>> | undefined, err: Error) => Promise<void>;

      expect(failedHandler).toBeDefined();

      const payload = buildTestPayload();
      const job = buildTestJob(payload, 3, 3); // attemptsMade=3, maxAttempts=3
      const error = new Error('Permanent failure');

      await failedHandler(job, error);

      // Should mark as permanently failed in DB
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          lastError: 'Permanent failure',
        }),
      );

      // Should move to DLQ
      expect(mockMoveToDeadLetterQueue).toHaveBeenCalledWith(
        expect.anything(), // dlq
        job,
        error,
      );
    });

    it('does not move to DLQ when attempts remain', async () => {
      createEmailWorker('redis://localhost:6379');

      const failedHandler = mockWorkerOn.mock.calls.find(
        (c: unknown[]) => c[0] === 'failed',
      )?.[1] as (job: Job<JobEnvelope<EmailJobPayload>> | undefined, err: Error) => Promise<void>;

      const payload = buildTestPayload();
      const job = buildTestJob(payload, 1, 3); // attemptsMade=1, maxAttempts=3
      const error = new Error('Temporary failure');

      await failedHandler(job, error);

      expect(mockMoveToDeadLetterQueue).not.toHaveBeenCalled();
    });

    it('handles null job in failed event gracefully', async () => {
      createEmailWorker('redis://localhost:6379');

      const failedHandler = mockWorkerOn.mock.calls.find(
        (c: unknown[]) => c[0] === 'failed',
      )?.[1] as (job: Job<JobEnvelope<EmailJobPayload>> | undefined, err: Error) => Promise<void>;

      // Should not throw when job is null/undefined
      await expect(
        failedHandler(undefined, new Error('Unknown failure')),
      ).resolves.toBeUndefined();
    });
  });

  // ─── Jitter Backoff Timing ────────────────────────────────────────

  describe('calculateBackoffDelay', () => {
    it('produces delays in 45s-75s range for attempt 1', () => {
      const samples = Array.from({ length: 100 }, () => calculateBackoffDelay(1));

      for (const delay of samples) {
        expect(delay).toBeGreaterThanOrEqual(45_000);
        expect(delay).toBeLessThanOrEqual(75_000);
      }
    });

    it('produces delays in 240s-360s range for attempt 2', () => {
      const samples = Array.from({ length: 100 }, () => calculateBackoffDelay(2));

      for (const delay of samples) {
        expect(delay).toBeGreaterThanOrEqual(240_000);
        expect(delay).toBeLessThanOrEqual(360_000);
      }
    });

    it('caps at last schedule entry for attempts beyond schedule', () => {
      const samples = Array.from({ length: 50 }, () => calculateBackoffDelay(5));

      for (const delay of samples) {
        // Should use the last schedule entry (300s +/- 60s)
        expect(delay).toBeGreaterThanOrEqual(240_000);
        expect(delay).toBeLessThanOrEqual(360_000);
      }
    });

    it('produces varied results (jitter is effective)', () => {
      const samples = Array.from({ length: 20 }, () => calculateBackoffDelay(1));
      const unique = new Set(samples);
      // With 20 samples across a 30s range, we should get at least a few unique values
      expect(unique.size).toBeGreaterThan(1);
    });

    it('is wired into the worker backoffStrategy', () => {
      createEmailWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const workerOpts = WorkerMock.mock.calls[0][2] as {
        settings: { backoffStrategy: (attemptsMade: number) => number };
      };

      const result = workerOpts.settings.backoffStrategy(1);
      expect(result).toBeGreaterThanOrEqual(45_000);
      expect(result).toBeLessThanOrEqual(75_000);
    });
  });

  // ─── enqueueEmail ─────────────────────────────────────────────────

  describe('enqueueEmail', () => {
    it('builds job envelope and adds to queue', async () => {
      const mockAdd = vi.fn().mockResolvedValue({ id: 'queued-job-id' });
      const queue = { add: mockAdd } as unknown as Queue<JobEnvelope<EmailJobPayload>>;

      const payload = buildTestPayload();
      await enqueueEmail(queue, payload);

      // Should build envelope
      expect(mockBuildJobEnvelope).toHaveBeenCalledWith(
        'notifications.email_send',
        payload.tenantId,
        payload,
        3,
      );

      // Should add to queue with correct job ID and custom backoff
      expect(mockAdd).toHaveBeenCalledWith(
        'notifications.email_send',
        expect.objectContaining({
          type: 'notifications.email_send',
          tenantId: 'tenant-uuid-1',
          payload,
        }),
        expect.objectContaining({
          jobId: 'email:delivery-uuid-1',
          backoff: { type: 'custom' },
        }),
      );
    });

    it('uses deliveryId as part of the job ID for idempotency', async () => {
      const mockAdd = vi.fn().mockResolvedValue({ id: 'queued-job-id' });
      const queue = { add: mockAdd } as unknown as Queue<JobEnvelope<EmailJobPayload>>;

      const payload = buildTestPayload({ deliveryId: 'unique-delivery-42' });
      await enqueueEmail(queue, payload);

      expect(mockAdd).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({
          jobId: 'email:unique-delivery-42',
        }),
      );
    });
  });

  // ─── Email with optional fields ───────────────────────────────────

  describe('optional email fields', () => {
    it('passes from and headers to email provider when provided', async () => {
      createEmailWorker('redis://localhost:6379');

      const WorkerMock = BullMQWorker as unknown as ReturnType<typeof vi.fn>;
      const processor = WorkerMock.mock.calls[0][1] as (
        job: Job<JobEnvelope<EmailJobPayload>>,
      ) => Promise<void>;

      const payload = buildTestPayload({
        from: 'custom@arda.cards',
        headers: { 'List-Unsubscribe': '<mailto:unsub@arda.cards>' },
      });
      const job = buildTestJob(payload, 0);

      await processor(job);

      expect(mockEmailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'custom@arda.cards',
          headers: { 'List-Unsubscribe': '<mailto:unsub@arda.cards>' },
        }),
      );
    });
  });
});
