import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted state & mocks ────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  dbExecuteResults: [] as unknown[],
}));

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => {
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

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.dbSelectResults.shift() ?? [])),
    execute: vi.fn(async () => testState.dbExecuteResults.shift() ?? []),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.execute.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
  lt: vi.fn(() => ({})),
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
 * Queue fill_rate results for N daily buckets (each uses db.execute).
 * Also queues the facility lookup result if needed.
 */
function queueFillRateTrendResults(bucketCount: number, total = 100, full = 92) {
  for (let i = 0; i < bucketCount; i++) {
    testState.dbExecuteResults.push([{ total_receipts: total, full_receipts: full }]);
  }
}

/**
 * Queue supplier_otd results for N daily buckets (each uses db.select).
 */
function queueSupplierOtdTrendResults(bucketCount: number, total = 50, onTime = 46) {
  for (let i = 0; i < bucketCount; i++) {
    testState.dbSelectResults.push([{ totalReceived: total, onTime }]);
  }
}

/**
 * Queue facility lookup result.
 */
function queueFacilityLookup(facilities: Array<{ id: string; name: string }>) {
  testState.dbExecuteResults.push(facilities);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('GET /analytics/kpis/:kpiName/trend', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.dbExecuteResults = [];
    resetDbMockCalls();
  });

  describe('fill_rate trend (30-day window, daily buckets)', () => {
    it('returns daily data points with correct shape', async () => {
      // 30-day window → 30 daily buckets
      queueFillRateTrendResults(30);

      const app = createTestApp();
      const response = await getJson<{
        data: {
          kpiId: string;
          period: number;
          bucket: string;
          dataPoints: Array<{ date: string; value: number }>;
          facilities: Array<unknown>;
        };
      }>(app, '/analytics/kpis/fill_rate/trend?window=30');

      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('fill_rate');
      expect(response.body.data.period).toBe(30);
      expect(response.body.data.bucket).toBe('daily');
      expect(response.body.data.dataPoints.length).toBe(30);
      expect(Array.isArray(response.body.data.facilities)).toBe(true);

      // Each point has date + value
      for (const pt of response.body.data.dataPoints) {
        expect(pt).toHaveProperty('date');
        expect(pt).toHaveProperty('value');
        expect(typeof pt.value).toBe('number');
        // Date should be YYYY-MM-DD format
        expect(pt.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('data points are sorted chronologically', async () => {
      queueFillRateTrendResults(30);

      const app = createTestApp();
      const response = await getJson<{
        data: { dataPoints: Array<{ date: string; value: number }> };
      }>(app, '/analytics/kpis/fill_rate/trend?window=30');

      expect(response.status).toBe(200);
      const dates = response.body.data.dataPoints.map((p) => p.date);
      const sorted = [...dates].sort();
      expect(dates).toEqual(sorted);
    });
  });

  describe('supplier_otd trend (60-day window)', () => {
    it('returns 60 daily data points', async () => {
      // 60-day window → 60 daily buckets (<=60 → daily)
      queueSupplierOtdTrendResults(60);

      const app = createTestApp();
      const response = await getJson<{
        data: {
          kpiId: string;
          period: number;
          bucket: string;
          dataPoints: Array<{ date: string; value: number }>;
        };
      }>(app, '/analytics/kpis/supplier_otd/trend?window=60');

      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('supplier_otd');
      expect(response.body.data.period).toBe(60);
      expect(response.body.data.bucket).toBe('daily');
      expect(response.body.data.dataPoints.length).toBe(60);
    });
  });

  describe('90-day window (weekly buckets)', () => {
    it('returns weekly buckets for 90-day window', async () => {
      // 90 days → >60 → weekly buckets. 90/7 = ~13 buckets
      const expectedBuckets = Math.ceil(90 / 7);
      queueFillRateTrendResults(expectedBuckets);

      const app = createTestApp();
      const response = await getJson<{
        data: {
          kpiId: string;
          period: number;
          bucket: string;
          dataPoints: Array<{ date: string; value: number }>;
        };
      }>(app, '/analytics/kpis/fill_rate/trend?window=90');

      expect(response.status).toBe(200);
      expect(response.body.data.bucket).toBe('weekly');
      expect(response.body.data.period).toBe(90);
      // Should have ~13 weekly buckets
      expect(response.body.data.dataPoints.length).toBeGreaterThanOrEqual(12);
      expect(response.body.data.dataPoints.length).toBeLessThanOrEqual(14);
    });
  });

  describe('custom date range', () => {
    it('accepts explicit startDate/endDate instead of window', async () => {
      // 15 days → 15 daily buckets
      queueSupplierOtdTrendResults(15);

      const app = createTestApp();
      const response = await getJson<{
        data: {
          kpiId: string;
          period: number;
          bucket: string;
          startDate: string;
          endDate: string;
          dataPoints: Array<{ date: string; value: number }>;
        };
      }>(
        app,
        '/analytics/kpis/supplier_otd/trend?startDate=2026-01-01&endDate=2026-01-16',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.startDate).toBe('2026-01-01');
      expect(response.body.data.endDate).toBe('2026-01-16');
      expect(response.body.data.period).toBe(15);
      expect(response.body.data.bucket).toBe('daily');
      expect(response.body.data.dataPoints.length).toBe(15);
    });
  });

  describe('facility overlays', () => {
    it('returns per-facility data points when multiple facilityIds are given', async () => {
      const fac1 = '11111111-1111-4111-8111-111111111111';
      const fac2 = '22222222-2222-4222-8222-222222222222';

      // Facility lookup
      queueFacilityLookup([
        { id: fac1, name: 'Plant Alpha' },
        { id: fac2, name: 'Warehouse Beta' },
      ]);

      // 2 facilities × 30 buckets = 60 fill_rate calls (db.execute)
      queueFillRateTrendResults(60);

      const app = createTestApp();
      const response = await getJson<{
        data: {
          kpiId: string;
          dataPoints: Array<{
            date: string;
            value: number;
            facilityId: string;
            facilityName: string;
          }>;
          facilities: Array<{ id: string; name: string }>;
        };
      }>(
        app,
        `/analytics/kpis/fill_rate/trend?window=30&facilityIds=${fac1},${fac2}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.facilities).toHaveLength(2);
      expect(response.body.data.facilities.map((f) => f.name)).toContain('Plant Alpha');
      expect(response.body.data.facilities.map((f) => f.name)).toContain('Warehouse Beta');

      // 2 facilities × 30 days = 60 data points
      expect(response.body.data.dataPoints).toHaveLength(60);

      // Each point should have facilityId and facilityName
      for (const pt of response.body.data.dataPoints) {
        expect(pt).toHaveProperty('facilityId');
        expect(pt).toHaveProperty('facilityName');
        expect([fac1, fac2]).toContain(pt.facilityId);
      }

      // Should have 30 points per facility
      const fac1Points = response.body.data.dataPoints.filter((p) => p.facilityId === fac1);
      const fac2Points = response.body.data.dataPoints.filter((p) => p.facilityId === fac2);
      expect(fac1Points).toHaveLength(30);
      expect(fac2Points).toHaveLength(30);
    });

    it('returns single aggregate series when one facilityId is given', async () => {
      const fac1 = '11111111-1111-4111-8111-111111111111';

      // 30 daily buckets for single facility
      queueFillRateTrendResults(30);
      // Facility lookup for single facility
      queueFacilityLookup([{ id: fac1, name: 'Plant Alpha' }]);

      const app = createTestApp();
      const response = await getJson<{
        data: {
          dataPoints: Array<{ date: string; value: number; facilityId?: string }>;
          facilities: Array<{ id: string; name: string }>;
        };
      }>(app, `/analytics/kpis/fill_rate/trend?window=30&facilityIds=${fac1}`);

      expect(response.status).toBe(200);
      // Single facility = aggregate series, no facilityId on each point
      expect(response.body.data.dataPoints).toHaveLength(30);
      expect(response.body.data.facilities).toHaveLength(1);
      expect(response.body.data.dataPoints[0].facilityId).toBeUndefined();
    });
  });

  describe('validation errors', () => {
    it('returns 400 for unknown KPI name', async () => {
      const app = createTestApp();
      const response = await getJson<{ error: string }>(
        app,
        '/analytics/kpis/nonexistent_kpi/trend?window=30',
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Unknown KPI');
      expect(response.body.error).toContain('nonexistent_kpi');
      expect(response.body.error).toContain('fill_rate');
    });

    it('returns 400 when endDate is before startDate', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis/fill_rate/trend?startDate=2026-01-31&endDate=2026-01-01',
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for malformed facility IDs', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis/fill_rate/trend?window=30&facilityIds=not-uuid',
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid window value', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis/fill_rate/trend?window=45',
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when only startDate is provided without endDate', async () => {
      const app = createTestApp();
      const response = await getJson<{ error: string }>(
        app,
        '/analytics/kpis/fill_rate/trend?startDate=2026-01-01',
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Both startDate and endDate');
    });

    it('returns 400 when only endDate is provided without startDate', async () => {
      const app = createTestApp();
      const response = await getJson<{ error: string }>(
        app,
        '/analytics/kpis/fill_rate/trend?endDate=2026-01-31',
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Both startDate and endDate');
    });
  });

  describe('default behavior', () => {
    it('defaults to 30-day window when no window or dates are provided', async () => {
      queueFillRateTrendResults(30);

      const app = createTestApp();
      const response = await getJson<{
        data: { period: number; bucket: string; dataPoints: Array<unknown> };
      }>(app, '/analytics/kpis/fill_rate/trend');

      expect(response.status).toBe(200);
      expect(response.body.data.period).toBe(30);
      expect(response.body.data.bucket).toBe('daily');
      expect(response.body.data.dataPoints).toHaveLength(30);
    });
  });

  describe('date bucket edge cases', () => {
    it('handles single-day custom range (1 bucket)', async () => {
      queueFillRateTrendResults(1);

      const app = createTestApp();
      const response = await getJson<{
        data: { period: number; dataPoints: Array<{ date: string; value: number }> };
      }>(
        app,
        '/analytics/kpis/fill_rate/trend?startDate=2026-01-15&endDate=2026-01-16',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.period).toBe(1);
      expect(response.body.data.dataPoints).toHaveLength(1);
      expect(response.body.data.dataPoints[0].date).toBe('2026-01-15');
    });

    it('handles exact 7-day range with daily buckets', async () => {
      queueSupplierOtdTrendResults(7);

      const app = createTestApp();
      const response = await getJson<{
        data: { period: number; bucket: string; dataPoints: Array<unknown> };
      }>(
        app,
        '/analytics/kpis/supplier_otd/trend?startDate=2026-01-01&endDate=2026-01-08',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.period).toBe(7);
      expect(response.body.data.bucket).toBe('daily');
      expect(response.body.data.dataPoints).toHaveLength(7);
    });
  });
});
