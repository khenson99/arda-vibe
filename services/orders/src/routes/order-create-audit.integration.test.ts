import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  insertedAuditRows: [] as Array<Record<string, unknown>>,
}));

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);

  return {
    purchaseOrders: table('purchase_orders'),
    purchaseOrderLines: table('purchase_order_lines'),
    workOrders: table('work_orders'),
    workOrderRoutings: table('work_order_routings'),
    transferOrders: table('transfer_orders'),
    transferOrderLines: table('transfer_order_lines'),
    auditLog: table('audit_log'),
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function queryResult<T>(result: T) {
    return {
      execute: async () => result,
      then: (
        resolve: (value: T) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
      returning: async () => result,
    };
  }

  function makeTx() {
    const tx: any = {};
    tx.insert = vi.fn((table: unknown) => ({
      values: (values: unknown) => {
        const tableName = (table as { __table?: string }).__table;

        if (tableName === 'audit_log') {
          if (Array.isArray(values)) {
            testState.insertedAuditRows.push(...(values as Array<Record<string, unknown>>));
          } else {
            testState.insertedAuditRows.push(values as Record<string, unknown>);
          }
          return queryResult(undefined);
        }

        if (tableName === 'purchase_orders') {
          const row = values as Record<string, unknown>;
          return queryResult([{ id: 'po-1', poNumber: row.poNumber, status: row.status }]);
        }

        if (tableName === 'purchase_order_lines') {
          const rows = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
          return queryResult(
            rows.map((row, index) => ({
              id: `pol-${index + 1}`,
              ...row,
            }))
          );
        }

        if (tableName === 'work_orders') {
          const row = values as Record<string, unknown>;
          return queryResult([
            {
              id: 'wo-1',
              woNumber: row.woNumber,
              status: row.status,
              quantityToProduce: row.quantityToProduce,
            },
          ]);
        }

        if (tableName === 'work_order_routings') {
          const rows = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
          return queryResult(
            rows.map((row, index) => ({
              id: `wor-${index + 1}`,
              ...row,
            }))
          );
        }

        if (tableName === 'transfer_orders') {
          const row = values as Record<string, unknown>;
          return queryResult([{ id: 'to-1', toNumber: row.toNumber, status: row.status }]);
        }

        if (tableName === 'transfer_order_lines') {
          const rows = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
          return queryResult(
            rows.map((row, index) => ({
              id: `tol-${index + 1}`,
              ...row,
            }))
          );
        }

        return queryResult([]);
      },
    }));

    return tx;
  }

  const dbMock = {
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
  };

  const resetDbMockCalls = () => {
    dbMock.transaction.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.insertedAuditRows.push(entry);
    return { id: 'audit-1', hashChain: 'test-hash', sequenceNumber: 1 };
  }),
  writeAuditEntries: vi.fn(async (_dbOrTx: unknown, _tenantId: string, entries: Array<Record<string, unknown>>) => {
    testState.insertedAuditRows.push(...entries);
    return entries.map((_, i) => ({ id: `audit-${i + 1}`, hashChain: `test-hash-${i}`, sequenceNumber: i + 1 }));
  }),
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
  publishKpiRefreshed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@arda/observability', () => ({
  getCorrelationId: vi.fn(() => 'test-corr-id'),
  correlationMiddleware: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/order-number.service.js', () => ({
  getNextPONumber: vi.fn(async () => 'PO-1001'),
  getNextWONumber: vi.fn(async () => 'WO-1001'),
  getNextTONumber: vi.fn(async () => 'TO-1001'),
}));

import { purchaseOrdersRouter } from './purchase-orders.routes.js';
import { workOrdersRouter } from './work-orders.routes.js';
import { transferOrdersRouter } from './transfer-orders.routes.js';

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
  app.use('/po', purchaseOrdersRouter);
  app.use('/wo', workOrdersRouter);
  app.use('/to', transferOrdersRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function postJson(
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
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.5',
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

describe('create endpoints write audit rows', () => {
  beforeEach(() => {
    testState.insertedAuditRows = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
  });

  it('POST /po writes purchase_order.created audit row', async () => {
    const app = createTestApp();
    const response = await postJson(app, '/po', {
      supplierId: '11111111-1111-4111-8111-111111111111',
      facilityId: '22222222-2222-4222-8222-222222222222',
      expectedDeliveryDate: new Date().toISOString(),
      lines: [
        {
          partId: '33333333-3333-4333-8333-333333333333',
          lineNumber: 1,
          quantityOrdered: 4,
          unitCost: 12.5,
        },
      ],
    });

    expect(response.status).toBe(201);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: 'po-1',
        previousState: null,
      })
    );
  });

  it('POST /wo writes work_order.created audit row', async () => {
    const app = createTestApp();
    const response = await postJson(app, '/wo', {
      partId: '44444444-4444-4444-8444-444444444444',
      facilityId: '55555555-5555-4555-8555-555555555555',
      quantityToProduce: 25,
      routingSteps: [
        {
          workCenterId: '66666666-6666-4666-8666-666666666666',
          stepNumber: 1,
          operationName: 'Cut',
          estimatedMinutes: 15,
        },
      ],
    });

    expect(response.status).toBe(201);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'work_order.created',
        entityType: 'work_order',
        entityId: 'wo-1',
        previousState: null,
      })
    );
  });

  it('POST /to writes transfer_order.created audit row', async () => {
    const app = createTestApp();
    const response = await postJson(app, '/to', {
      sourceFacilityId: '77777777-7777-4777-8777-777777777777',
      destinationFacilityId: '88888888-8888-4888-8888-888888888888',
      lines: [
        {
          partId: '99999999-9999-4999-8999-999999999999',
          quantityRequested: 6,
        },
      ],
    });

    expect(response.status).toBe(201);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'transfer_order.created',
        entityType: 'transfer_order',
        entityId: 'to-1',
        previousState: null,
      })
    );
  });
});
