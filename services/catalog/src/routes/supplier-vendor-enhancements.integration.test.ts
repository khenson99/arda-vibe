import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  parts: {},
  suppliers: { id: 'id', name: 'name', code: 'code', createdAt: 'createdAt', updatedAt: 'updatedAt', contactName: 'contactName', city: 'city', country: 'country', tenantId: 'tenantId', isActive: 'isActive', contactEmail: 'contactEmail' },
  supplierParts: { supplierId: 'supplierId', tenantId: 'tenantId', isActive: 'isActive', partId: 'partId', id: 'id' },
  purchaseOrders: { tenantId: 'tenantId', supplierId: 'supplierId', status: 'status', id: 'id', poNumber: 'poNumber', orderDate: 'orderDate', expectedDeliveryDate: 'expectedDeliveryDate', actualDeliveryDate: 'actualDeliveryDate', totalAmount: 'totalAmount', currency: 'currency', createdAt: 'createdAt', sentAt: 'sentAt' },
  purchaseOrderLines: { tenantId: 'tenantId', orderMethod: 'orderMethod', purchaseOrderId: 'purchaseOrderId' },
  inventoryLedger: { tenantId: 'tenantId', partId: 'partId', facilityId: 'facilityId' },
  bomItems: {},
  partCategories: {},
  partTypeEnum: {
    enumValues: ['raw_material', 'component', 'subassembly', 'finished_good', 'consumable', 'packaging', 'other'] as const,
  },
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const { dbMock, resetDbMocks } = vi.hoisted(() => {
  const findFirstMock = vi.fn(async () => null as Record<string, unknown> | null);
  const supplierPartFindFirstMock = vi.fn(async () => null as Record<string, unknown> | null);
  const findManyMock = vi.fn(async () => [] as Record<string, unknown>[]);

  const defaultRow = {
    id: 'new-1', name: 'Test Supplier', code: 'TEST', isActive: true,
    contactName: null, contactEmail: null, orderMethods: [],
  };

  const returningMock = vi.fn(async () => [{ ...defaultRow }]);
  const valueMock = vi.fn(() => ({ returning: returningMock }));
  const insertMock = vi.fn(() => ({ values: valueMock }));

  const whereUpdateMock = vi.fn(() => ({ returning: vi.fn(async () => [{ ...defaultRow }]) }));
  const setMock = vi.fn(() => ({ where: whereUpdateMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const deletedBomItem = { id: 'bom-1', parentPartId: 'parent-1', childPartId: 'child-1', quantityPer: '5', sortOrder: 0 };
  const whereDeleteMock = vi.fn(() => ({ returning: vi.fn(async () => [{ ...deletedBomItem }]) }));
  const deleteMock = vi.fn(() => ({ where: whereDeleteMock }));

  // Enhanced select mock that supports chaining: from → where → limit/offset/orderBy → groupBy
  const groupByMock = vi.fn(async () => [] as Record<string, unknown>[]);
  const orderByMock = vi.fn(async () => [] as Record<string, unknown>[]);
  const offsetMock = vi.fn(() => ({ orderBy: orderByMock }));
  const limitMock = vi.fn(() => ({ offset: offsetMock }));
  const selectFromWhereInner = vi.fn(() => ({ limit: limitMock, groupBy: groupByMock, orderBy: orderByMock }));

  // leftJoin chain
  const leftJoinWhereMock = vi.fn(async () => [{ linkedParts: 0, facilitiesWithInventory: 0 }]);
  const leftJoinMock = vi.fn(() => ({ where: leftJoinWhereMock }));

  // innerJoin chain
  const innerJoinWhereMock = vi.fn(() => ({ groupBy: vi.fn(async () => []) }));
  const innerJoinMock = vi.fn(() => ({ where: innerJoinWhereMock }));

  const selectFrom = vi.fn(() => ({
    where: selectFromWhereInner,
    leftJoin: leftJoinMock,
    innerJoin: innerJoinMock,
  }));
  const selectMock = vi.fn(() => ({ from: selectFrom }));

  const tx = {
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    select: selectMock,
  };

  const dbMock = {
    query: {
      parts: { findFirst: findFirstMock, findMany: findManyMock },
      suppliers: { findFirst: findFirstMock },
      supplierParts: { findFirst: supplierPartFindFirstMock },
      bomItems: { findMany: findManyMock },
    },
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
    select: selectMock,
  };

  const resetDbMocks = () => {
    findFirstMock.mockReset();
    supplierPartFindFirstMock.mockReset();
    findManyMock.mockReset();
    insertMock.mockClear();
    valueMock.mockClear();
    returningMock.mockClear();
    updateMock.mockClear();
    setMock.mockClear();
    whereUpdateMock.mockClear();
    deleteMock.mockClear();
    whereDeleteMock.mockClear();
    selectMock.mockClear();
    selectFrom.mockClear();
    selectFromWhereInner.mockClear();
    limitMock.mockClear();
    offsetMock.mockClear();
    orderByMock.mockClear();
    groupByMock.mockClear();
    leftJoinMock.mockClear();
    leftJoinWhereMock.mockClear();
    innerJoinMock.mockClear();
    innerJoinWhereMock.mockClear();
    dbMock.transaction.mockClear();
  };

  return { dbMock, resetDbMocks };
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
  ilike: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: mockWriteAuditEntry,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: {},
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────
import { suppliersRouter } from './suppliers.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────
function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { tenantId: 'tenant-1', sub: 'user-1' };
    next();
  });
  app.use('/suppliers', suppliersRouter);
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

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('Supplier Vendor Enhancements (#424)', () => {
  beforeEach(() => {
    resetDbMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
  });

  // ─── orderMethods field ──────────────────────────────────────────
  describe('orderMethods field', () => {
    it('accepts orderMethods array on POST /suppliers', async () => {
      const app = createApp();
      const res = await postJson(app, '/suppliers', {
        name: 'Acme Corp',
        orderMethods: ['email', 'phone', 'portal'],
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('supplier.created');
      expect(entry.newState).toHaveProperty('orderMethods');
    });

    it('rejects invalid orderMethods (non-array)', async () => {
      const app = createApp();
      const res = await postJson(app, '/suppliers', {
        name: 'Acme Corp',
        orderMethods: 'email',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });

    it('rejects orderMethods exceeding max length of 20', async () => {
      const app = createApp();
      const methods = Array.from({ length: 21 }, (_, i) => `method-${i}`);
      const res = await postJson(app, '/suppliers', {
        name: 'Acme Corp',
        orderMethods: methods,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });
  });

  // ─── Reactivation ────────────────────────────────────────────────
  describe('POST /suppliers/:id/reactivate', () => {
    it('reactivates a deactivated supplier with audit trail', async () => {
      dbMock.query.suppliers.findFirst.mockResolvedValueOnce({
        id: 'sup-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        isActive: false,
      });

      const app = createApp();
      const res = await postJson(app, '/suppliers/sup-1/reactivate', {});

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('supplier.reactivated');
      expect(entry.entityType).toBe('supplier');
      expect(entry.previousState).toEqual({ isActive: false });
      expect(entry.newState).toEqual({ isActive: true });
    });

    it('returns 404 for non-existent supplier', async () => {
      dbMock.query.suppliers.findFirst.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await postJson(app, '/suppliers/sup-999/reactivate', {});

      expect(res.status).toBe(404);
    });

    it('returns 400 if supplier is already active', async () => {
      dbMock.query.suppliers.findFirst.mockResolvedValueOnce({
        id: 'sup-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        isActive: true,
      });

      const app = createApp();
      const res = await postJson(app, '/suppliers/sup-1/reactivate', {});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Supplier is already active');
    });
  });

  // ─── GET /suppliers/:id/purchase-orders ───────────────────────────
  describe('GET /suppliers/:id/purchase-orders', () => {
    it('returns 404 if supplier does not exist', async () => {
      dbMock.query.suppliers.findFirst.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await getJson(app, '/suppliers/sup-999/purchase-orders');

      expect(res.status).toBe(404);
    });

    it('returns paginated purchase orders for existing supplier', async () => {
      dbMock.query.suppliers.findFirst.mockResolvedValueOnce({
        id: 'sup-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        isActive: true,
      });

      const app = createApp();
      const res = await getJson(app, '/suppliers/sup-1/purchase-orders');

      // The response should have data and pagination structure
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('pagination');
    });
  });

  // ─── Audit: reactivation runs inside transaction ──────────────────
  describe('Transaction safety for reactivation', () => {
    it('runs reactivation audit inside the same transaction', async () => {
      dbMock.query.suppliers.findFirst.mockResolvedValueOnce({
        id: 'sup-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        isActive: false,
      });

      const app = createApp();
      await postJson(app, '/suppliers/sup-1/reactivate', {});

      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const txArg = mockWriteAuditEntry.mock.calls[0][0];
      expect(txArg).toHaveProperty('insert');
      expect(txArg).toHaveProperty('update');
    });
  });

  // ─── Backward compat: existing create still works without orderMethods ─
  describe('Backward compatibility', () => {
    it('creates supplier without orderMethods (optional field)', async () => {
      const app = createApp();
      const res = await postJson(app, '/suppliers', {
        name: 'Legacy Vendor',
        code: 'LEG',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('supplier.created');
    });
  });
});
