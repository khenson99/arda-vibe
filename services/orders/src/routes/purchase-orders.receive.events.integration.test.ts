import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PO_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';

const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  txSelectResults: [] as unknown[],
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
    query.returning = async () => [];
    query.execute = async () => undefined;
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(undefined).then(resolve, reject);
    return query;
  }

  function makeTx() {
    const tx: any = {};
    tx.select = vi.fn(() => makeSelectBuilder(testState.txSelectResults.shift() ?? []));
    tx.update = vi.fn(() => makeUpdateBuilder());
    tx.insert = vi.fn((table: unknown) => ({
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
    }));
    return tx;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.dbSelectResults.shift() ?? [])),
    update: vi.fn(() => makeUpdateBuilder()),
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
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.update.mockClear();
    dbMock.insert.mockClear();
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
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/order-number.service.js', () => ({
  getNextPONumber: vi.fn(async () => 'PO-TEST-0001'),
}));

import { purchaseOrdersRouter } from './purchase-orders.routes.js';

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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('purchase order receive status change events', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.insertedAuditRows = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
  });

  it('does not publish order.status_changed when receive keeps status unchanged', async () => {
    testState.dbSelectResults = [
      [
        {
          id: PO_ID,
          tenantId: 'tenant-1',
          poNumber: 'PO-1001',
          status: 'partially_received',
        },
      ],
    ];
    testState.txSelectResults = [
      [{ id: LINE_ID, purchaseOrderId: PO_ID, tenantId: 'tenant-1', quantityOrdered: 10 }],
      [{ id: LINE_ID, purchaseOrderId: PO_ID, tenantId: 'tenant-1', quantityOrdered: 10, quantityReceived: 7 }],
      [{ id: PO_ID, tenantId: 'tenant-1', poNumber: 'PO-1001', status: 'partially_received' }],
      [{ id: LINE_ID, lineNumber: 1, quantityOrdered: 10, quantityReceived: 7 }],
    ];

    const app = createTestApp();
    const response = await patchJson(app, `/po/${PO_ID}/receive`, {
      lines: [{ lineId: LINE_ID, quantityReceived: 7 }],
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: PO_ID,
        status: 'partially_received',
      })
    );
    expect(publishMock).not.toHaveBeenCalled();
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'purchase_order.lines_received',
        entityType: 'purchase_order',
        entityId: PO_ID,
      })
    );
  });

  it('publishes order.status_changed when receive transitions to received', async () => {
    testState.dbSelectResults = [
      [
        {
          id: PO_ID,
          tenantId: 'tenant-1',
          poNumber: 'PO-1001',
          status: 'sent',
        },
      ],
    ];
    testState.txSelectResults = [
      [{ id: LINE_ID, purchaseOrderId: PO_ID, tenantId: 'tenant-1', quantityOrdered: 10 }],
      [{ id: LINE_ID, purchaseOrderId: PO_ID, tenantId: 'tenant-1', quantityOrdered: 10, quantityReceived: 10 }],
      [{ id: PO_ID, tenantId: 'tenant-1', poNumber: 'PO-1001', status: 'received' }],
      [{ id: LINE_ID, lineNumber: 1, quantityOrdered: 10, quantityReceived: 10 }],
    ];

    const app = createTestApp();
    const response = await patchJson(app, `/po/${PO_ID}/receive`, {
      lines: [{ lineId: LINE_ID, quantityReceived: 10 }],
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: PO_ID,
        status: 'received',
      })
    );

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.status_changed',
        tenantId: 'tenant-1',
        orderType: 'purchase_order',
        orderId: PO_ID,
        orderNumber: 'PO-1001',
        fromStatus: 'sent',
        toStatus: 'received',
      })
    );
    expect(testState.insertedAuditRows).toHaveLength(2);
    expect(
      testState.insertedAuditRows.find((row) => row.action === 'purchase_order.lines_received')
    ).toEqual(
      expect.objectContaining({
        action: 'purchase_order.lines_received',
        entityType: 'purchase_order',
        entityId: PO_ID,
      })
    );
    expect(
      testState.insertedAuditRows.find((row) => row.action === 'purchase_order.status_changed')
    ).toEqual(
      expect.objectContaining({
        action: 'purchase_order.status_changed',
        entityType: 'purchase_order',
        entityId: PO_ID,
        previousState: { status: 'sent' },
        newState: { status: 'received' },
      })
    );
  });
});
