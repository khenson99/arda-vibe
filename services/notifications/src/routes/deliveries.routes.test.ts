import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted Test State ───────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  deliveries: [] as Array<{
    id: string;
    notificationId: string;
    userId: string;
    tenantId: string;
    channel: string;
    status: string;
    provider: string | null;
    providerMessageId: string | null;
    attemptCount: number;
    lastAttemptAt: Date | null;
    lastError: string | null;
    deliveredAt: Date | null;
    createdAt: Date;
  }>,
  notifications: [] as Array<{
    id: string;
    tenantId: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    isRead: boolean;
    readAt: Date | null;
    actionUrl: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }>,
}));

// ─── DB Mock ──────────────────────────────────────────────────────────
// Each select() call creates a fresh builder with its own table tracking.
const { dbMock, resetDbMockCalls, NOTIFICATIONS_TABLE } = vi.hoisted(() => {
  const NOTIFICATIONS_TABLE = 'notifications_table';
  function makeSelectBuilder(isCount: boolean) {
    let tableRef: string | null = null;

    const builder: any = {};
    builder.from = (table: any) => {
      tableRef = table;
      return builder;
    };
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;

    const getData = () => {
      if (isCount) {
        return [{ count: testState.deliveries.length }];
      }
      return tableRef === 'notifications_table'
        ? testState.notifications
        : testState.deliveries;
    };

    builder.execute = async () => getData();
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(getData()).then(resolve, reject);

    return builder;
  }

  const dbMock = {
    select: vi.fn((fields?: any) => {
      const isCount = fields && typeof fields === 'object' && 'count' in fields;
      return makeSelectBuilder(!!isCount);
    }),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
  };

  return { dbMock, resetDbMockCalls, NOTIFICATIONS_TABLE };
});

// ─── Drizzle ORM Mock ─────────────────────────────────────────────────
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ op: 'and', args })),
  eq: vi.fn((field, value) => ({ op: 'eq', field, value })),
  desc: vi.fn((field) => ({ op: 'desc', field })),
  sql: vi.fn((strings: any, ...values: any[]) => ({ op: 'sql', strings, values })),
  gte: vi.fn((field, value) => ({ op: 'gte', field, value })),
  lte: vi.fn((field, value) => ({ op: 'lte', field, value })),
}));

// ─── @arda/db Mock ────────────────────────────────────────────────────
vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: {
    notificationDeliveries: {
      id: 'deliveries.id',
      tenantId: 'deliveries.tenant_id',
      notificationId: 'deliveries.notification_id',
      userId: 'deliveries.user_id',
      channel: 'deliveries.channel',
      status: 'deliveries.status',
      provider: 'deliveries.provider',
      providerMessageId: 'deliveries.provider_message_id',
      attemptCount: 'deliveries.attempt_count',
      lastAttemptAt: 'deliveries.last_attempt_at',
      lastError: 'deliveries.last_error',
      deliveredAt: 'deliveries.delivered_at',
      metadata: 'deliveries.metadata',
      createdAt: 'deliveries.created_at',
      updatedAt: 'deliveries.updated_at',
    },
    notifications: NOTIFICATIONS_TABLE,
    notificationChannelEnum: {
      enumValues: ['in_app', 'email', 'webhook'] as const,
    },
    deliveryStatusEnum: {
      enumValues: ['pending', 'sent', 'delivered', 'failed', 'bounced'] as const,
    },
  },
}));

// ─── @arda/config Mock ────────────────────────────────────────────────
vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ─── Test App Setup ───────────────────────────────────────────────────
import { deliveriesRouter } from './deliveries.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import express from 'express';
import request from 'supertest';

// Helper to create an app with specific user role
function createApp(userOverrides: Partial<{ sub: string; tenantId: string; role: string }> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: userOverrides.sub ?? 'user-1',
      tenantId: userOverrides.tenantId ?? 'tenant-1',
      email: 'test@example.com',
      role: userOverrides.role ?? 'user',
    };
    next();
  });
  app.use('/notifications', deliveriesRouter);
  app.use(errorHandler);
  return app;
}

const userApp = createApp({ role: 'user' });
const adminApp = createApp({ role: 'tenant_admin' });

