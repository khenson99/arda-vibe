import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
}));

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);
  return {
    auditLog: {
      ...table('audit_log'),
      tenantId: 'audit_log.tenant_id',
      userId: 'audit_log.user_id',
      action: 'audit_log.action',
      entityType: 'audit_log.entity_type',
      entityId: 'audit_log.entity_id',
      newState: 'audit_log.new_state',
      timestamp: 'audit_log.timestamp',
    },
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.groupBy = () => builder;
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.selectResults.shift() ?? [])),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
}));

import { auditRouter } from './audit.routes.js';

function createTestApp(withUser = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (withUser) {
      (req as any).user = {
        tenantId: 'tenant-1',
        sub: 'user-1',
      };
    }
    next();
  });
  app.use('/audit', auditRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function getJson(
  app: express.Express,
  path: string
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const text = await response.text();
    let body: Record<string, any>;
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      body = { error: text };
    }
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('audit routes', () => {
  beforeEach(() => {
    testState.selectResults = [];
    resetDbMockCalls();
  });

  it('returns paginated audit rows', async () => {
    testState.selectResults = [
      [{ count: 2 }],
      [
        {
          id: 'a1',
          action: 'purchase_order.created',
          entityType: 'purchase_order',
          entityId: '11111111-1111-4111-8111-111111111111',
        },
        {
          id: 'a2',
          action: 'work_order.status_changed',
          entityType: 'work_order',
          entityId: '22222222-2222-4222-8222-222222222222',
        },
      ],
    ];

    const app = createTestApp(true);
    const response = await getJson(
      app,
      '/audit?page=1&limit=20&action=purchase_order.created'
    );

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      pages: 1,
    });
    expect(response.body.data).toHaveLength(2);
  });

  it('returns audit summary aggregates', async () => {
    testState.selectResults = [
      [{ count: 5 }],
      [
        { action: 'purchase_order.created', count: 2 },
        { action: 'work_order.status_changed', count: 3 },
      ],
      [
        { entityType: 'purchase_order', count: 2 },
        { entityType: 'work_order', count: 3 },
      ],
      [
        { bucket: '2026-02-08', count: 1 },
        { bucket: '2026-02-09', count: 4 },
      ],
      [
        { status: 'sent', count: 3 },
        { status: 'received', count: 2 },
      ],
      [
        { action: 'purchase_order.created', count: 6 },
        { action: 'work_order.status_changed', count: 4 },
      ],
      [{ action: 'work_order.status_changed', count: 2 }],
    ];

    const app = createTestApp(true);
    const response = await getJson(
      app,
      '/audit/summary?granularity=day&dateFrom=2026-02-01T00:00:00.000Z&dateTo=2026-02-09T23:59:59.999Z'
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      total: 5,
      byAction: [
        { action: 'purchase_order.created', count: 2 },
        { action: 'work_order.status_changed', count: 3 },
      ],
      byEntityType: [
        { entityType: 'purchase_order', count: 2 },
        { entityType: 'work_order', count: 3 },
      ],
      byTimeBucket: [
        { bucket: '2026-02-08', count: 1 },
        { bucket: '2026-02-09', count: 4 },
      ],
      topActions: [
        { action: 'work_order.status_changed', count: 3 },
        { action: 'purchase_order.created', count: 2 },
      ],
      statusTransitionFunnel: [
        { status: 'sent', count: 3 },
        { status: 'received', count: 2 },
      ],
      recentAnomalies: [
        {
          action: 'purchase_order.created',
          currentCount: 6,
          previousCount: 0,
          delta: 6,
          percentChange: null,
          severity: 'high',
        },
      ],
    });
    expect(response.body.filters.granularity).toBe('day');
  });

  it('supports week granularity in summary', async () => {
    testState.selectResults = [
      [{ count: 3 }],
      [{ action: 'transfer_order.lines_received', count: 3 }],
      [{ entityType: 'transfer_order', count: 3 }],
      [{ bucket: '2026-W06', count: 3 }],
      [{ status: 'received', count: 3 }],
      [],
      [],
    ];

    const app = createTestApp(true);
    const response = await getJson(app, '/audit/summary?granularity=week');

    expect(response.status).toBe(200);
    expect(response.body.data.byTimeBucket).toEqual([{ bucket: '2026-W06', count: 3 }]);
    expect(response.body.data.topActions).toEqual([
      { action: 'transfer_order.lines_received', count: 3 },
    ]);
    expect(response.body.data.statusTransitionFunnel).toEqual([
      { status: 'received', count: 3 },
    ]);
    expect(response.body.data.recentAnomalies).toEqual([]);
    expect(response.body.filters.granularity).toBe('week');
  });

  it('returns 401 without tenant context', async () => {
    const app = createTestApp(false);
    const response = await getJson(app, '/audit');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for summary without tenant context', async () => {
    const app = createTestApp(false);
    const response = await getJson(app, '/audit/summary');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
  });
});
