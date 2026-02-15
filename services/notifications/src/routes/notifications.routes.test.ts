import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
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
  updateCalls: [] as Array<{ id: string; updates: Record<string, unknown> }>,
}));

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder() {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.execute = async () => testState.notifications;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(testState.notifications).then(resolve, reject);
    return builder;
  }

  const dbMock = {
    select: vi.fn((fields?: any) => {
      if (fields && typeof fields === 'object' && 'count' in fields) {
        // Count query
        return {
          from: () => ({
            where: () => ({
              execute: async () => [{ count: testState.notifications.length }],
              then: (resolve: any) => Promise.resolve([{ count: testState.notifications.length }]).then(resolve),
            }),
          }),
        };
      }
      return makeSelectBuilder();
    }),
    update: vi.fn((table: any) => {
      return {
        set: (updates: Record<string, unknown>) => ({
          where: (condition: any) => ({
            returning: async () => {
              const updatedNotifications = testState.notifications.map(n => {
                testState.updateCalls.push({ id: n.id, updates });
                return { ...n, ...updates };
              });
              return updatedNotifications.length > 0 ? [updatedNotifications[0]] : [];
            },
          }),
        }),
      };
    }),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.update.mockClear();
    testState.updateCalls = [];
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ op: 'and', args })),
  eq: vi.fn((field, value) => ({ op: 'eq', field, value })),
  desc: vi.fn((field) => ({ op: 'desc', field })),
  sql: vi.fn((strings, ...values) => ({ op: 'sql', strings, values })),
  inArray: vi.fn((field, values) => ({ op: 'inArray', field, values })),
  gte: vi.fn((field, value) => ({ op: 'gte', field, value })),
  lte: vi.fn((field, value) => ({ op: 'lte', field, value })),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: {
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
    notificationTypeEnum: {
      enumValues: [
        'card_triggered',
        'po_created',
        'po_sent',
        'po_received',
        'stockout_warning',
        'exception_alert',
        'system_alert',
      ] as const,
    },
  },
}));

import { notificationsRouter } from './notifications.routes.js';
import express from 'express';
import request from 'supertest';

const app = express();
app.use(express.json());

// Mock auth middleware
app.use((req, res, next) => {
  req.user = {
    sub: 'user-1',
    tenantId: 'tenant-1',
    email: 'test@example.com',
    role: 'user',
  };
  next();
});

app.use('/notifications', notificationsRouter);

describe('notifications.routes', () => {
  beforeEach(() => {
    testState.notifications = [];
    testState.updateCalls = [];
    resetDbMockCalls();
  });

  describe('GET / — list notifications', () => {
    it('supports types CSV filter', async () => {
      testState.notifications = [
        {
          id: 'notif-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'po_created',
          title: 'PO Created',
          body: 'Test',
          isRead: false,
          readAt: null,
          actionUrl: null,
          metadata: {},
          createdAt: new Date('2026-01-01'),
        },
        {
          id: 'notif-2',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'stockout_warning',
          title: 'Stockout',
          body: 'Test',
          isRead: false,
          readAt: null,
          actionUrl: null,
          metadata: {},
          createdAt: new Date('2026-01-02'),
        },
      ];

      const response = await request(app)
        .get('/notifications?types=po_created,stockout_warning')
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('count');
      expect(response.body).toHaveProperty('totalCount');
      expect(response.body.totalCount).toBe(2);
    });

    it('supports startDate filter', async () => {
      testState.notifications = [
        {
          id: 'notif-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'po_created',
          title: 'PO Created',
          body: 'Test',
          isRead: false,
          readAt: null,
          actionUrl: null,
          metadata: {},
          createdAt: new Date('2026-01-15'),
        },
      ];

      const response = await request(app)
        .get('/notifications?startDate=2026-01-10T00:00:00Z')
        .expect(200);

      expect(response.body.totalCount).toBe(1);
    });

    it('supports endDate filter', async () => {
      testState.notifications = [
        {
          id: 'notif-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'po_created',
          title: 'PO Created',
          body: 'Test',
          isRead: false,
          readAt: null,
          actionUrl: null,
          metadata: {},
          createdAt: new Date('2026-01-05'),
        },
      ];

      const response = await request(app)
        .get('/notifications?endDate=2026-01-10T00:00:00Z')
        .expect(200);

      expect(response.body.totalCount).toBe(1);
    });

    it('supports priority filter', async () => {
      testState.notifications = [
        {
          id: 'notif-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'exception_alert',
          title: 'Alert',
          body: 'Test',
          isRead: false,
          readAt: null,
          actionUrl: null,
          metadata: { priority: 'high' },
          createdAt: new Date('2026-01-01'),
        },
      ];

      const response = await request(app)
        .get('/notifications?priority=high')
        .expect(200);

      expect(response.body.totalCount).toBe(1);
    });

    it('includes totalCount in response', async () => {
      testState.notifications = [
        {
          id: 'notif-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'po_created',
          title: 'PO',
          body: 'Test',
          isRead: false,
          readAt: null,
          actionUrl: null,
          metadata: {},
          createdAt: new Date(),
        },
      ];

      const response = await request(app)
        .get('/notifications')
        .expect(200);

      expect(response.body).toHaveProperty('totalCount');
      expect(response.body.totalCount).toBe(1);
      expect(response.body.count).toBe(1);
    });
  });

  describe('PATCH /:id/unread — mark notification as unread', () => {
    it('marks notification as unread with tenant/user ownership checks', async () => {
      testState.notifications = [
        {
          id: 'notif-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'po_created',
          title: 'PO',
          body: 'Test',
          isRead: true,
          readAt: new Date('2026-01-01'),
          actionUrl: null,
          metadata: {},
          createdAt: new Date(),
        },
      ];

      const response = await request(app)
        .patch('/notifications/notif-1/unread')
        .expect(200);

      expect(response.body.data).toHaveProperty('isRead', false);
      expect(response.body.data).toHaveProperty('readAt', null);
      expect(testState.updateCalls).toHaveLength(1);
      expect(testState.updateCalls[0].updates).toEqual({
        isRead: false,
        readAt: null,
      });
    });

    it('returns 404 for non-existent notification', async () => {
      testState.notifications = [];

      await request(app)
        .patch('/notifications/notif-999/unread')
        .expect(404);
    });
  });

  describe('existing endpoints regression', () => {
    it('PATCH /:id/read still works', async () => {
      testState.notifications = [
        {
          id: 'notif-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'po_created',
          title: 'PO',
          body: 'Test',
          isRead: false,
          readAt: null,
          actionUrl: null,
          metadata: {},
          createdAt: new Date(),
        },
      ];

      const response = await request(app)
        .patch('/notifications/notif-1/read')
        .expect(200);

      expect(response.body.data).toHaveProperty('isRead', true);
      expect(testState.updateCalls).toHaveLength(1);
      expect(testState.updateCalls[0].updates.isRead).toBe(true);
    });

    it('GET /unread-count still works', async () => {
      testState.notifications = [
        {
          id: 'notif-1',
          tenantId: 'tenant-1',
          userId: 'user-1',
          type: 'po_created',
          title: 'PO',
          body: 'Test',
          isRead: false,
          readAt: null,
          actionUrl: null,
          metadata: {},
          createdAt: new Date(),
        },
      ];

      const response = await request(app)
        .get('/notifications/unread-count')
        .expect(200);

      expect(response.body).toHaveProperty('count');
    });
  });
});
