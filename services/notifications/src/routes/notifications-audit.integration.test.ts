import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  notifications: {
    id: 'notifications.id',
    tenantId: 'notifications.tenant_id',
    userId: 'notifications.user_id',
    type: 'notifications.type',
    title: 'notifications.title',
    isRead: 'notifications.is_read',
    readAt: 'notifications.read_at',
    createdAt: 'notifications.created_at',
    metadata: 'notifications.metadata',
  },
  notificationPreferences: {
    id: 'notification_preferences.id',
    tenantId: 'notification_preferences.tenant_id',
    userId: 'notification_preferences.user_id',
    notificationType: 'notification_preferences.notification_type',
    channel: 'notification_preferences.channel',
    isEnabled: 'notification_preferences.is_enabled',
    createdAt: 'notification_preferences.created_at',
    updatedAt: 'notification_preferences.updated_at',
  },
  notificationTypeEnum: {
    enumValues: [
      'card_triggered', 'po_created', 'po_sent', 'po_received',
      'stockout_warning', 'exception_alert', 'system_alert',
    ] as const,
  },
  notificationChannelEnum: {
    enumValues: ['in_app', 'email', 'webhook'] as const,
  },
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const { dbMock, resetDbMocks } = vi.hoisted(() => {
  const notificationRows: Array<Record<string, unknown>> = [];
  const preferenceRows: Array<Record<string, unknown>> = [];

  // Select builder — returns notifications rows by default
  function makeSelectBuilder(rows: () => Array<Record<string, unknown>>) {
    const builder: Record<string, unknown> = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows()).then(resolve, reject);
    return builder;
  }

  const deleteMock = vi.fn(() => ({
    where: () => ({
      then: (resolve: any) => Promise.resolve(undefined).then(resolve),
    }),
  }));

  const insertMock = vi.fn(() => ({
    values: () => ({
      returning: async () => [{ id: 'pref-new' }],
      then: (resolve: any) => Promise.resolve([{ id: 'pref-new' }]).then(resolve),
    }),
  }));

  const updateMock = vi.fn(() => ({
    set: () => ({
      where: () => ({
        returning: async () => [],
        then: (resolve: any) => Promise.resolve(undefined).then(resolve),
      }),
    }),
  }));

  const tx = {
    delete: deleteMock,
    insert: insertMock,
    update: updateMock,
    select: vi.fn((fields?: any) => makeSelectBuilder(() => preferenceRows)),
  };

  const dbMock = {
    select: vi.fn((fields?: any) => {
      if (fields && typeof fields === 'object' && 'count' in fields) {
        return {
          from: () => ({
            where: () => ({
              then: (resolve: any) => Promise.resolve([{ count: notificationRows.length }]).then(resolve),
            }),
          }),
        };
      }
      return makeSelectBuilder(() => notificationRows);
    }),
    update: updateMock,
    delete: deleteMock,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };

  const resetDbMocks = () => {
    notificationRows.length = 0;
    preferenceRows.length = 0;
    dbMock.select.mockClear();
    dbMock.update.mockClear();
    dbMock.delete.mockClear();
    dbMock.transaction.mockClear();
    deleteMock.mockClear();
    insertMock.mockClear();
    updateMock.mockClear();
    tx.select.mockClear();
  };

  return {
    dbMock,
    resetDbMocks,
    notificationRows,
    preferenceRows,
  };
});

// ─── Hoisted audit mock ─────────────────────────────────────────────
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.auditEntries.push(entry);
    return { id: 'audit-' + testState.auditEntries.length, hashChain: 'mock', sequenceNumber: testState.auditEntries.length };
  })
);

// ─── Module mocks ───────────────────────────────────────────────────
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: mockWriteAuditEntry,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: {},
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────
import { notificationsRouter } from './notifications.routes.js';
import { preferencesRouter } from './preferences.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────
function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { tenantId: 'tenant-1', sub: 'user-1' };
    next();
  });
  app.use('/notifications', notificationsRouter);
  app.use('/preferences', preferencesRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function deleteJson(app: express.Express, path: string) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'DELETE',
    });
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function putJson(app: express.Express, path: string, body: object) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ═════════════════════════════════════════════════════════════════════

