import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted state & mocks ────────────────────────────────────────────
const testState = vi.hoisted(() => ({
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
  const dbMock = {
    select: vi.fn(() => {
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: () => builder,
        offset: () => builder,
        orderBy: () => builder,
        groupBy: () => builder,
        innerJoin: () => builder,
        leftJoin: () => builder,
        execute: async () => [],
        then: (...args: Parameters<Promise<unknown>['then']>) =>
          Promise.resolve([]).then(...args),
      };
      return builder;
    }),
    execute: vi.fn(async () => testState.dbExecuteResults.shift() ?? []),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.execute.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => {
  // Build a sql tagged-template mock that preserves the template strings for assertion
  const sqlFn = (...args: unknown[]) => {
    // Tagged template call: first arg is the string array
    const strings = Array.isArray(args[0]) ? (args[0] as string[]).join('??') : '';
    return {
      __sqlStrings: strings,
      raw: vi.fn(() => ({})),
      toQuery: () => ({ sql: '', params: [] }),
      append: () => ({}),
    };
  };
  return {
    eq: vi.fn(() => ({})),
    and: vi.fn(() => ({})),
    sql: Object.assign(vi.fn(sqlFn), { raw: vi.fn(() => ({})) }),
    gte: vi.fn(() => ({})),
    lte: vi.fn(() => ({})),
    lt: vi.fn(() => ({})),
    isNotNull: vi.fn(() => ({})),
  };
});

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

// ─── Drilldown response type ──────────────────────────────────────────
interface DrilldownResponse {
  data: {
    kpiId: string;
    columns: string[];
    rows: Record<string, unknown>[];
    totalRows: number;
    page: number;
    limit: number;
  };
}

// ─── Fixture helpers ──────────────────────────────────────────────────

function queueDrilldownResults(countTotal: number, rows: Record<string, unknown>[]) {
  // Count query result
  testState.dbExecuteResults.push([{ total: countTotal }]);
  // Data query result
  testState.dbExecuteResults.push(rows);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('GET /analytics/kpis/:kpiName/drilldown', () => {
  beforeEach(() => {
    testState.dbExecuteResults = [];
    resetDbMockCalls();
  });

  describe('fill_rate drilldown', () => {
    it('returns correct columns and row shape', async () => {
      const rows = [
        {
          receiptNumber: 'REC-001',
          orderType: 'purchase_order',
          orderId: 'po-1',
          totalLines: 5,
          fullLines: 4,
          fillRatePercent: 80,
          facilityName: 'Warehouse A',
          createdAt: '2026-01-15T10:00:00Z',
        },
      ];
      queueDrilldownResults(1, rows);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('fill_rate');
      expect(response.body.data.columns).toContain('receiptNumber');
      expect(response.body.data.columns).toContain('fillRatePercent');
      expect(response.body.data.columns).toContain('facilityName');
      expect(response.body.data.totalRows).toBe(1);
      expect(response.body.data.rows).toHaveLength(1);
      expect(response.body.data.rows[0]).toHaveProperty('receiptNumber', 'REC-001');
    });
  });

  describe('supplier_otd drilldown', () => {
    it('returns correct columns including varianceDays', async () => {
      const rows = [
        {
          poNumber: 'PO-001',
          supplierName: 'Acme Corp',
          expectedDeliveryDate: '2026-01-10T00:00:00Z',
          actualDeliveryDate: '2026-01-12T00:00:00Z',
          isOnTime: false,
          varianceDays: 2.0,
          facilityName: 'Plant 1',
        },
      ];
      queueDrilldownResults(1, rows);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/supplier_otd/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('supplier_otd');
      expect(response.body.data.columns).toContain('varianceDays');
      expect(response.body.data.columns).toContain('isOnTime');
      expect(response.body.data.rows[0]).toHaveProperty('varianceDays', 2.0);
    });
  });

  describe('stockout_count drilldown', () => {
    it('returns correct columns including daysAtZero', async () => {
      const rows = [
        {
          partNumber: 'PART-001',
          partName: 'Widget A',
          facilityName: 'Warehouse B',
          qtyOnHand: -5,
          reorderPoint: 10,
          daysAtZero: 3.5,
        },
      ];
      queueDrilldownResults(1, rows);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/stockout_count/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('stockout_count');
      expect(response.body.data.columns).toContain('daysAtZero');
      expect(response.body.data.columns).toContain('partNumber');
      expect(response.body.data.rows[0]).toHaveProperty('daysAtZero', 3.5);
    });
  });

  describe('avg_cycle_time drilldown', () => {
    it('returns correct columns including cycleTimeHours', async () => {
      const rows = [
        {
          woNumber: 'WO-001',
          partName: 'Assembly X',
          facilityName: 'Plant 2',
          actualStartDate: '2026-01-10T08:00:00Z',
          actualEndDate: '2026-01-11T16:00:00Z',
          cycleTimeHours: 32.0,
        },
      ];
      queueDrilldownResults(1, rows);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/avg_cycle_time/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('avg_cycle_time');
      expect(response.body.data.columns).toContain('cycleTimeHours');
      expect(response.body.data.columns).toContain('woNumber');
      expect(response.body.data.rows[0]).toHaveProperty('cycleTimeHours', 32.0);
    });
  });

  describe('order_accuracy drilldown', () => {
    it('returns correct columns including isAccurate', async () => {
      const rows = [
        {
          receiptNumber: 'REC-002',
          partNumber: 'PART-002',
          partName: 'Bolt B',
          quantityExpected: 100,
          quantityAccepted: 95,
          quantityDamaged: 3,
          quantityRejected: 2,
          isAccurate: false,
          createdAt: '2026-01-20T14:00:00Z',
        },
      ];
      queueDrilldownResults(1, rows);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/order_accuracy/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('order_accuracy');
      expect(response.body.data.columns).toContain('isAccurate');
      expect(response.body.data.columns).toContain('quantityDamaged');
      expect(response.body.data.columns).toContain('quantityRejected');
      expect(response.body.data.rows[0]).toHaveProperty('isAccurate', false);
    });
  });

  describe('pagination', () => {
    it('returns page and limit in response', async () => {
      queueDrilldownResults(50, [
        { receiptNumber: 'REC-001', orderType: 'purchase_order', orderId: 'po-1', totalLines: 5, fullLines: 5, fillRatePercent: 100, facilityName: 'WH', createdAt: '2026-01-15T00:00:00Z' },
      ]);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31&page=2&limit=10',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.page).toBe(2);
      expect(response.body.data.limit).toBe(10);
      expect(response.body.data.totalRows).toBe(50);
    });

    it('defaults to page 1 and limit 25', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.page).toBe(1);
      expect(response.body.data.limit).toBe(25);
    });

    it('caps limit at 100', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31&limit=500',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.limit).toBe(100);
    });
  });

  describe('sorting', () => {
    it('accepts sort and sortDir query params', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31&sort=receiptNumber&sortDir=asc',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('fill_rate');
    });
  });

  describe('facility filter', () => {
    it('accepts facilityIds parameter', async () => {
      queueDrilldownResults(0, []);

      const fac1 = '11111111-1111-4111-8111-111111111111';
      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        `/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31&facilityIds=${fac1}`,
      );

      expect(response.status).toBe(200);
    });
  });

  describe('row-count consistency', () => {
    it('totalRows matches count query, rows matches page size', async () => {
      const pageRows = Array.from({ length: 5 }, (_, i) => ({
        receiptNumber: `REC-${i + 1}`,
        orderType: 'purchase_order',
        orderId: `po-${i + 1}`,
        totalLines: 10,
        fullLines: 8,
        fillRatePercent: 80,
        facilityName: 'WH',
        createdAt: '2026-01-15T00:00:00Z',
      }));
      queueDrilldownResults(42, pageRows);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31&limit=5',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.totalRows).toBe(42);
      expect(response.body.data.rows).toHaveLength(5);
    });
  });

  describe('empty dataset', () => {
    it('returns empty rows with zero totalRows', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.totalRows).toBe(0);
      expect(response.body.data.rows).toHaveLength(0);
      expect(response.body.data.columns).toEqual(expect.arrayContaining(['receiptNumber', 'fillRatePercent']));
    });
  });

  describe('all five KPIs return correct column keys', () => {
    const kpis = [
      { kpi: 'fill_rate', expectedColumns: ['receiptNumber', 'fillRatePercent', 'facilityName'] },
      { kpi: 'supplier_otd', expectedColumns: ['poNumber', 'varianceDays', 'isOnTime'] },
      { kpi: 'stockout_count', expectedColumns: ['partNumber', 'daysAtZero', 'qtyOnHand'] },
      { kpi: 'avg_cycle_time', expectedColumns: ['woNumber', 'cycleTimeHours', 'actualStartDate'] },
      { kpi: 'order_accuracy', expectedColumns: ['receiptNumber', 'isAccurate', 'quantityDamaged'] },
    ];

    for (const { kpi, expectedColumns } of kpis) {
      it(`${kpi} returns stable column keys`, async () => {
        queueDrilldownResults(0, []);

        const app = createTestApp();
        const response = await getJson<DrilldownResponse>(
          app,
          `/analytics/kpis/${kpi}/drilldown?startDate=2026-01-01&endDate=2026-01-31`,
        );

        expect(response.status).toBe(200);
        for (const col of expectedColumns) {
          expect(response.body.data.columns).toContain(col);
        }
      });
    }
  });

  describe('tenant isolation in SQL joins', () => {
    it('fill_rate drilldown passes tenantId in all cross-schema joins', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      // The data query is the second db.execute call (first is count query)
      expect(dbMock.execute).toHaveBeenCalledTimes(2);
      const dataQueryCall = dbMock.execute.mock.calls[1][0] as { __sqlStrings?: string };
      const queryStr = dataQueryCall.__sqlStrings ?? '';

      // Verify tenant isolation on purchase_orders join
      expect(queryStr).toContain('po.tenant_id');
      // Verify tenant isolation on facilities joins
      expect(queryStr).toContain('f_po.tenant_id');
      expect(queryStr).toContain('f_to.tenant_id');
      // Verify tenant isolation on transfer_orders join
      expect(queryStr).toContain('tro.tenant_id');
    });

    it('supplier_otd drilldown passes tenantId on supplier and facility joins', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/supplier_otd/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(dbMock.execute).toHaveBeenCalledTimes(2);
      const dataQueryCall = dbMock.execute.mock.calls[1][0] as { __sqlStrings?: string };
      const queryStr = dataQueryCall.__sqlStrings ?? '';

      expect(queryStr).toContain('s.tenant_id');
      expect(queryStr).toContain('f.tenant_id');
    });

    it('stockout_count drilldown passes tenantId on parts and facilities joins', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/stockout_count/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(dbMock.execute).toHaveBeenCalledTimes(2);
      const dataQueryCall = dbMock.execute.mock.calls[1][0] as { __sqlStrings?: string };
      const queryStr = dataQueryCall.__sqlStrings ?? '';

      expect(queryStr).toContain('p.tenant_id');
      expect(queryStr).toContain('f.tenant_id');
    });

    it('avg_cycle_time drilldown passes tenantId on parts and facilities joins', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/avg_cycle_time/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(dbMock.execute).toHaveBeenCalledTimes(2);
      const dataQueryCall = dbMock.execute.mock.calls[1][0] as { __sqlStrings?: string };
      const queryStr = dataQueryCall.__sqlStrings ?? '';

      expect(queryStr).toContain('p.tenant_id');
      expect(queryStr).toContain('f.tenant_id');
    });

    it('order_accuracy drilldown passes tenantId on parts join', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/order_accuracy/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(dbMock.execute).toHaveBeenCalledTimes(2);
      const dataQueryCall = dbMock.execute.mock.calls[1][0] as { __sqlStrings?: string };
      const queryStr = dataQueryCall.__sqlStrings ?? '';

      expect(queryStr).toContain('p.tenant_id');
    });
  });

  describe('fill_rate transfer-order facility resolution', () => {
    it('resolves facilityName for transfer_order rows via destination facility', async () => {
      const rows = [
        {
          receiptNumber: 'REC-TO-001',
          orderType: 'transfer_order',
          orderId: 'to-1',
          totalLines: 3,
          fullLines: 3,
          fillRatePercent: 100,
          facilityName: 'Destination Warehouse',
          createdAt: '2026-01-15T10:00:00Z',
        },
      ];
      queueDrilldownResults(1, rows);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.rows[0]).toHaveProperty('orderType', 'transfer_order');
      expect(response.body.data.rows[0]).toHaveProperty('facilityName', 'Destination Warehouse');

      // Verify the SQL includes the transfer-order join path
      const dataQueryCall = dbMock.execute.mock.calls[1][0] as { __sqlStrings?: string };
      const queryStr = dataQueryCall.__sqlStrings ?? '';
      expect(queryStr).toContain('transfer_orders');
      expect(queryStr).toContain('destination_facility_id');
    });

    it('query includes COALESCE across both facility join paths', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      const dataQueryCall = dbMock.execute.mock.calls[1][0] as { __sqlStrings?: string };
      const queryStr = dataQueryCall.__sqlStrings ?? '';
      // Should COALESCE from both PO facility and TO facility
      expect(queryStr).toContain('f_po.name');
      expect(queryStr).toContain('f_to.name');
    });
  });

  describe('sort contract consistency', () => {
    it('accepts orderId as a valid sort column for fill_rate', async () => {
      queueDrilldownResults(0, []);

      const app = createTestApp();
      const response = await getJson<DrilldownResponse>(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31&sort=orderId&sortDir=asc',
      );

      // orderId is in DRILLDOWN_COLUMNS.fill_rate, so it should be accepted without fallback
      expect(response.status).toBe(200);
      expect(response.body.data.kpiId).toBe('fill_rate');
    });
  });

  describe('validation errors', () => {
    it('returns 400 for unknown KPI name', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis/unknown_kpi/drilldown?startDate=2026-01-01&endDate=2026-01-31',
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when startDate is missing', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis/fill_rate/drilldown?endDate=2026-01-31',
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 when endDate is before startDate', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-31&endDate=2026-01-01',
      );

      expect(response.status).toBe(400);
    });

    it('returns 400 for malformed facility IDs', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        '/analytics/kpis/fill_rate/drilldown?startDate=2026-01-01&endDate=2026-01-31&facilityIds=not-uuid',
      );

      expect(response.status).toBe(400);
    });
  });
});
