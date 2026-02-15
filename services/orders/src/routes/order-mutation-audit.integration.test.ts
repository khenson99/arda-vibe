import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PART_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TO_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TO_LINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  txSelectResults: [] as unknown[],
  insertedAuditRows: [] as Array<Record<string, unknown>>,
}));

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);

  return {
    purchaseOrders: table('purchase_orders'),
    purchaseOrderLines: table('purchase_order_lines'),
    transferOrders: table('transfer_orders'),
    transferOrderLines: table('transfer_order_lines'),
    auditLog: table('audit_log'),
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => builder;
    builder.orderBy = () => builder;
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  function makeUpdateBuilder() {
    const query: any = {};
    query.set = () => query;
    query.where = () => query;
    query.execute = async () => undefined;
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(undefined).then(resolve, reject);
    query.returning = async () => [];
    return query;
  }

  function makeTx() {
    const tx: any = {};
    tx.select = vi.fn(() => makeSelectBuilder(testState.txSelectResults.shift() ?? []));
    tx.update = vi.fn(() => makeUpdateBuilder());
    tx.insert = vi.fn((table: unknown) => ({
      values: (values: unknown) => {
        const tableName = (table as { __table?: string }).__table;

        if (tableName === 'audit_log') {
          if (Array.isArray(values)) {
            testState.insertedAuditRows.push(...(values as Array<Record<string, unknown>>));
          } else {
            testState.insertedAuditRows.push(values as Record<string, unknown>);
          }
          return {
            execute: async () => undefined,
            then: (
              resolve: (value: unknown) => unknown,
              reject?: (reason: unknown) => unknown
            ) => Promise.resolve(undefined).then(resolve, reject),
          };
        }

        if (tableName === 'purchase_order_lines') {
          const row = values as Record<string, unknown>;
          const created = {
            id: 'pol-1',
            tenantId: row.tenantId,
            purchaseOrderId: row.purchaseOrderId,
            partId: row.partId,
            lineNumber: row.lineNumber,
            quantityOrdered: row.quantityOrdered,
            quantityReceived: 0,
            unitCost: row.unitCost,
            lineTotal: row.lineTotal,
            notes: row.notes,
          };
          return {
            returning: async () => [created],
          };
        }

        return {
          returning: async () => [],
          execute: async () => undefined,
        };
      },
    }));
    return tx;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.dbSelectResults.shift() ?? [])),
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.transaction.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

const { getEventBusMock, publishMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { getEventBusMock, publishMock };
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
  getNextPONumber: vi.fn(async () => 'PO-TEST-0001'),
  getNextWONumber: vi.fn(async () => 'WO-TEST-0001'),
  getNextTONumber: vi.fn(async () => 'TO-TEST-0001'),
}));

import { purchaseOrdersRouter } from './purchase-orders.routes.js';
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
  app.use('/to', transferOrdersRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function requestJson(
  app: express.Express,
  method: 'POST' | 'PATCH',
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
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.7',
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

describe('order mutation audit logging', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.insertedAuditRows = [];
    resetDbMockCalls();
    getEventBusMock.mockClear();
    publishMock.mockClear();
  });

  it('logs purchase_order.line_added on POST /po/:id/lines', async () => {
    testState.txSelectResults = [
      [
        {
          id: PO_ID,
          tenantId: 'tenant-1',
          poNumber: 'PO-1001',
          status: 'draft',
          totalAmount: '25.00',
        },
      ],
      [
        {
          id: 'existing-line',
          partId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          kanbanCardId: null,
          lineNumber: 1,
          quantityOrdered: 2,
          unitCost: '10.00',
          notes: null,
        },
        {
          id: 'pol-1',
          partId: PART_ID,
          kanbanCardId: null,
          lineNumber: 2,
          quantityOrdered: 3,
          unitCost: '5.00',
          notes: null,
        },
      ],
    ];

    const app = createTestApp();
    const response = await requestJson(app, 'POST', `/po/${PO_ID}/lines`, {
      partId: PART_ID,
      lineNumber: 2,
      quantityOrdered: 3,
      unitCost: 5,
    });

    expect(response.status).toBe(201);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'purchase_order.line_added',
        entityType: 'purchase_order',
        entityId: PO_ID,
        previousState: { totalAmount: '25.00' },
        newState: expect.objectContaining({
          lineNumber: 2,
          partId: PART_ID,
          quantityOrdered: 3,
          totalAmount: '35.00',
        }),
      })
    );
  });

  it('logs transfer_order.lines_shipped on PATCH /to/:id/ship', async () => {
    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'picking',
        },
      ],
    ];
    testState.txSelectResults = [
      [
        {
          id: TO_LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityRequested: 10,
          quantityShipped: 2,
        },
      ],
      [
        {
          id: TO_LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityRequested: 10,
          quantityShipped: 7,
          quantityReceived: 0,
        },
      ],
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'picking',
        },
      ],
    ];

    const app = createTestApp();
    const response = await requestJson(app, 'PATCH', `/to/${TO_ID}/ship`, {
      lines: [{ lineId: TO_LINE_ID, quantityShipped: 7 }],
    });

    expect(response.status).toBe(200);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'transfer_order.lines_shipped',
        entityType: 'transfer_order',
        entityId: TO_ID,
        previousState: expect.objectContaining({
          status: 'picking',
        }),
        newState: expect.objectContaining({
          status: 'picking',
        }),
      })
    );
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('logs status audit and emits status event when PATCH /to/:id/ship fully ships order', async () => {
    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'picking',
        },
      ],
    ];
    testState.txSelectResults = [
      [
        {
          id: TO_LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityRequested: 10,
          quantityShipped: 0,
        },
      ],
      [
        {
          id: TO_LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityRequested: 10,
          quantityShipped: 10,
          quantityReceived: 0,
        },
      ],
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'shipped',
        },
      ],
    ];

    const app = createTestApp();
    const response = await requestJson(app, 'PATCH', `/to/${TO_ID}/ship`, {
      lines: [{ lineId: TO_LINE_ID, quantityShipped: 10 }],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: TO_ID,
        status: 'shipped',
      })
    );

    expect(testState.insertedAuditRows).toHaveLength(2);
    expect(
      testState.insertedAuditRows.find((row) => row.action === 'transfer_order.status_changed')
    ).toEqual(
      expect.objectContaining({
        action: 'transfer_order.status_changed',
        entityType: 'transfer_order',
        entityId: TO_ID,
        previousState: { status: 'picking' },
        newState: { status: 'shipped' },
      })
    );
    expect(
      testState.insertedAuditRows.find((row) => row.action === 'transfer_order.lines_shipped')
    ).toEqual(
      expect.objectContaining({
        action: 'transfer_order.lines_shipped',
        entityType: 'transfer_order',
        entityId: TO_ID,
      })
    );

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.status_changed',
        orderType: 'transfer_order',
        orderId: TO_ID,
        fromStatus: 'picking',
        toStatus: 'shipped',
      })
    );
  });
});
