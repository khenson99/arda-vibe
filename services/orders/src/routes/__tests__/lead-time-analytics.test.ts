import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted state & mocks ────────────────────────────────────────────
const TO_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID_A = '22222222-2222-4222-8222-222222222222';
const LINE_ID_B = '33333333-3333-4333-8333-333333333333';
const SOURCE_FAC = '44444444-4444-4444-8444-444444444444';
const DEST_FAC = '55555555-5555-4555-8555-555555555555';
const PART_A = '66666666-6666-4666-8666-666666666666';
const PART_B = '77777777-7777-4777-8777-777777777777';

const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  txSelectResults: [] as unknown[],
  txInsertedLeadTimeRows: [] as Array<Record<string, unknown>>,
}));

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);

  return {
    transferOrders: table('transfer_orders'),
    transferOrderLines: table('transfer_order_lines'),
    leadTimeHistory: table('lead_time_history'),
    auditLog: table('audit_log'),
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
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => builder,
      offset: () => builder,
      orderBy: () => builder,
      groupBy: () => builder,
      execute: async () => result,
      then: (...args: Parameters<Promise<unknown>['then']>) =>
        Promise.resolve(result).then(...args),
    };
    return builder;
  }

  function makeUpdateBuilder() {
    const query = {
      set: () => query,
      where: () => query,
      returning: async () => [],
      execute: async () => undefined,
      then: (...args: Parameters<Promise<void>['then']>) =>
        Promise.resolve(undefined).then(...args),
    };
    return query;
  }

  function makeTx() {
    const tx = {
      select: vi.fn(() => makeSelectBuilder(testState.txSelectResults.shift() ?? [])),
      update: vi.fn(() => makeUpdateBuilder()),
      insert: vi.fn((table: unknown) => ({
        values: (values: unknown) => {
        const tableName = (table as { __table?: string }).__table;
        if (tableName === 'lead_time_history') {
          if (Array.isArray(values)) {
            testState.txInsertedLeadTimeRows.push(...(values as Array<Record<string, unknown>>));
          } else {
            testState.txInsertedLeadTimeRows.push(values as Record<string, unknown>);
          }
        }
        return Promise.resolve();
        },
      })),
    };
    return tx;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.dbSelectResults.shift() ?? [])),
    update: vi.fn(() => makeUpdateBuilder()),
    insert: vi.fn((table: unknown) => ({
      values: async (values: unknown) => {
        const tableName = (table as { __table?: string }).__table;
        if (tableName === 'lead_time_history') {
          if (Array.isArray(values)) {
            testState.txInsertedLeadTimeRows.push(...(values as Array<Record<string, unknown>>));
          } else {
            testState.txInsertedLeadTimeRows.push(values as Record<string, unknown>);
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
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
}));

const writeAuditEntryMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'audit-1', hashChain: 'test-hash', sequenceNumber: 1 }))
);

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: writeAuditEntryMock,
  writeAuditEntries: vi.fn(async () => []),
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

vi.mock('../../services/order-number.service.js', () => ({
  getNextTONumber: vi.fn(async () => 'TO-TEST-0001'),
}));

vi.mock('../../services/transfer-lifecycle.service.js', () => ({
  validateTransferTransition: vi.fn(() => ({ valid: true, autoFields: {} })),
  getValidNextTransferStatuses: vi.fn(() => []),
}));

vi.mock('../../services/source-recommendation.service.js', () => ({
  recommendSources: vi.fn(async () => []),
}));

// ─── Import the router under test ────────────────────────────────────
import { transferOrdersRouter } from '../transfer-orders.routes.js';

// ─── Test helpers ─────────────────────────────────────────────────────
interface RequestUser {
  tenantId: string;
  sub: string;
  role: string;
}

interface RequestWithUser extends express.Request {
  user?: RequestUser;
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as RequestWithUser).user = {
      tenantId: 'tenant-1',
      sub: 'user-1',
      role: 'admin',
    };
    next();
  });
  app.use('/to', transferOrdersRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const error = err as { statusCode?: number; message?: string };
    res.status(error.statusCode ?? 500).json({ error: error.message ?? 'Internal server error' });
  });
  return app;
}

