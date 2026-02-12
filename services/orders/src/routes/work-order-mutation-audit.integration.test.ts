import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WO_ID = 'f1111111-1111-4111-8111-111111111111';
const ROUTING_ID = 'f2222222-2222-4222-8222-222222222222';

const testState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
  updateReturningResults: [] as unknown[],
  insertedAuditRows: [] as Array<Record<string, unknown>>,
}));

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);

  return {
    workOrders: table('work_orders'),
    workOrderRoutings: table('work_order_routings'),
    auditLog: table('audit_log'),
    woStatusEnum: {
      enumValues: ['draft', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'] as const,
    },
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.orderBy = () => builder;
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.selectResults.shift() ?? [])),
    update: vi.fn(() => {
      const query: any = {};
      query.set = () => query;
      query.where = () => query;
      query.returning = async () => testState.updateReturningResults.shift() ?? [];
      query.execute = async () => undefined;
      query.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(undefined).then(resolve, reject);
      return query;
    }),
    insert: vi.fn((table: unknown) => ({
      values: async (values: unknown) => {
        const tableName = (table as { __table?: string }).__table;
        if (tableName === 'audit_log') {
          if (Array.isArray(values)) {
            testState.insertedAuditRows.push(...(values as Array<Record<string, unknown>>));
          } else {
            testState.insertedAuditRows.push(values as Record<string, unknown>);
          }
        }
      },
    })),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.update.mockClear();
    dbMock.insert.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
}));

const writeAuditEntryMock = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.insertedAuditRows.push(entry);
    return { id: `audit-${testState.insertedAuditRows.length}`, hashChain: 'test-hash', sequenceNumber: testState.insertedAuditRows.length };
  })
);

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: writeAuditEntryMock,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({ publish: vi.fn(async () => undefined) })),
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/order-number.service.js', () => ({
  getNextWONumber: vi.fn(async () => 'WO-TEST-0001'),
}));

import { workOrdersRouter } from './work-orders.routes.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      tenantId: 'tenant-1',
      sub: 'user-1',
    };
    next();
  });
  app.use('/wo', workOrdersRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function patchJson(
  app: express.Express,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.9',
        'user-agent': 'vitest-agent',
      },
      body: JSON.stringify(body),
    });

    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('work-order mutation audit logging', () => {
  beforeEach(() => {
    testState.selectResults = [];
    testState.updateReturningResults = [];
    testState.insertedAuditRows = [];
    resetDbMockCalls();
  });

  it('logs work_order.routing_updated on PATCH /wo/:id/routings/:routingId', async () => {
    testState.selectResults = [
      [{ id: WO_ID, tenantId: 'tenant-1', woNumber: 'WO-1001' }],
      [
        {
          id: ROUTING_ID,
          workOrderId: WO_ID,
          tenantId: 'tenant-1',
          status: 'pending',
          actualMinutes: null,
          notes: null,
          stepNumber: 1,
          operationName: 'Cut',
          startedAt: null,
          completedAt: null,
        },
      ],
    ];
    testState.updateReturningResults = [
      [
        {
          id: ROUTING_ID,
          workOrderId: WO_ID,
          tenantId: 'tenant-1',
          status: 'in_progress',
          actualMinutes: 12,
          notes: 'started',
          stepNumber: 1,
          operationName: 'Cut',
        },
      ],
    ];

    const app = createTestApp();
    const response = await patchJson(app, `/wo/${WO_ID}/routings/${ROUTING_ID}`, {
      status: 'in_progress',
      actualMinutes: 12,
      notes: 'started',
    });

    expect(response.status).toBe(200);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'work_order.routing_updated',
        entityType: 'work_order_routing',
        entityId: ROUTING_ID,
        previousState: expect.objectContaining({ status: 'pending' }),
        newState: expect.objectContaining({ status: 'in_progress', actualMinutes: 12 }),
      })
    );
  });

  it('logs work_order.production_reported on PATCH /wo/:id/production', async () => {
    testState.selectResults = [
      [
        {
          id: WO_ID,
          tenantId: 'tenant-1',
          woNumber: 'WO-1001',
          quantityProduced: 10,
          quantityRejected: 1,
        },
      ],
      [
        {
          id: WO_ID,
          tenantId: 'tenant-1',
          woNumber: 'WO-1001',
          quantityProduced: 16,
          quantityRejected: 2,
        },
      ],
      [],
    ];
    testState.updateReturningResults = [
      [
        {
          id: WO_ID,
          tenantId: 'tenant-1',
          woNumber: 'WO-1001',
          quantityProduced: 16,
          quantityRejected: 2,
        },
      ],
    ];

    const app = createTestApp();
    const response = await patchJson(app, `/wo/${WO_ID}/production`, {
      quantityProduced: 6,
      quantityRejected: 1,
    });

    expect(response.status).toBe(200);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'work_order.production_reported',
        entityType: 'work_order',
        entityId: WO_ID,
        previousState: { quantityProduced: 10, quantityRejected: 1 },
        newState: { quantityProduced: 16, quantityRejected: 2 },
      })
    );
  });
});