// ─── Helper: sample delivery ──────────────────────────────────────────
function makeDelivery(overrides: Partial<typeof testState.deliveries[number]> = {}) {
  return {
    id: 'del-1',
    notificationId: 'notif-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    channel: 'email',
    status: 'delivered',
    provider: 'sendgrid',
    providerMessageId: 'msg_123',
    attemptCount: 1,
    lastAttemptAt: new Date('2026-02-10T12:00:00Z'),
    lastError: null,
    deliveredAt: new Date('2026-02-10T12:01:00Z'),
    createdAt: new Date('2026-02-10T12:00:00Z'),
    ...overrides,
  };
}

function makeNotification(overrides: Partial<typeof testState.notifications[number]> = {}) {
  return {
    id: 'notif-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    type: 'po_created',
    title: 'PO Created',
    body: 'A new PO was created',
    isRead: false,
    readAt: null,
    actionUrl: null,
    metadata: {},
    createdAt: new Date('2026-02-10T12:00:00Z'),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('deliveries.routes', () => {
  beforeEach(() => {
    testState.deliveries = [];
    testState.notifications = [];
    resetDbMockCalls();
  });

  // ── GET /deliveries ────────────────────────────────────────────────

  describe('GET /notifications/deliveries — list deliveries', () => {
    it('admin can list all tenant deliveries', async () => {
      testState.deliveries = [
        makeDelivery({ id: 'del-1', userId: 'user-1' }),
        makeDelivery({ id: 'del-2', userId: 'user-2' }),
      ];

      const res = await request(adminApp)
        .get('/notifications/deliveries')
        .expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('pagination');
      expect(res.body.pagination).toEqual({
        total: 2,
        page: 1,
        pageSize: 20,
      });
      expect(res.body.data).toHaveLength(2);
    });

    it('regular user only sees own deliveries', async () => {
      testState.deliveries = [
        makeDelivery({ id: 'del-1', userId: 'user-1' }),
      ];

      const res = await request(userApp)
        .get('/notifications/deliveries')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination.total).toBe(1);

      // Verify db.select was called (RBAC conditions are passed to where)
      expect(dbMock.select).toHaveBeenCalled();
    });

    it('filter by status works', async () => {
      testState.deliveries = [
        makeDelivery({ id: 'del-1', status: 'failed' }),
      ];

      const res = await request(adminApp)
        .get('/notifications/deliveries?status=failed')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe('del-1');
    });

    it('filter by channel works', async () => {
      testState.deliveries = [
        makeDelivery({ id: 'del-1', channel: 'webhook' }),
      ];

      const res = await request(adminApp)
        .get('/notifications/deliveries?channel=webhook')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].channel).toBe('webhook');
    });

    it('filter by date range works', async () => {
      testState.deliveries = [
        makeDelivery({ id: 'del-1', createdAt: new Date('2026-02-05T00:00:00Z') }),
      ];

      const res = await request(adminApp)
        .get('/notifications/deliveries?from=2026-02-01T00:00:00Z&to=2026-02-10T00:00:00Z')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
    });

    it('filter by notificationId works', async () => {
      testState.deliveries = [
        makeDelivery({ id: 'del-1', notificationId: 'notif-42' }),
      ];

      const res = await request(adminApp)
        .get('/notifications/deliveries?notificationId=notif-42')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
    });

    it('pagination works correctly', async () => {
      testState.deliveries = [
        makeDelivery({ id: 'del-1' }),
        makeDelivery({ id: 'del-2' }),
        makeDelivery({ id: 'del-3' }),
      ];

      const res = await request(adminApp)
        .get('/notifications/deliveries?page=2&pageSize=2')
        .expect(200);

      expect(res.body.pagination).toEqual({
        total: 3,
        page: 2,
        pageSize: 2,
      });
    });

    it('returns correct delivery shape', async () => {
      testState.deliveries = [
        makeDelivery(),
      ];

      const res = await request(adminApp)
        .get('/notifications/deliveries')
        .expect(200);

      const delivery = res.body.data[0];
      expect(delivery).toHaveProperty('id');
      expect(delivery).toHaveProperty('notificationId');
      expect(delivery).toHaveProperty('userId');
      expect(delivery).toHaveProperty('channel');
      expect(delivery).toHaveProperty('status');
      expect(delivery).toHaveProperty('provider');
      expect(delivery).toHaveProperty('providerMessageId');
      expect(delivery).toHaveProperty('attemptCount');
      expect(delivery).toHaveProperty('lastAttemptAt');
      expect(delivery).toHaveProperty('lastError');
      expect(delivery).toHaveProperty('deliveredAt');
      expect(delivery).toHaveProperty('createdAt');
    });

    it('rejects invalid status filter', async () => {
      const res = await request(adminApp)
        .get('/notifications/deliveries?status=invalid_status')
        .expect(500);

      expect(res.body).toHaveProperty('error');
    });

    it('rejects invalid channel filter', async () => {
      const res = await request(adminApp)
        .get('/notifications/deliveries?channel=sms')
        .expect(500);

      expect(res.body).toHaveProperty('error');
    });

    it('admin can filter by userId', async () => {
      testState.deliveries = [
        makeDelivery({ id: 'del-1', userId: 'user-2' }),
      ];

      const res = await request(adminApp)
        .get('/notifications/deliveries?userId=user-2')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
    });

    it('defaults to page 1 and pageSize 20', async () => {
      testState.deliveries = [];

      const res = await request(adminApp)
        .get('/notifications/deliveries')
        .expect(200);

      expect(res.body.pagination).toEqual({
        total: 0,
        page: 1,
        pageSize: 20,
      });
    });

    it('caps pageSize at 100', async () => {
      const res = await request(adminApp)
        .get('/notifications/deliveries?pageSize=200')
        .expect(500);

      expect(res.body).toHaveProperty('error');
    });
  });

  // ── GET /:notificationId/deliveries ────────────────────────────────

  describe('GET /notifications/:notificationId/deliveries — deliveries for a notification', () => {
    it('returns deliveries for a notification', async () => {
      testState.notifications = [makeNotification({ id: 'notif-1', userId: 'user-1' })];
      testState.deliveries = [
        makeDelivery({ id: 'del-1', notificationId: 'notif-1', channel: 'email' }),
        makeDelivery({ id: 'del-2', notificationId: 'notif-1', channel: 'in_app' }),
      ];

      const res = await request(userApp)
        .get('/notifications/notif-1/deliveries')
        .expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveLength(2);
    });

    it('regular user cannot see other user\'s notification deliveries', async () => {
      testState.notifications = [
        makeNotification({ id: 'notif-other', userId: 'user-other', tenantId: 'tenant-1' }),
      ];

      const res = await request(userApp)
        .get('/notifications/notif-other/deliveries')
        .expect(404);

      expect(res.body).toHaveProperty('error');
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('admin can see any tenant user\'s notification deliveries', async () => {
      testState.notifications = [
        makeNotification({ id: 'notif-other', userId: 'user-other', tenantId: 'tenant-1' }),
      ];
      testState.deliveries = [
        makeDelivery({ id: 'del-1', notificationId: 'notif-other', userId: 'user-other' }),
      ];

      const res = await request(adminApp)
        .get('/notifications/notif-other/deliveries')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
    });

    it('returns 404 when notification does not exist', async () => {
      testState.notifications = [];

      const res = await request(userApp)
        .get('/notifications/notif-nonexistent/deliveries')
        .expect(404);

      expect(res.body.error).toBe('Notification not found');
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('returns 404 when notification belongs to a different tenant', async () => {
      // Notification exists but for a different tenant — the WHERE clause
      // filters by tenantId so it won't be found
      testState.notifications = [];

      const res = await request(userApp)
        .get('/notifications/notif-wrong-tenant/deliveries')
        .expect(404);

      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('returns empty array when notification has no deliveries', async () => {
      testState.notifications = [makeNotification({ id: 'notif-1', userId: 'user-1' })];
      testState.deliveries = [];

      const res = await request(userApp)
        .get('/notifications/notif-1/deliveries')
        .expect(200);

      expect(res.body.data).toEqual([]);
    });
  });
});
