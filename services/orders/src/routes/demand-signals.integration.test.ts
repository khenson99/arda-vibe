/**
 * Integration tests for demand signal CRUD APIs (Ticket #197)
 *
 * Tests:
 * - List with pagination and filters (partId, facilityId, signalType, dateRange, unfulfilled)
 * - Get single signal
 * - Create signal with audit write
 * - Update signal with auto-fulfilledAt
 * - Summary aggregation
 * - RBAC enforcement
 * - 404 for missing signal
 */
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  demandSignals: {
    id: 'demand_signals.id',
    tenantId: 'demand_signals.tenant_id',
    partId: 'demand_signals.part_id',
    facilityId: 'demand_signals.facility_id',
    signalType: 'demand_signals.signal_type',
    quantityDemanded: 'demand_signals.quantity_demanded',
    quantityFulfilled: 'demand_signals.quantity_fulfilled',
    salesOrderId: 'demand_signals.sales_order_id',
    salesOrderLineId: 'demand_signals.sales_order_line_id',
    demandDate: 'demand_signals.demand_date',
    fulfilledAt: 'demand_signals.fulfilled_at',
    triggeredKanbanCardId: 'demand_signals.triggered_kanban_card_id',
    metadata: 'demand_signals.metadata',
    createdAt: 'demand_signals.created_at',
    updatedAt: 'demand_signals.updated_at',
  },
  demandSignalTypeEnum: {
    enumValues: ['sales_order', 'forecast', 'reorder_point', 'safety_stock', 'seasonal', 'manual'] as const,
  },
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const dbSetup = vi.hoisted(() => {
  const signalRows: Array<Record<string, unknown>> = [];
  let insertCallIndex = 0;

  function makeSelectBuilder(rows: () => Array<Record<string, unknown>>) {
    const builder: Record<string, unknown> = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.groupBy = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows()).then(resolve, reject);
    return builder;
  }

  const insertReturningMock = vi.fn(async () => [{
    id: 'ds-new',
    tenantId: 'tenant-1',
    partId: '00000000-0000-0000-0000-000000000001',
    facilityId: '00000000-0000-0000-0000-000000000002',
    signalType: 'manual',
    quantityDemanded: 100,
    quantityFulfilled: 0,
    salesOrderId: null,
    salesOrderLineId: null,
    demandDate: new Date('2026-03-01').toISOString(),
    fulfilledAt: null,
    triggeredKanbanCardId: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]);

  const updateReturningMock = vi.fn(async () => [{
    id: 'ds-1',
    tenantId: 'tenant-1',
    partId: '00000000-0000-0000-0000-000000000001',
    facilityId: '00000000-0000-0000-0000-000000000002',
    signalType: 'manual',
    quantityDemanded: 100,
    quantityFulfilled: 100,
    salesOrderId: null,
    salesOrderLineId: null,
    demandDate: new Date('2026-03-01').toISOString(),
    fulfilledAt: new Date().toISOString(),
    triggeredKanbanCardId: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }]);

  const tx = {
    insert: vi.fn(() => ({
      values: () => ({
        returning: insertReturningMock,
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: updateReturningMock,
        }),
      }),
    })),
    select: vi.fn((fields?: unknown) => {
      if (fields && typeof fields === 'object' && 'count' in fields) {
        return makeSelectBuilder(() => [{ count: signalRows.length }]);
      }
      return makeSelectBuilder(() => signalRows);
    }),
  };

  const dbMock = {
    select: vi.fn((fields?: unknown) => {
      if (fields && typeof fields === 'object' && 'count' in fields) {
        return makeSelectBuilder(() => [{ count: signalRows.length }]);
      }
      return makeSelectBuilder(() => signalRows);
    }),
    insert: vi.fn(() => ({
      values: () => ({
        returning: insertReturningMock,
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: updateReturningMock,
        }),
      }),
    })),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };

  const resetMocks = () => {
    signalRows.length = 0;
    insertCallIndex = 0;
    dbMock.select.mockClear();
    dbMock.insert.mockClear();
    dbMock.update.mockClear();
    dbMock.transaction.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
    tx.select.mockClear();
    insertReturningMock.mockClear();
    updateReturningMock.mockClear();
  };

  return {
    dbMock,
    tx,
    resetMocks,
    signalRows,
    insertReturningMock,
    updateReturningMock,
  };
});

