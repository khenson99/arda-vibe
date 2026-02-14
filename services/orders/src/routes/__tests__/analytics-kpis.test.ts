import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted state & mocks ────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  dbExecuteResults: [] as unknown[],
}));

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => {
    // Create column-like objects for Drizzle ORM compatibility
    const cols = new Proxy(
      { __table: name },
      {
        get(_target, prop) {
          if (prop === '__table') return name;
          return { name: prop, table: name };
        },
      },
    );
    return cols;
  };

  return {
    purchaseOrders: table('purchase_orders'),
    purchaseOrderLines: table('purchase_order_lines'),
    workOrders: table('work_orders'),
    transferOrders: table('transfer_orders'),
    receipts: table('receipts'),
    receiptLines: table('receipt_lines'),
    receivingExceptions: table('receiving_exceptions'),
    inventoryLedger: table('inventory_ledger'),
    leadTimeHistory: table('lead_time_history'),
    auditLog: table('audit_log'),
    facilities: table('facilities'),
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
      innerJoin: () => builder,
      leftJoin: () => builder,
      execute: async () => result,
      then: (...args: Parameters<Promise<unknown>['then']>) =>
        Promise.resolve(result).then(...args),
    };
    return builder;
  }

  const executeResults: unknown[] = [];

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.dbSelectResults.shift() ?? [])),
    execute: vi.fn(async () => testState.dbExecuteResults.shift() ?? []),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.execute.mockClear();
  };

  return { dbMock, resetDbMockCalls, executeResults };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
  isNotNull: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'test', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ─── Import the router under test ────────────────────────────────────
import { analyticsRouter } from '../analytics.routes.js';

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
      role: 'tenant_admin',
    };
    next();
  });
  app.use('/analytics', analyticsRouter);
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const error = err as { statusCode?: number; message?: string };
      res.status(error.statusCode ?? 500).json({ error: error.message ?? 'Internal server error' });
    },
  );
  return app;
}

async function getJson<TBody = Record<string, unknown>>(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: TBody }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
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

// ─── Fixture helpers ──────────────────────────────────────────────────

/**
 * Queue up the 5 pairs of (current, previous) db results for the 5 KPIs,
 * plus 5 * 12 sparkline bucket calls.
 *
 * The computeAllKpis function runs:
 *   For each of 5 KPIs concurrently:
 *     - computeFn(current range)     — 1 db call
 *     - computeFn(previous range)    — 1 db call
 *     - sparkline(12 buckets)        — 12 db calls
 *
 * Total: 5 * 14 = 70 db calls
 *
 * fill_rate and order_accuracy use db.execute (raw SQL).
 * supplier_otd, stockout_count, avg_cycle_time use db.select.
 *
 * Because of Promise.all concurrency, call order is NOT guaranteed.
 * We need to provide enough results for all calls.
 */
function queueFillRateResults(
  currentTotal: number,
  currentFull: number,
  previousTotal: number,
  previousFull: number,
) {
  // Current period
  testState.dbExecuteResults.push([{ total_receipts: currentTotal, full_receipts: currentFull }]);
  // Previous period
  testState.dbExecuteResults.push([{ total_receipts: previousTotal, full_receipts: previousFull }]);
  // 12 sparkline buckets
  for (let i = 0; i < 12; i++) {
    testState.dbExecuteResults.push([{ total_receipts: currentTotal, full_receipts: currentFull }]);
  }
}

function queueSupplierOtdResults(
  currentTotal: number,
  currentOnTime: number,
  previousTotal: number,
  previousOnTime: number,
) {
  // Current period
  testState.dbSelectResults.push([{ totalReceived: currentTotal, onTime: currentOnTime }]);
  // Previous period
  testState.dbSelectResults.push([{ totalReceived: previousTotal, onTime: previousOnTime }]);
  // 12 sparkline buckets
  for (let i = 0; i < 12; i++) {
    testState.dbSelectResults.push([{ totalReceived: currentTotal, onTime: currentOnTime }]);
  }
}

function queueStockoutResults(
  currentCount: number,
  previousCount: number,
) {
  // Current period
  testState.dbSelectResults.push([{ stockouts: currentCount }]);
  // Previous period
  testState.dbSelectResults.push([{ stockouts: previousCount }]);
  // 12 sparkline buckets
  for (let i = 0; i < 12; i++) {
    testState.dbSelectResults.push([{ stockouts: currentCount }]);
  }
}