async function getJson<TBody = Record<string, unknown>>(
  app: express.Express,
  path: string
): Promise<{ status: number; body: TBody }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    let body: unknown;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { __raw: text };
    }
    return { status: response.status, body: body as TBody };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function patchJson<TBody = Record<string, unknown>>(
  app: express.Express,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: TBody }> {
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
    const json = (await response.json()) as TBody;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('lead_time_history insert on fully-received transfer order', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txInsertedLeadTimeRows = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
    writeAuditEntryMock.mockClear();
  });

  it('inserts one lead_time_history row per line when fully received', async () => {
    const shippedDate = new Date('2025-01-01T00:00:00Z');

    // DB select: order lookup
    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'in_transit',
          sourceFacilityId: SOURCE_FAC,
          destinationFacilityId: DEST_FAC,
          shippedDate: shippedDate.toISOString(),
        },
      ],
    ];

    // TX selects:
    // 1. line A lookup (for receiveLine[0])
    // 2. line B lookup (for receiveLine[1])
    // 3. updatedLines (all lines, fully received)
    // 4. updatedOrder
    testState.txSelectResults = [
      [{ id: LINE_ID_A, transferOrderId: TO_ID, tenantId: 'tenant-1', partId: PART_A, quantityShipped: 10, quantityReceived: 0 }],
      [{ id: LINE_ID_B, transferOrderId: TO_ID, tenantId: 'tenant-1', partId: PART_B, quantityShipped: 5, quantityReceived: 0 }],
      [
        { id: LINE_ID_A, transferOrderId: TO_ID, tenantId: 'tenant-1', partId: PART_A, quantityShipped: 10, quantityReceived: 10 },
        { id: LINE_ID_B, transferOrderId: TO_ID, tenantId: 'tenant-1', partId: PART_B, quantityShipped: 5, quantityReceived: 5 },
      ],
      [{ id: TO_ID, tenantId: 'tenant-1', toNumber: 'TO-1001', status: 'received' }],
    ];

    const app = createTestApp();
    const response = await patchJson(app, `/to/${TO_ID}/receive`, {
      lines: [
        { lineId: LINE_ID_A, quantityReceived: 10 },
        { lineId: LINE_ID_B, quantityReceived: 5 },
      ],
    });

    expect(response.status).toBe(200);

    // Should have inserted 2 lead time history rows (one per line)
    expect(testState.txInsertedLeadTimeRows).toHaveLength(2);

    // Each row should have the correct fields
    for (const row of testState.txInsertedLeadTimeRows) {
      expect(row).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-1',
          sourceFacilityId: SOURCE_FAC,
          destinationFacilityId: DEST_FAC,
          transferOrderId: TO_ID,
        })
      );
      // leadTimeDays should be a string representation of a number
      expect(typeof row.leadTimeDays).toBe('string');
      expect(Number(row.leadTimeDays)).toBeGreaterThan(0);
      expect(row.shippedAt).toBeInstanceOf(Date);
      expect(row.receivedAt).toBeInstanceOf(Date);
    }

    // Check that each line's partId is represented
    const partIds = testState.txInsertedLeadTimeRows.map((r) => r.partId);
    expect(partIds).toContain(PART_A);
    expect(partIds).toContain(PART_B);
  });

  it('computes leadTimeDays correctly', async () => {
    const shippedDate = new Date('2025-01-01T00:00:00Z');

    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1002',
          status: 'in_transit',
          sourceFacilityId: SOURCE_FAC,
          destinationFacilityId: DEST_FAC,
          shippedDate: shippedDate.toISOString(),
        },
      ],
    ];

    testState.txSelectResults = [
      [{ id: LINE_ID_A, transferOrderId: TO_ID, tenantId: 'tenant-1', partId: PART_A, quantityShipped: 5, quantityReceived: 0 }],
      [
        { id: LINE_ID_A, transferOrderId: TO_ID, tenantId: 'tenant-1', partId: PART_A, quantityShipped: 5, quantityReceived: 5 },
      ],
      [{ id: TO_ID, tenantId: 'tenant-1', toNumber: 'TO-1002', status: 'received' }],
    ];

    const app = createTestApp();
    await patchJson(app, `/to/${TO_ID}/receive`, {
      lines: [{ lineId: LINE_ID_A, quantityReceived: 5 }],
    });

    expect(testState.txInsertedLeadTimeRows).toHaveLength(1);
    const row = testState.txInsertedLeadTimeRows[0];
    const leadTimeDays = Number(row.leadTimeDays);
    // From Jan 1 to now should be many days, just ensure it's positive and finite
    expect(leadTimeDays).toBeGreaterThan(0);
    expect(Number.isFinite(leadTimeDays)).toBe(true);
    // Verify 2-decimal precision format
    expect(row.leadTimeDays).toMatch(/^\d+\.\d{2}$/);
  });

  it('does NOT insert lead_time_history when not fully received', async () => {
    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1003',
          status: 'in_transit',
          sourceFacilityId: SOURCE_FAC,
          destinationFacilityId: DEST_FAC,
          shippedDate: new Date('2025-01-01').toISOString(),
        },
      ],
    ];

    testState.txSelectResults = [
      [{ id: LINE_ID_A, transferOrderId: TO_ID, tenantId: 'tenant-1', partId: PART_A, quantityShipped: 10, quantityReceived: 0 }],
      [
        // only partially received
        { id: LINE_ID_A, transferOrderId: TO_ID, tenantId: 'tenant-1', partId: PART_A, quantityShipped: 10, quantityReceived: 5 },
      ],
      [{ id: TO_ID, tenantId: 'tenant-1', toNumber: 'TO-1003', status: 'in_transit' }],
    ];

    const app = createTestApp();
    const response = await patchJson(app, `/to/${TO_ID}/receive`, {
      lines: [{ lineId: LINE_ID_A, quantityReceived: 5 }],
    });

    expect(response.status).toBe(200);
    // No lead time history inserted when not fully received
    expect(testState.txInsertedLeadTimeRows).toHaveLength(0);
  });
});