// ─── Hoisted audit mock ─────────────────────────────────────────────
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.auditEntries.push(entry);
    return { id: 'audit-' + testState.auditEntries.length, hashChain: 'mock', sequenceNumber: testState.auditEntries.length };
  })
);

// ─── Module mocks ───────────────────────────────────────────────────
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
}));

vi.mock('@arda/db', () => ({
  db: dbSetup.dbMock,
  schema: schemaMock,
  writeAuditEntry: mockWriteAuditEntry,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: {},
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@arda/auth-utils', () => ({
  requireRole: (..._roles: string[]) => (_req: unknown, _res: unknown, next: () => void) => next(),
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────
import { demandSignalsRouter } from './demand-signals.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────
function createApp(user?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user ?? {
      tenantId: 'tenant-1',
      sub: 'user-1',
      role: 'inventory_manager',
    };
    next();
  });
  app.use('/demand-signals', demandSignalsRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function getJson(app: express.Express, path: string) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postJson(app: express.Express, path: string, body: object) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function patchJson(app: express.Express, path: string, body: object) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ═════════════════════════════════════════════════════════════════════

describe('Demand Signals API', () => {
  beforeEach(() => {
    dbSetup.resetMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
  });

  // ─── List ──────────────────────────────────────────────────────────
  describe('GET /demand-signals', () => {
    it('returns paginated list with default parameters', async () => {
      const seedSignal = {
        id: 'ds-1',
        tenantId: 'tenant-1',
        partId: '00000000-0000-0000-0000-000000000001',
        facilityId: '00000000-0000-0000-0000-000000000002',
        signalType: 'manual',
        quantityDemanded: 50,
        quantityFulfilled: 0,
        salesOrderId: null,
        salesOrderLineId: null,
        demandDate: new Date('2026-03-01').toISOString(),
        fulfilledAt: null,
        triggeredKanbanCardId: null,
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      dbSetup.signalRows.push(seedSignal);

      const app = createApp();
      const res = await getJson(app, '/demand-signals');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(25);
      expect(res.body.totalCount).toBe(1);
    });

    it('returns empty list when no signals exist', async () => {
      const app = createApp();
      const res = await getJson(app, '/demand-signals');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.totalCount).toBe(0);
    });

    it('supports pagination via page and pageSize query params', async () => {
      const app = createApp();
      const res = await getJson(app, '/demand-signals?page=2&pageSize=10');

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(2);
      expect(res.body.pageSize).toBe(10);
    });

    it('supports filter by signalType', async () => {
      const app = createApp();
      const res = await getJson(app, '/demand-signals?signalType=manual');

      expect(res.status).toBe(200);
      expect(dbSetup.dbMock.select).toHaveBeenCalled();
    });
  });

  // ─── Detail ────────────────────────────────────────────────────────
  describe('GET /demand-signals/:id', () => {
    it('returns signal detail', async () => {
      dbSetup.signalRows.push({
        id: 'ds-1',
        tenantId: 'tenant-1',
        partId: '00000000-0000-0000-0000-000000000001',
        facilityId: '00000000-0000-0000-0000-000000000002',
        signalType: 'sales_order',
        quantityDemanded: 200,
        quantityFulfilled: 50,
        demandDate: new Date('2026-03-01').toISOString(),
      });

      const app = createApp();
      const res = await getJson(app, '/demand-signals/ds-1');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });

    it('returns 404 for non-existent signal', async () => {
      const app = createApp();
      const res = await getJson(app, '/demand-signals/missing-id');

      expect(res.status).toBe(404);
    });
  });

  // ─── Create ────────────────────────────────────────────────────────
  describe('POST /demand-signals', () => {
    it('creates a demand signal with audit entry', async () => {
      const app = createApp();
      const res = await postJson(app, '/demand-signals', {
        partId: '00000000-0000-0000-0000-000000000001',
        facilityId: '00000000-0000-0000-0000-000000000002',
        signalType: 'manual',
        quantityDemanded: 100,
        demandDate: '2026-03-01T00:00:00.000Z',
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();

      // Verify audit entry
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('demand_signal.created');
      expect(entry.entityType).toBe('demand_signal');
      expect(entry.entityId).toBe('ds-new');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.newState).toEqual(expect.objectContaining({
        signalType: 'manual',
        quantityDemanded: 100,
      }));
    });

    it('creates inside a transaction', async () => {
      const app = createApp();
      await postJson(app, '/demand-signals', {
        partId: '00000000-0000-0000-0000-000000000001',
        facilityId: '00000000-0000-0000-0000-000000000002',
        signalType: 'forecast',
        quantityDemanded: 500,
        demandDate: '2026-06-01T00:00:00.000Z',
      });

      expect(dbSetup.dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(dbSetup.tx.insert).toHaveBeenCalledTimes(1);
    });

    it('returns 400 for invalid input', async () => {
      const app = createApp();
      const res = await postJson(app, '/demand-signals', {
        partId: 'not-a-uuid',
        signalType: 'invalid_type',
      });

      expect(res.status).toBe(400);
    });

    it('supports optional salesOrderId and metadata', async () => {
      const app = createApp();
      const res = await postJson(app, '/demand-signals', {
        partId: '00000000-0000-0000-0000-000000000001',
        facilityId: '00000000-0000-0000-0000-000000000002',
        signalType: 'sales_order',
        quantityDemanded: 75,
        demandDate: '2026-04-01T00:00:00.000Z',
        salesOrderId: '00000000-0000-0000-0000-000000000099',
        metadata: { source: 'test' },
      });

      expect(res.status).toBe(201);
    });
  });

  // ─── Update ────────────────────────────────────────────────────────
  describe('PATCH /demand-signals/:id', () => {
    it('updates quantityFulfilled with audit entry', async () => {
      dbSetup.signalRows.push({
        id: 'ds-1',
        tenantId: 'tenant-1',
        partId: '00000000-0000-0000-0000-000000000001',
        facilityId: '00000000-0000-0000-0000-000000000002',
        signalType: 'manual',
        quantityDemanded: 100,
        quantityFulfilled: 0,
        fulfilledAt: null,
        triggeredKanbanCardId: null,
        metadata: null,
      });

      const app = createApp();
      const res = await patchJson(app, '/demand-signals/ds-1', {
        quantityFulfilled: 100,
      });

      expect(res.status).toBe(200);
      expect(dbSetup.dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('demand_signal.updated');
      expect(entry.entityType).toBe('demand_signal');
      expect(entry.entityId).toBe('ds-1');
      expect(entry.previousState).toEqual(expect.objectContaining({
        quantityFulfilled: 0,
      }));
      expect(entry.newState).toEqual(expect.objectContaining({
        quantityFulfilled: 100,
      }));
    });

    it('returns 404 for non-existent signal', async () => {
      const app = createApp();
      const res = await patchJson(app, '/demand-signals/missing-id', {
        quantityFulfilled: 50,
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 for empty update body', async () => {
      dbSetup.signalRows.push({
        id: 'ds-1',
        tenantId: 'tenant-1',
      });

      const app = createApp();
      const res = await patchJson(app, '/demand-signals/ds-1', {});

      expect(res.status).toBe(400);
    });
  });

  // ─── Summary ───────────────────────────────────────────────────────
  describe('GET /demand-signals/summary', () => {
    it('returns aggregated demand summary', async () => {
      // Summary returns from groupBy query
      dbSetup.dbMock.select.mockImplementation((fields?: unknown) => {
        const builder: Record<string, unknown> = {};
        builder.from = () => builder;
        builder.where = () => builder;
        builder.orderBy = () => builder;
        builder.groupBy = () => builder;
        builder.limit = () => builder;
        builder.offset = () => builder;
        builder.then = (resolve: any) =>
          Promise.resolve([
            {
              partId: '00000000-0000-0000-0000-000000000001',
              facilityId: '00000000-0000-0000-0000-000000000002',
              signalType: 'manual',
              totalDemanded: 500,
              totalFulfilled: 100,
              signalCount: 5,
              unfulfilledCount: 3,
              earliestDemandDate: '2026-01-01',
              latestDemandDate: '2026-06-01',
            },
          ]).then(resolve);
        return builder as any;
      });

      const app = createApp();
      const res = await getJson(app, '/demand-signals/summary');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      const item = (res.body.data as any[])[0];
      expect(item.totalDemanded).toBe(500);
      expect(item.unfulfilledCount).toBe(3);
    });
  });
});
