import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsubscribeTokenPayload } from '../services/unsubscribe-token.js';

// ─── Hoisted test state ────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  preferences: [] as Array<{
    id: string;
    tenantId: string;
    userId: string;
    notificationType: string;
    channel: string;
    isEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>,
  insertedValues: [] as Array<Record<string, unknown>>,
  updatedSets: [] as Array<{ id: string; updates: Record<string, unknown> }>,
}));

// ─── DB mock ───────────────────────────────────────────────────────

const { dbMock, resetDbMock } = vi.hoisted(() => {
  const dbMock: any = {
    select: vi.fn(() => {
      const builder: any = {};
      builder.from = () => builder;
      builder.where = () => ({
        then: (resolve: any) => Promise.resolve(testState.preferences).then(resolve),
        [Symbol.toStringTag]: 'Promise',
      });
      return builder;
    }),
    update: vi.fn(() => ({
      set: (updates: Record<string, unknown>) => ({
        where: () => {
          if (testState.preferences.length > 0) {
            testState.updatedSets.push({ id: testState.preferences[0].id, updates });
          }
          return Promise.resolve();
        },
      }),
    })),
    insert: vi.fn(() => ({
      values: (vals: Record<string, unknown>) => {
        testState.insertedValues.push(vals);
        return Promise.resolve();
      },
    })),
  };

  const resetDbMock = () => {
    dbMock.select.mockClear();
    dbMock.update.mockClear();
    dbMock.insert.mockClear();
    testState.preferences = [];
    testState.insertedValues = [];
    testState.updatedSets = [];
  };

  return { dbMock, resetDbMock };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  eq: vi.fn((field: unknown, value: unknown) => ({ op: 'eq', field, value })),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: {
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
        'stockout_warning', 'relowisa_recommendation', 'exception_alert',
        'wo_status_change', 'transfer_status_change', 'system_alert',
        'receiving_completed', 'production_hold', 'automation_escalated',
      ] as const,
    },
    notificationChannelEnum: {
      enumValues: ['in_app', 'email', 'webhook'] as const,
    },
  },
}));

vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  config: {
    APP_URL: 'http://localhost:5173',
  },
}));

// ─── Token mock ────────────────────────────────────────────────────

const tokenMock = vi.hoisted(() => ({
  shouldVerify: true as boolean,
  payload: null as UnsubscribeTokenPayload | null,
  error: null as Error | null,
}));

vi.mock('../services/unsubscribe-token.js', () => ({
  verifyUnsubscribeToken: vi.fn((token: string) => {
    if (tokenMock.error) {
      throw tokenMock.error;
    }
    if (!tokenMock.shouldVerify || !tokenMock.payload) {
      throw new Error('Invalid token');
    }
    return tokenMock.payload;
  }),
}));

// ─── Test app setup ────────────────────────────────────────────────

import { unsubscribeRouter } from './unsubscribe.routes.js';
import express from 'express';
import request from 'supertest';

const app = express();
app.use(express.json());
app.use('/notifications', unsubscribeRouter);

// ─── Tests ─────────────────────────────────────────────────────────

