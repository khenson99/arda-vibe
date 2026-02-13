import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  parts: {},
  suppliers: {},
  supplierParts: {},
  bomItems: {},
  partCategories: {},
  partTypeEnum: {
    enumValues: ['raw_material', 'component', 'subassembly', 'finished_good', 'consumable', 'packaging', 'other'] as const,
  },
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const { dbMock, resetDbMocks } = vi.hoisted(() => {
  const findFirstMock = vi.fn(async () => null as Record<string, unknown> | null);
  const findManyMock = vi.fn(async () => [] as Record<string, unknown>[]);

  const defaultRow = {
    id: 'new-1', partNumber: 'PART-001', name: 'Test Part', type: 'component',
    uom: 'each', categoryId: null, isActive: true, code: null,
    contactName: null, contactEmail: null,
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

  const selectFromWhereLimit = vi.fn(async () => [{ id: 'existing-1', isActive: true, partNumber: 'PART-001', name: 'Existing Part' }]);
  const selectFromWhere = vi.fn(() => ({ limit: selectFromWhereLimit }));
  const selectFrom = vi.fn(() => ({ where: selectFromWhere }));
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
    selectFromWhere.mockClear();
    selectFromWhereLimit.mockClear();
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
import { partsRouter } from './parts.routes.js';
import { suppliersRouter } from './suppliers.routes.js';
import { bomRouter } from './bom.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────
function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { tenantId: 'tenant-1', sub: 'user-1' };
    next();
  });
  app.use('/parts', partsRouter);
  app.use('/suppliers', suppliersRouter);
  app.use('/bom', bomRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
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

async function deleteJson(app: express.Express, path: string) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'DELETE' });
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('Catalog Audit Integration', () => {
  beforeEach(() => {
    resetDbMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
  });

  // ─── Parts ──────────────────────────────────────────────────────────

  describe('Parts audit writes', () => {
    it('writes part.created audit entry on POST /parts', async () => {
      // No duplicate exists
      dbMock.query.parts.findFirst.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await postJson(app, '/parts', {
        partNumber: 'BOLT-M8',
        name: 'M8 Hex Bolt',
        type: 'component',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('part.created');
      expect(entry.entityType).toBe('part');
      expect(entry.entityId).toBe('new-1');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.userId).toBe('user-1');
      expect(entry.newState).toEqual(expect.objectContaining({
        partNumber: 'PART-001',
        name: 'Test Part',
        type: 'component',
      }));
      expect(entry.metadata).toEqual({ source: 'parts.create' });
    });

    it('writes part.updated audit entry on PATCH /parts/:id with field-level snapshots', async () => {
      dbMock.query.parts.findFirst.mockResolvedValueOnce({
        id: 'part-1',
        tenantId: 'tenant-1',
        partNumber: 'BOLT-M8',
        name: 'M8 Hex Bolt',
        isActive: true,
      });

      const app = createApp();
      const res = await patchJson(app, '/parts/part-1', { name: 'M8 Hex Bolt (Updated)' });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('part.updated');
      expect(entry.entityType).toBe('part');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.previousState).toEqual({ name: 'M8 Hex Bolt' });
      expect(entry.newState).toEqual({ name: 'M8 Hex Bolt (Updated)' });
      expect(entry.metadata).toEqual(expect.objectContaining({ source: 'parts.update' }));
    });

    it('writes part.deactivated audit entry on DELETE /parts/:id', async () => {
      const app = createApp();
      const res = await deleteJson(app, '/parts/part-1');

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('part.deactivated');
      expect(entry.entityType).toBe('part');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.previousState).toEqual({ isActive: true });
      expect(entry.newState).toEqual({ isActive: false });
      expect(entry.metadata).toEqual(expect.objectContaining({ source: 'parts.deactivate' }));
    });
  });

  // ─── Suppliers ──────────────────────────────────────────────────────

  describe('Suppliers audit writes', () => {
    it('writes supplier.created audit entry on POST /suppliers', async () => {
      const app = createApp();
      const res = await postJson(app, '/suppliers', {
        name: 'Acme Corp',
        code: 'ACME',
        contactEmail: 'info@acme.com',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('supplier.created');
      expect(entry.entityType).toBe('supplier');
      expect(entry.entityId).toBe('new-1');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.userId).toBe('user-1');
      expect(entry.metadata).toEqual({ source: 'suppliers.create' });
    });

    it('writes supplier.updated audit entry on PATCH /suppliers/:id with field-level snapshots', async () => {
      dbMock.query.suppliers.findFirst.mockResolvedValueOnce({
        id: 'sup-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        code: 'ACME',
        contactEmail: 'info@acme.com',
        isActive: true,
      });

      const app = createApp();
      const res = await patchJson(app, '/suppliers/sup-1', { name: 'Acme Corporation' });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('supplier.updated');
      expect(entry.entityType).toBe('supplier');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.previousState).toEqual({ name: 'Acme Corp' });
      expect(entry.newState).toEqual({ name: 'Acme Corporation' });
      expect(entry.metadata).toEqual(expect.objectContaining({ source: 'suppliers.update' }));
    });

    it('writes supplier.part_linked audit entry on POST /suppliers/:id/parts', async () => {
      const app = createApp();
      const res = await postJson(app, '/suppliers/sup-1/parts', {
        partId: '11111111-1111-1111-1111-111111111111',
        supplierPartNumber: 'SP-100',
        unitCost: '12.50',
        isPrimary: true,
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('supplier.part_linked');
      expect(entry.entityType).toBe('supplier_part');
      expect(entry.entityId).toBe('new-1');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.newState).toEqual(expect.objectContaining({
        supplierId: 'sup-1',
        partId: '11111111-1111-1111-1111-111111111111',
        supplierPartNumber: 'SP-100',
        unitCost: '12.50',
        isPrimary: true,
      }));
      expect(entry.metadata).toEqual({ source: 'suppliers.link_part' });
    });
  });

  // ─── BOM ────────────────────────────────────────────────────────────

  describe('BOM audit writes', () => {
    it('writes bom_line.added audit entry on POST /bom/:parentPartId', async () => {
      const parentId = '11111111-1111-1111-1111-111111111111';
      const childId = '22222222-2222-2222-2222-222222222222';

      // First findFirst: parent part exists; second: child part exists
      dbMock.query.parts.findFirst
        .mockResolvedValueOnce({ id: parentId, tenantId: 'tenant-1', partNumber: 'ASM-100', name: 'Assembly 100' })
        .mockResolvedValueOnce({ id: childId, tenantId: 'tenant-1', partNumber: 'BOLT-M8', name: 'M8 Hex Bolt' });

      const app = createApp();
      const res = await postJson(app, `/bom/${parentId}`, {
        childPartId: childId,
        quantityPer: '5',
        sortOrder: 1,
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('bom_line.added');
      expect(entry.entityType).toBe('bom_item');
      expect(entry.entityId).toBe('new-1');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.newState).toEqual(expect.objectContaining({
        parentPartId: parentId,
        childPartId: childId,
        quantityPer: '5',
        sortOrder: 1,
      }));
      expect(entry.metadata).toEqual(expect.objectContaining({
        source: 'bom.add_line',
        parentPartNumber: 'ASM-100',
        parentPartName: 'Assembly 100',
        childPartNumber: 'BOLT-M8',
        childPartName: 'M8 Hex Bolt',
      }));
    });

    it('writes bom_line.removed audit entry on DELETE /bom/:parentPartId/:bomItemId', async () => {
      const app = createApp();
      const res = await deleteJson(app, '/bom/parent-1/bom-1');

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('bom_line.removed');
      expect(entry.entityType).toBe('bom_item');
      expect(entry.entityId).toBe('bom-1');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.previousState).toEqual(expect.objectContaining({
        parentPartId: 'parent-1',
        childPartId: 'child-1',
        quantityPer: '5',
      }));
      expect(entry.metadata).toEqual(expect.objectContaining({
        source: 'bom.remove_line',
        parentPartId: 'parent-1',
        childPartId: 'child-1',
      }));
    });
  });

  // ─── Transaction safety ─────────────────────────────────────────────

  describe('Transaction safety', () => {
    it('runs audit writes inside the same transaction as catalog mutations', async () => {
      // No duplicate for parts create
      dbMock.query.parts.findFirst.mockResolvedValueOnce(null);

      const app = createApp();
      await postJson(app, '/parts', { partNumber: 'TEST-001', name: 'Test' });

      // Verify db.transaction was called (audit runs inside tx)
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      // Verify writeAuditEntry received the tx object (first arg)
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const txArg = mockWriteAuditEntry.mock.calls[0][0];
      expect(txArg).toHaveProperty('insert');
      expect(txArg).toHaveProperty('update');
    });
  });
});
