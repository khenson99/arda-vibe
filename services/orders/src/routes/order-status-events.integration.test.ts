import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
  updateReturningResults: [] as unknown[],
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
    woStatusEnum: {
      enumValues: ['draft', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'] as const,
    },
    transferStatusEnum: {
      enumValues: [
        'draft',
        'requested',
        'approved',
        'picking',
        'shipped',
        'in_transit',
        'received',
        'closed',
        'cancelled',
      ] as const,
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
    builder.innerJoin = () => builder;
    builder.groupBy = () => builder;
    builder.for = () => builder;
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
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(dbMock)),
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
import { workOrdersRouter } from './work-orders.routes.js';
import { transferOrdersRouter } from './transfer-orders.routes.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      tenantId: 'tenant-1',
      sub: 'user-1',
      role: 'procurement_manager',
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

describe('status endpoints publish order.status_changed', () => {
  beforeEach(() => {
    testState.selectResults = [];
    testState.updateReturningResults = [];
    testState.insertedAuditRows = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
  });

  it('purchase order status transition publishes order.status_changed', async () => {
    testState.selectResults = [
      [{ id: 'po-1', tenantId: 'tenant-1', poNumber: 'PO-1001', status: 'approved' }],
      [{ id: 'po-1', tenantId: 'tenant-1', poNumber: 'PO-1001', status: 'sent' }],
    ];

    const app = createTestApp();
    const response = await patchJson(app, '/po/po-1/status', { status: 'sent' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: 'po-1',
        status: 'sent',
      })
    );

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.status_changed',
        tenantId: 'tenant-1',
        orderType: 'purchase_order',
        orderId: 'po-1',
        orderNumber: 'PO-1001',
        fromStatus: 'approved',
        toStatus: 'sent',
      })
    );
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'purchase_order.status_changed',
        entityType: 'purchase_order',
        entityId: 'po-1',
        previousState: { status: 'approved' },
        newState: { status: 'sent' },
      })
    );
  });

  it('work order status transition publishes order.status_changed', async () => {
    testState.selectResults = [
      [
        {
          id: 'wo-1',
          tenantId: 'tenant-1',
          woNumber: 'WO-1001',
          status: 'scheduled',
          quantityToProduce: 25,
          quantityProduced: 0,
          actualStartDate: null,
        },
      ],
      [
        {
          id: 'wo-1',
          tenantId: 'tenant-1',
          woNumber: 'WO-1001',
          status: 'in_progress',
          quantityToProduce: 25,
          quantityProduced: 0,
        },
      ],
      [],
    ];
    testState.updateReturningResults = [[{ id: 'wo-1', status: 'in_progress' }]];

    const app = createTestApp();
    const response = await patchJson(app, '/wo/wo-1/status', { status: 'in_progress' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: 'wo-1',
        status: 'in_progress',
      })
    );
    expect(response.body.routingSteps).toEqual([]);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.status_changed',
        tenantId: 'tenant-1',
        orderType: 'work_order',
        orderId: 'wo-1',
        orderNumber: 'WO-1001',
        fromStatus: 'scheduled',
        toStatus: 'in_progress',
      })
    );
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'work_order.status_changed',
        entityType: 'work_order',
        entityId: 'wo-1',
        previousState: { status: 'scheduled' },
        newState: { status: 'in_progress' },
      })
    );
  });

  it('transfer order status transition publishes order.status_changed', async () => {
    testState.selectResults = [
      [{ id: 'to-1', tenantId: 'tenant-1', toNumber: 'TO-1001', status: 'approved' }],
      [{ id: 'line-1', transferOrderId: 'to-1', partId: 'part-1' }],
    ];
    testState.updateReturningResults = [[{ id: 'to-1', tenantId: 'tenant-1', status: 'picking' }]];

    const app = createTestApp();
    const response = await patchJson(app, '/to/to-1/status', { status: 'picking' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: 'to-1',
        status: 'picking',
      })
    );
    expect(response.body.data.lines).toHaveLength(1);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.status_changed',
        tenantId: 'tenant-1',
        orderType: 'transfer_order',
        orderId: 'to-1',
        orderNumber: 'TO-1001',
        fromStatus: 'approved',
        toStatus: 'picking',
      })
    );
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'transfer_order.status_changed',
        entityType: 'transfer_order',
        entityId: 'to-1',
        previousState: { status: 'approved' },
        newState: { status: 'picking' },
      })
    );
  });
});