describe('GET /lead-times — aggregate statistics', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txInsertedLeadTimeRows = [];
    resetDbMockCalls();
  });

  it('returns aggregate stats in { data } envelope with transferCount field', async () => {
    testState.dbSelectResults = [
      [
        {
          avgLeadTimeDays: 3.45,
          medianLeadTimeDays: 3.0,
          p90LeadTimeDays: 5.2,
          minLeadTimeDays: 1.5,
          maxLeadTimeDays: 7.8,
          transferCount: 42,
        },
      ],
    ];

    const app = createTestApp();
    const response = await getJson<{ data: Record<string, unknown> }>(app, '/to/lead-times');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        avgLeadTimeDays: 3.45,
        medianLeadTimeDays: 3,
        p90LeadTimeDays: 5.2,
        minLeadTimeDays: 1.5,
        maxLeadTimeDays: 7.8,
        transferCount: 42,
      })
    );
  });

  it('returns nulls when no data exists', async () => {
    testState.dbSelectResults = [
      [{
        avgLeadTimeDays: null,
        medianLeadTimeDays: null,
        p90LeadTimeDays: null,
        minLeadTimeDays: null,
        maxLeadTimeDays: null,
        transferCount: 0,
      }], // PostgreSQL aggregate query always returns 1 row with NULL values when no data matches
    ];

    const app = createTestApp();
    const response = await getJson<{ data: Record<string, unknown> }>(app, '/to/lead-times');

    expect(response.status).toBe(200);
    expect(response.body.data.transferCount).toBe(0);
    expect(response.body.data.avgLeadTimeDays).toBeNull();
  });

  it('accepts optional filter params', async () => {
    testState.dbSelectResults = [
      [
        {
          avgLeadTimeDays: 2.5,
          medianLeadTimeDays: 2.0,
          p90LeadTimeDays: 3.0,
          minLeadTimeDays: 1.0,
          maxLeadTimeDays: 4.0,
          transferCount: 10,
        },
      ],
    ];

    const app = createTestApp();
    const response = await getJson<{ data: Record<string, unknown> }>(
      app,
      `/to/lead-times?sourceFacilityId=${SOURCE_FAC}&partId=${PART_A}&fromDate=2025-01-01&toDate=2025-12-31`
    );

    expect(response.status).toBe(200);
    expect(response.body.data.transferCount).toBe(10);
  });

  it('rejects invalid UUID params', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times?sourceFacilityId=not-a-uuid');

    expect(response.status).toBe(400);
  });

  it('rejects invalid fromDate', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times?fromDate=not-a-date');

    expect(response.status).toBe(400);
  });

  it('rejects invalid toDate', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times?toDate=not-a-date');

    expect(response.status).toBe(400);
  });
});