describe('Notifications Audit Integration', () => {
  beforeEach(() => {
    resetDbMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
  });

  describe('notification.dismissed', () => {
    it('writes notification.dismissed audit entry on DELETE /notifications/:id', async () => {
      const seedNotification = {
        id: 'notif-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        type: 'po_created',
        title: 'PO Created',
        body: 'A new PO',
        isRead: false,
        readAt: null,
        actionUrl: null,
        metadata: {},
        createdAt: new Date('2026-01-01'),
      };

      // Access the hoisted arrays via the mock module's closure
      // The select builder returns notificationRows by default
      // We need to make the first select (ownership check) return the notification
      // and the transaction delete + audit to work

      // Override select to return our notification for the ownership check
      dbMock.select.mockImplementation((fields?: any) => {
        if (fields && typeof fields === 'object' && 'count' in fields) {
          return {
            from: () => ({
              where: () => ({
                then: (resolve: any) => Promise.resolve([{ count: 1 }]).then(resolve),
              }),
            }),
          } as any;
        }
        const builder: Record<string, unknown> = {};
        builder.from = () => builder;
        builder.where = () => builder;
        builder.orderBy = () => builder;
        builder.limit = () => builder;
        builder.offset = () => builder;
        builder.then = (resolve: any) => Promise.resolve([seedNotification]).then(resolve);
        return builder as any;
      });

      const app = createApp();
      const res = await deleteJson(app, '/notifications/notif-1');

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('notification.dismissed');
      expect(entry.entityType).toBe('notification');
      expect(entry.entityId).toBe('notif-1');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.previousState).toEqual({ type: 'po_created', isRead: false });
      expect(entry.metadata).toEqual(expect.objectContaining({
        source: 'notifications.dismiss',
        notificationType: 'po_created',
      }));
    });

    it('runs notification dismissal audit inside a transaction', async () => {
      const seedNotification = {
        id: 'notif-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        type: 'po_created',
        title: 'PO',
        body: 'Test',
        isRead: true,
        readAt: new Date(),
        actionUrl: null,
        metadata: {},
        createdAt: new Date(),
      };

      dbMock.select.mockImplementation((fields?: any) => {
        if (fields && typeof fields === 'object' && 'count' in fields) {
          return {
            from: () => ({
              where: () => ({
                then: (resolve: any) => Promise.resolve([{ count: 1 }]).then(resolve),
              }),
            }),
          } as any;
        }
        const builder: Record<string, unknown> = {};
        builder.from = () => builder;
        builder.where = () => builder;
        builder.orderBy = () => builder;
        builder.limit = () => builder;
        builder.offset = () => builder;
        builder.then = (resolve: any) => Promise.resolve([seedNotification]).then(resolve);
        return builder as any;
      });

      const app = createApp();
      await deleteJson(app, '/notifications/notif-1');

      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      // Verify audit was called with the tx (which has an insert property)
      const txArg = mockWriteAuditEntry.mock.calls[0][0];
      expect(txArg).toHaveProperty('delete');
    });
  });

  describe('notification_preference.updated', () => {
    it('writes notification_preference.updated audit entry on PUT /preferences', async () => {
      // The preferences route does a select before mutation to snapshot previous state
      // Then runs a transaction with upserts + writeAuditEntry
      const app = createApp();
      const res = await putJson(app, '/preferences', {
        preferences: {
          po_created: { inApp: true, email: false, webhook: false },
        },
      });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('notification_preference.updated');
      expect(entry.entityType).toBe('notification_preference');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.userId).toBe('user-1');
      expect(entry.newState).toEqual({
        po_created: { inApp: true, email: false, webhook: false },
      });
      expect(entry.metadata).toEqual(expect.objectContaining({
        source: 'preferences.update',
        targetUserId: 'user-1',
      }));
    });

    it('runs preference audit inside a transaction', async () => {
      const app = createApp();
      await putJson(app, '/preferences', {
        preferences: {
          exception_alert: { inApp: true, email: true, webhook: true },
        },
      });

      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const txArg = mockWriteAuditEntry.mock.calls[0][0];
      expect(txArg).toHaveProperty('insert');
    });
  });
});