describe('unsubscribe.routes', () => {
  const validPayload: UnsubscribeTokenPayload = {
    userId: 'user-123',
    tenantId: 'tenant-456',
    notificationType: 'po_created',
    channel: 'email',
  };

  beforeEach(() => {
    resetDbMock();
    tokenMock.shouldVerify = true;
    tokenMock.payload = validPayload;
    tokenMock.error = null;
  });

  describe('GET /notifications/unsubscribe', () => {
    it('returns 400 when token is missing', async () => {
      const res = await request(app)
        .get('/notifications/unsubscribe')
        .expect(400);

      expect(res.text).toContain('No unsubscribe token was provided');
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('returns 400 with error HTML for expired token', async () => {
      tokenMock.error = new Error('jwt expired');
      tokenMock.shouldVerify = false;

      const res = await request(app)
        .get('/notifications/unsubscribe?token=expired-token')
        .expect(400);

      expect(res.text).toContain('invalid or has expired');
      expect(res.headers['content-type']).toContain('text/html');
      // No DB calls should be made
      expect(dbMock.select).not.toHaveBeenCalled();
      expect(dbMock.update).not.toHaveBeenCalled();
      expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('returns 400 with error HTML for tampered token', async () => {
      tokenMock.error = new Error('invalid signature');
      tokenMock.shouldVerify = false;

      const res = await request(app)
        .get('/notifications/unsubscribe?token=tampered-token')
        .expect(400);

      expect(res.text).toContain('invalid or has expired');
      expect(res.headers['content-type']).toContain('text/html');
      expect(dbMock.select).not.toHaveBeenCalled();
    });

    it('disables existing enabled email preference and returns 200 HTML', async () => {
      testState.preferences = [
        {
          id: 'pref-1',
          tenantId: 'tenant-456',
          userId: 'user-123',
          notificationType: 'po_created',
          channel: 'email',
          isEnabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const res = await request(app)
        .get('/notifications/unsubscribe?token=valid-token')
        .expect(200);

      expect(res.text).toContain('Unsubscribed');
      expect(res.text).toContain('po created');
      expect(res.headers['content-type']).toContain('text/html');
      expect(dbMock.update).toHaveBeenCalled();
      expect(testState.updatedSets).toHaveLength(1);
      expect(testState.updatedSets[0].updates).toMatchObject({ isEnabled: false });
    });

    it('is idempotent — repeated clicks on already-disabled preference return 200', async () => {
      testState.preferences = [
        {
          id: 'pref-1',
          tenantId: 'tenant-456',
          userId: 'user-123',
          notificationType: 'po_created',
          channel: 'email',
          isEnabled: false, // already disabled
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const res = await request(app)
        .get('/notifications/unsubscribe?token=valid-token')
        .expect(200);

      expect(res.text).toContain('Unsubscribed');
      // Should NOT call update since already disabled
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('inserts new disabled preference when none exists', async () => {
      // Empty preferences — no existing row
      testState.preferences = [];

      const res = await request(app)
        .get('/notifications/unsubscribe?token=valid-token')
        .expect(200);

      expect(res.text).toContain('Unsubscribed');
      expect(dbMock.insert).toHaveBeenCalled();
      expect(testState.insertedValues).toHaveLength(1);
      expect(testState.insertedValues[0]).toMatchObject({
        tenantId: 'tenant-456',
        userId: 'user-123',
        notificationType: 'po_created',
        channel: 'email',
        isEnabled: false,
      });
    });
  });

  describe('POST /notifications/unsubscribe (RFC 8058 One-Click)', () => {
    it('disables email preference with valid token in query string', async () => {
      testState.preferences = [
        {
          id: 'pref-1',
          tenantId: 'tenant-456',
          userId: 'user-123',
          notificationType: 'po_created',
          channel: 'email',
          isEnabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const res = await request(app)
        .post('/notifications/unsubscribe?token=valid-token')
        .expect(200);

      expect(res.text).toContain('Unsubscribed');
      expect(dbMock.update).toHaveBeenCalled();
    });

    it('disables email preference with valid token in body', async () => {
      testState.preferences = [
        {
          id: 'pref-1',
          tenantId: 'tenant-456',
          userId: 'user-123',
          notificationType: 'po_created',
          channel: 'email',
          isEnabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const res = await request(app)
        .post('/notifications/unsubscribe')
        .send({ token: 'valid-token' })
        .expect(200);

      expect(res.text).toContain('Unsubscribed');
      expect(dbMock.update).toHaveBeenCalled();
    });

    it('returns 400 for invalid token in POST', async () => {
      tokenMock.error = new Error('invalid signature');
      tokenMock.shouldVerify = false;

      const res = await request(app)
        .post('/notifications/unsubscribe')
        .send({ token: 'bad-token' })
        .expect(400);

      expect(res.text).toContain('invalid or has expired');
      expect(dbMock.select).not.toHaveBeenCalled();
    });

    it('returns 400 when no token is provided in POST', async () => {
      const res = await request(app)
        .post('/notifications/unsubscribe')
        .send({})
        .expect(400);

      expect(res.text).toContain('No unsubscribe token was provided');
    });
  });
});