describe('GET /lead-times/trend — time-series buckets', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txInsertedLeadTimeRows = [];
    resetDbMockCalls();
  });

  it('returns trend data with { data, summary } envelope', async () => {
    testState.dbSelectResults = [
      [
        { date: '2025-01-01', avgLeadTimeDays: 3.2, transferCount: 5 },
        { date: '2025-01-08', avgLeadTimeDays: 2.8, transferCount: 7 },
      ],
    ];

    const app = createTestApp();
    const response = await getJson<{ data: Array<{ date: string; avgLeadTimeDays: number; transferCount: number }>; summary: Record<string, unknown> }>(
      app,
      '/to/lead-times/trend'
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data).toEqual([
      { date: '2025-01-01', avgLeadTimeDays: 3.2, transferCount: 5 },
      { date: '2025-01-08', avgLeadTimeDays: 2.8, transferCount: 7 },
    ]);
    expect(response.body.summary).toBeDefined();
    expect(response.body.summary.totalTransfers).toBe(12);
    // Weighted avg: (3.2*5 + 2.8*7)/12 ≈ 2.97
    expect(response.body.summary.overallAvg).toBeCloseTo(2.97, 1);
    expect(response.body.summary.dateRange).toEqual({ from: '2025-01-01', to: '2025-01-08' });
  });

  it('supports day interval', async () => {
    testState.dbSelectResults = [
      [{ date: '2025-01-15', avgLeadTimeDays: 1.5, transferCount: 3 }],
    ];

    const app = createTestApp();
    const response = await getJson<{ data: Array<{ date: string }>; summary: Record<string, unknown> }>(
      app,
      '/to/lead-times/trend?interval=day'
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].date).toBe('2025-01-15');
  });

  it('supports month interval', async () => {
    testState.dbSelectResults = [
      [
        { date: '2025-01-01', avgLeadTimeDays: 4.0, transferCount: 12 },
        { date: '2025-02-01', avgLeadTimeDays: 3.5, transferCount: 8 },
      ],
    ];

    const app = createTestApp();
    const response = await getJson<{ data: Array<unknown> }>(app, '/to/lead-times/trend?interval=month');

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
  });

  it('returns empty data with zero summary when no rows exist', async () => {
    testState.dbSelectResults = [[]];

    const app = createTestApp();
    const response = await getJson<{ data: Array<unknown>; summary: { totalTransfers: number; overallAvg: number; dateRange: { from: string; to: string } } }>(
      app,
      '/to/lead-times/trend'
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.summary.totalTransfers).toBe(0);
    expect(response.body.summary.overallAvg).toBe(0);
    expect(response.body.summary.dateRange).toEqual({ from: '', to: '' });
  });

  it('rejects invalid interval values', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times/trend?interval=quarter');

    expect(response.status).toBe(400);
  });

  it('rejects invalid UUID filter params', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times/trend?partId=bad-uuid');

    expect(response.status).toBe(400);
  });

  it('rejects invalid fromDate', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times/trend?fromDate=not-a-date');

    expect(response.status).toBe(400);
  });

  it('rejects invalid toDate', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times/trend?toDate=not-a-date');

    expect(response.status).toBe(400);
  });

  it('accepts all optional filters', async () => {
    testState.dbSelectResults = [
      [{ date: '2025-03-01', avgLeadTimeDays: 2.1, transferCount: 4 }],
    ];

    const app = createTestApp();
    const response = await getJson<{ data: Array<unknown> }>(
      app,
      `/to/lead-times/trend?interval=month&sourceFacilityId=${SOURCE_FAC}&destinationFacilityId=${DEST_FAC}&partId=${PART_A}&fromDate=2025-01-01&toDate=2025-12-31`
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });
});

describe('invalid date filter rejection', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txInsertedLeadTimeRows = [];
    resetDbMockCalls();
  });

  it('rejects invalid fromDate on lead-times aggregate', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times?fromDate=not-a-date');
    expect(response.status).toBe(400);
  });

  it('rejects invalid toDate on lead-times aggregate', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times?toDate=not-a-date');
    expect(response.status).toBe(400);
  });

  it('rejects invalid fromDate on lead-times trend', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times/trend?fromDate=not-a-date');
    expect(response.status).toBe(400);
  });

  it('rejects invalid toDate on lead-times trend', async () => {
    const app = createTestApp();
    const response = await getJson(app, '/to/lead-times/trend?toDate=not-a-date');
    expect(response.status).toBe(400);
  });
});