function queueCycleTimeResults(
  currentAvg: number | null,
  previousAvg: number | null,
) {
  // Current period
  testState.dbSelectResults.push([{ avgHours: currentAvg }]);
  // Previous period
  testState.dbSelectResults.push([{ avgHours: previousAvg }]);
  // 12 sparkline buckets
  for (let i = 0; i < 12; i++) {
    testState.dbSelectResults.push([{ avgHours: currentAvg }]);
  }
}

function queueOrderAccuracyResults(
  currentTotal: number,
  currentAccurate: number,
  previousTotal: number,
  previousAccurate: number,
) {
  // Current period
  testState.dbExecuteResults.push([{ total_lines: currentTotal, accurate_lines: currentAccurate }]);
  // Previous period
  testState.dbExecuteResults.push([{ total_lines: previousTotal, accurate_lines: previousAccurate }]);
  // 12 sparkline buckets
  for (let i = 0; i < 12; i++) {
    testState.dbExecuteResults.push([{ total_lines: currentTotal, accurate_lines: currentAccurate }]);
  }
}

function queueAllKpiResults() {
  // Note: Due to Promise.all concurrency, we queue results that will be consumed
  // by db.execute and db.select in the order they are called.
  // fill_rate uses db.execute (3 groups: current, previous, 12 sparkline)
  queueFillRateResults(100, 92, 80, 70);
  // supplier_otd uses db.select
  queueSupplierOtdResults(50, 46, 40, 34);
  // stockout_count uses db.select
  queueStockoutResults(3, 5);
  // avg_cycle_time uses db.select
  queueCycleTimeResults(48.5, 52.3);
  // order_accuracy uses db.execute
  queueOrderAccuracyResults(200, 194, 150, 141);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('GET /analytics/kpis', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.dbExecuteResults = [];
    resetDbMockCalls();
  });

  it('returns all five KPIs in { data } envelope', async () => {
    queueAllKpiResults();

    const app = createTestApp();
    const response = await getJson<{ data: Array<Record<string, unknown>> }>(
      app,
      '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data).toHaveLength(5);

    const kpiIds = response.body.data.map((k) => k.kpiId);
    expect(kpiIds).toContain('fill_rate');
    expect(kpiIds).toContain('supplier_otd');
    expect(kpiIds).toContain('stockout_count');
    expect(kpiIds).toContain('avg_cycle_time');
    expect(kpiIds).toContain('order_accuracy');
  });

  it('each KPI has required shape: value, previousValue, delta, deltaPercent, threshold, sparklineData', async () => {
    queueAllKpiResults();

    const app = createTestApp();
    const response = await getJson<{ data: Array<Record<string, unknown>> }>(
      app,
      '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
    );

    expect(response.status).toBe(200);

    for (const kpi of response.body.data) {
      expect(kpi).toHaveProperty('kpiId');
      expect(kpi).toHaveProperty('value');
      expect(kpi).toHaveProperty('previousValue');
      expect(kpi).toHaveProperty('delta');
      expect(kpi).toHaveProperty('deltaPercent');
      expect(kpi).toHaveProperty('threshold');
      expect(kpi).toHaveProperty('unit');
      expect(kpi).toHaveProperty('isNegativeGood');
      expect(kpi).toHaveProperty('sparklineData');
      expect(kpi).toHaveProperty('lastUpdated');

      expect(typeof kpi.value).toBe('number');
      expect(typeof kpi.previousValue).toBe('number');
      expect(typeof kpi.delta).toBe('number');
      expect(typeof kpi.deltaPercent).toBe('number');
      expect(Array.isArray(kpi.sparklineData)).toBe(true);
      expect((kpi.sparklineData as Array<unknown>)).toHaveLength(12);
    }
  });

  it('sparkline data points have timestamp and value', async () => {
    queueAllKpiResults();

    const app = createTestApp();
    const response = await getJson<{ data: Array<{ sparklineData: Array<{ timestamp: string; value: number }> }> }>(
      app,
      '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
    );

    expect(response.status).toBe(200);

    const firstKpi = response.body.data[0];
    for (const point of firstKpi.sparklineData) {
      expect(point).toHaveProperty('timestamp');
      expect(point).toHaveProperty('value');
      expect(typeof point.timestamp).toBe('string');
      expect(typeof point.value).toBe('number');
      // Timestamp should be a valid ISO date string
      expect(isNaN(Date.parse(point.timestamp))).toBe(false);
    }
  });

  describe('fill_rate KPI', () => {
    it('computes fill rate correctly: 92/100 = 92%', async () => {
      queueAllKpiResults();

      const app = createTestApp();
      const response = await getJson<{ data: Array<{ kpiId: string; value: number; previousValue: number; threshold: number | null; unit: string }> }>(
        app,
        '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
      );

      const fillRate = response.body.data.find((k) => k.kpiId === 'fill_rate');
      expect(fillRate).toBeDefined();
      expect(fillRate!.value).toBe(92);
      expect(fillRate!.previousValue).toBe(87.5); // 70/80 = 87.5%
      expect(fillRate!.threshold).toBe(95);
      expect(fillRate!.unit).toBe('%');
    });
  });

  describe('supplier_otd KPI', () => {
    it('computes supplier OTD correctly: 46/50 = 92%', async () => {
      queueAllKpiResults();

      const app = createTestApp();
      const response = await getJson<{ data: Array<{ kpiId: string; value: number; previousValue: number; threshold: number | null }> }>(
        app,
        '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
      );

      const otd = response.body.data.find((k) => k.kpiId === 'supplier_otd');
      expect(otd).toBeDefined();
      expect(otd!.value).toBe(92);
      expect(otd!.previousValue).toBe(85); // 34/40 = 85%
      expect(otd!.threshold).toBe(90);
    });
  });

  describe('stockout_count KPI', () => {
    it('computes stockout count correctly', async () => {
      queueAllKpiResults();

      const app = createTestApp();
      const response = await getJson<{ data: Array<{ kpiId: string; value: number; previousValue: number; isNegativeGood: boolean }> }>(
        app,
        '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
      );

      const stockout = response.body.data.find((k) => k.kpiId === 'stockout_count');
      expect(stockout).toBeDefined();
      expect(stockout!.value).toBe(3);
      expect(stockout!.previousValue).toBe(5);
      expect(stockout!.isNegativeGood).toBe(true);
      // delta for isNegativeGood: -(current - previous) = -(3-5) = 2 (improvement)
      expect(stockout!).toHaveProperty('delta', 2);
    });
  });

  describe('avg_cycle_time KPI', () => {
    it('computes avg cycle time correctly: 48.5 hours', async () => {
      queueAllKpiResults();

      const app = createTestApp();
      const response = await getJson<{ data: Array<{ kpiId: string; value: number; previousValue: number; unit: string }> }>(
        app,
        '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
      );

      const cycleTime = response.body.data.find((k) => k.kpiId === 'avg_cycle_time');
      expect(cycleTime).toBeDefined();
      expect(cycleTime!.value).toBe(48.5);
      expect(cycleTime!.previousValue).toBe(52.3);
      expect(cycleTime!.unit).toBe('hrs');
    });
  });

  describe('order_accuracy KPI', () => {
    it('computes order accuracy correctly: 194/200 = 97%', async () => {
      queueAllKpiResults();

      const app = createTestApp();
      const response = await getJson<{ data: Array<{ kpiId: string; value: number; previousValue: number }> }>(
        app,
        '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
      );

      const accuracy = response.body.data.find((k) => k.kpiId === 'order_accuracy');
      expect(accuracy).toBeDefined();
      expect(accuracy!.value).toBe(97);
      expect(accuracy!.previousValue).toBe(94); // 141/150 = 94%
    });
  });

  describe('previous-period comparison', () => {
    it('uses an equivalent shifted date window for previous period', async () => {
      queueAllKpiResults();

      const app = createTestApp();
      const response = await getJson<{ data: Array<{ kpiId: string; value: number; previousValue: number; deltaPercent: number }> }>(
        app,
        '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);

      // All KPIs should have a previousValue computed from the shifted window
      for (const kpi of response.body.data) {
        expect(typeof kpi.previousValue).toBe('number');
        expect(typeof kpi.deltaPercent).toBe('number');
      }

      // Verify specific delta calculations
      const fillRate = response.body.data.find((k) => k.kpiId === 'fill_rate')!;
      // Current: 92%, Previous: 87.5%, delta = 92 - 87.5 = 4.5
      // deltaPercent = (4.5 / 87.5) * 100 = 5.14%
      expect(fillRate.deltaPercent).toBeCloseTo(5.14, 1);
    });
  });

  describe('facility filter', () => {
    it('accepts optional facilityIds filter', async () => {
      queueAllKpiResults();

      const fac1 = '11111111-1111-4111-8111-111111111111';
      const fac2 = '22222222-2222-4222-8222-222222222222';

      const app = createTestApp();
      const response = await getJson<{ data: Array<unknown> }>(
        app,
        `/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31&facilityIds=${fac1},${fac2}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(5);
    });
  });

  describe('validation errors', () => {
    it('returns 400 when startDate is missing', async () => {
      const app = createTestApp();
      const response = await getJson(app, '/analytics/kpis?endDate=2026-01-31');

      expect(response.status).toBe(400);
    });

    it('returns 400 when endDate is missing', async () => {
      const app = createTestApp();
      const response = await getJson(app, '/analytics/kpis?startDate=2026-01-01');

      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid startDate', async () => {
      const app = createTestApp();
      const response = await getJson(app, '/analytics/kpis?startDate=not-a-date&endDate=2026-01-31');

      expect(response.status).toBe(400);
    });

    it('returns 400 when endDate is before startDate', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis?startDate=2026-01-31&endDate=2026-01-01',
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for malformed facility IDs', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31&facilityIds=not-uuid,also-bad',
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when startDate equals endDate', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis?startDate=2026-01-15&endDate=2026-01-15',
      );

      expect(response.status).toBe(400);
    });
  });

  describe('zero data handling', () => {
    it('returns 0 values when no data exists', async () => {
      // fill_rate: 0 receipts
      testState.dbExecuteResults.push([{ total_receipts: 0, full_receipts: 0 }]);
      testState.dbExecuteResults.push([{ total_receipts: 0, full_receipts: 0 }]);
      for (let i = 0; i < 12; i++) {
        testState.dbExecuteResults.push([{ total_receipts: 0, full_receipts: 0 }]);
      }

      // supplier_otd: 0 POs
      testState.dbSelectResults.push([{ totalReceived: 0, onTime: 0 }]);
      testState.dbSelectResults.push([{ totalReceived: 0, onTime: 0 }]);
      for (let i = 0; i < 12; i++) {
        testState.dbSelectResults.push([{ totalReceived: 0, onTime: 0 }]);
      }

      // stockout_count: 0 stockouts
      testState.dbSelectResults.push([{ stockouts: 0 }]);
      testState.dbSelectResults.push([{ stockouts: 0 }]);
      for (let i = 0; i < 12; i++) {
        testState.dbSelectResults.push([{ stockouts: 0 }]);
      }

      // avg_cycle_time: null (no completed WOs)
      testState.dbSelectResults.push([{ avgHours: null }]);
      testState.dbSelectResults.push([{ avgHours: null }]);
      for (let i = 0; i < 12; i++) {
        testState.dbSelectResults.push([{ avgHours: null }]);
      }

      // order_accuracy: 0 lines
      testState.dbExecuteResults.push([{ total_lines: 0, accurate_lines: 0 }]);
      testState.dbExecuteResults.push([{ total_lines: 0, accurate_lines: 0 }]);
      for (let i = 0; i < 12; i++) {
        testState.dbExecuteResults.push([{ total_lines: 0, accurate_lines: 0 }]);
      }

      const app = createTestApp();
      const response = await getJson<{ data: Array<{ kpiId: string; value: number }> }>(
        app,
        '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      for (const kpi of response.body.data) {
        expect(kpi.value).toBe(0);
      }
    });
  });

  describe('thresholds and metadata', () => {
    it('returns correct threshold and unit for each KPI', async () => {
      queueAllKpiResults();

      const app = createTestApp();
      const response = await getJson<{
        data: Array<{ kpiId: string; threshold: number | null; unit: string; isNegativeGood: boolean }>;
      }>(app, '/analytics/kpis?startDate=2026-01-01&endDate=2026-01-31');

      const findKpi = (id: string) => response.body.data.find((k) => k.kpiId === id)!;

      expect(findKpi('fill_rate').threshold).toBe(95);
      expect(findKpi('fill_rate').unit).toBe('%');
      expect(findKpi('fill_rate').isNegativeGood).toBe(false);

      expect(findKpi('supplier_otd').threshold).toBe(90);
      expect(findKpi('supplier_otd').unit).toBe('%');

      expect(findKpi('stockout_count').threshold).toBe(5);
      expect(findKpi('stockout_count').unit).toBe('incidents');
      expect(findKpi('stockout_count').isNegativeGood).toBe(true);

      expect(findKpi('avg_cycle_time').threshold).toBe(72);
      expect(findKpi('avg_cycle_time').unit).toBe('hrs');
      expect(findKpi('avg_cycle_time').isNegativeGood).toBe(true);

      expect(findKpi('order_accuracy').threshold).toBe(98);
      expect(findKpi('order_accuracy').unit).toBe('%');
    });
  });
});
