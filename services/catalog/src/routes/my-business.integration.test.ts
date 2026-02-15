import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  departments: {},
  itemTypes: {},
  itemSubtypes: {},
  useCases: {},
  facilities: {},
  storageLocations: {},
  inventoryLedger: {},
  // Existing schemas needed by other routes
  parts: {},
  suppliers: {},
  supplierParts: {},
  bomItems: {},
  partCategories: {},
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const { dbMock, resetDbMocks } = vi.hoisted(() => {
  const findFirstMock = vi.fn(async () => null as Record<string, unknown> | null);
  const findManyMock = vi.fn(async () => [] as Record<string, unknown>[]);

  const defaultRow = {
    id: 'new-1', name: 'Test Element', code: 'TST-001', description: null,
    colorHex: null, sortOrder: 0, isActive: true, tenantId: 'tenant-1',
    createdAt: new Date(), updatedAt: new Date(),
  };

  const returningMock = vi.fn(async () => [{ ...defaultRow }]);
  const valueMock = vi.fn(() => ({ returning: returningMock }));
  const insertMock = vi.fn(() => ({ values: valueMock }));

  const whereUpdateMock = vi.fn(() => ({ returning: vi.fn(async () => [{ ...defaultRow }]) }));
  const setMock = vi.fn(() => ({ where: whereUpdateMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const selectFromWhereLimit = vi.fn(async () => []);
  const selectFromWhereOffset = vi.fn(() => ({ orderBy: vi.fn(async () => []) }));
  const selectFromWhere = vi.fn(() => ({ limit: vi.fn(() => ({ offset: selectFromWhereOffset })) }));
  const selectFrom = vi.fn(() => ({ where: selectFromWhere }));
  const selectMock = vi.fn(() => ({ from: selectFrom }));

  const tx = {
    insert: insertMock,
    update: updateMock,
    select: selectMock,
  };

  const dbMock = {
    query: {
      departments: { findFirst: findFirstMock, findMany: findManyMock },
      itemTypes: { findFirst: findFirstMock, findMany: findManyMock },
      itemSubtypes: { findFirst: findFirstMock, findMany: findManyMock },
      useCases: { findFirst: findFirstMock, findMany: findManyMock },
      facilities: { findFirst: findFirstMock, findMany: findManyMock },
      storageLocations: { findFirst: findFirstMock, findMany: findManyMock },
    },
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    insert: insertMock,
    update: updateMock,
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
    selectMock.mockClear();
    selectFrom.mockClear();
    selectFromWhere.mockClear();
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
  relations: vi.fn(() => ({})),
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
import { departmentsRouter } from './departments.routes.js';
import { itemTypesRouter } from './item-types.routes.js';
import { useCasesRouter } from './use-cases.routes.js';
import { facilitiesRouter } from './facilities.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────
function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { tenantId: 'tenant-1', sub: 'user-1' };
    next();
  });
  app.use('/departments', departmentsRouter);
  app.use('/item-types', itemTypesRouter);
  app.use('/use-cases', useCasesRouter);
  app.use('/facilities', facilitiesRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function request(app: express.Express, method: string, path: string, body?: object) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const options: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
    };
    if (body) options.body = JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, options);
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('My Business — Process Shop Elements (#438)', () => {
  beforeEach(() => {
    resetDbMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
  });

  // ─── Departments ──────────────────────────────────────────────────

  describe('Departments CRUD', () => {
    it('creates a department with audit entry', async () => {
      const app = createApp();
      const res = await request(app, 'POST', '/departments', {
        name: 'Purchasing',
        code: 'PUR',
        description: 'Purchasing department',
        colorHex: '#4A90D9',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('department.created');
      expect(entry.entityType).toBe('department');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.userId).toBe('user-1');
    });

    it('updates a department with field-level audit', async () => {
      dbMock.query.departments.findFirst.mockResolvedValueOnce({
        id: 'dept-1', tenantId: 'tenant-1', name: 'Purchasing', code: 'PUR', isActive: true, colorHex: null,
      });

      const app = createApp();
      const res = await request(app, 'PATCH', '/departments/dept-1', { name: 'Procurement', colorHex: '#FF6600' });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('department.updated');
      expect(entry.previousState).toEqual({ name: 'Purchasing', colorHex: null });
      expect(entry.newState).toEqual({ name: 'Procurement', colorHex: '#FF6600' });
    });

    it('deactivates a department with audit entry', async () => {
      dbMock.query.departments.findFirst.mockResolvedValueOnce({
        id: 'dept-1', tenantId: 'tenant-1', name: 'Purchasing', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'DELETE', '/departments/dept-1');

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('department.deactivated');
      expect(entry.previousState).toEqual({ isActive: true });
      expect(entry.newState).toEqual({ isActive: false });
    });

    it('returns 404 when updating non-existent department', async () => {
      dbMock.query.departments.findFirst.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, 'PATCH', '/departments/nonexistent', { name: 'Updated' });

      expect(res.status).toBe(404);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid input', async () => {
      const app = createApp();
      const res = await request(app, 'POST', '/departments', {
        name: '', // min length 1
        code: 'PUR',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });
  });

  // ─── Item Types ───────────────────────────────────────────────────

  describe('Item Types CRUD', () => {
    it('creates an item type with audit entry', async () => {
      const app = createApp();
      const res = await request(app, 'POST', '/item-types', {
        name: 'Raw Materials',
        code: 'RAW',
        colorHex: '#28A745',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('item_type.created');
      expect(entry.entityType).toBe('item_type');
    });

    it('deactivates item type and cascades to subtypes', async () => {
      dbMock.query.itemTypes.findFirst.mockResolvedValueOnce({
        id: 'type-1', tenantId: 'tenant-1', name: 'Raw Materials', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'DELETE', '/item-types/type-1');

      expect(res.status).toBe(200);
      // Verify both update (deactivate type) and update (deactivate subtypes) were called
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('item_type.deactivated');
    });
  });

  // ─── Item Subtypes ────────────────────────────────────────────────

  describe('Item Subtypes CRUD (nested under item types)', () => {
    it('creates a subtype under an item type', async () => {
      dbMock.query.itemTypes.findFirst.mockResolvedValueOnce({
        id: 'type-1', tenantId: 'tenant-1', name: 'Raw Materials', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'POST', '/item-types/type-1/subtypes', {
        name: 'Steel',
        code: 'STL',
        colorHex: '#888888',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('item_subtype.created');
      expect(entry.entityType).toBe('item_subtype');
      expect(entry.metadata).toEqual(expect.objectContaining({ parentTypeName: 'Raw Materials' }));
    });

    it('returns 404 when creating subtype under non-existent type', async () => {
      dbMock.query.itemTypes.findFirst.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, 'POST', '/item-types/nonexistent/subtypes', {
        name: 'Steel',
        code: 'STL',
      });

      expect(res.status).toBe(404);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it('deactivates a subtype with audit entry', async () => {
      dbMock.query.itemSubtypes.findFirst.mockResolvedValueOnce({
        id: 'sub-1', tenantId: 'tenant-1', name: 'Steel', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'DELETE', '/item-types/type-1/subtypes/sub-1');

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('item_subtype.deactivated');
    });
  });

  // ─── Use Cases ────────────────────────────────────────────────────

  describe('Use Cases CRUD', () => {
    it('creates a use case with audit entry', async () => {
      const app = createApp();
      const res = await request(app, 'POST', '/use-cases', {
        name: 'Production Input',
        code: 'PROD-IN',
        description: 'Items consumed during production',
        colorHex: '#D9534F',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('use_case.created');
      expect(entry.entityType).toBe('use_case');
    });

    it('updates a use case with field-level audit', async () => {
      dbMock.query.useCases.findFirst.mockResolvedValueOnce({
        id: 'uc-1', tenantId: 'tenant-1', name: 'Production Input', code: 'PROD-IN', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'PATCH', '/use-cases/uc-1', { name: 'Manufacturing Input' });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('use_case.updated');
      expect(entry.previousState).toEqual({ name: 'Production Input' });
      expect(entry.newState).toEqual({ name: 'Manufacturing Input' });
    });

    it('deactivates a use case with audit entry', async () => {
      dbMock.query.useCases.findFirst.mockResolvedValueOnce({
        id: 'uc-1', tenantId: 'tenant-1', name: 'Production Input', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'DELETE', '/use-cases/uc-1');

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('use_case.deactivated');
    });
  });

  // ─── Facilities (enhanced CRUD) ───────────────────────────────────

  describe('Facilities CRUD (enhanced)', () => {
    it('creates a facility with audit entry', async () => {
      const app = createApp();
      const res = await request(app, 'POST', '/facilities', {
        name: 'Main Warehouse',
        code: 'WH-01',
        type: 'warehouse',
        city: 'Austin',
        state: 'TX',
        colorHex: '#5BC0DE',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('facility.created');
      expect(entry.entityType).toBe('facility');
    });

    it('updates a facility with field-level audit', async () => {
      dbMock.query.facilities.findFirst.mockResolvedValueOnce({
        id: 'fac-1', tenantId: 'tenant-1', name: 'Main Warehouse', code: 'WH-01', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'PATCH', '/facilities/fac-1', { name: 'Central Warehouse' });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('facility.updated');
      expect(entry.previousState).toEqual({ name: 'Main Warehouse' });
      expect(entry.newState).toEqual({ name: 'Central Warehouse' });
    });

    it('deactivates a facility and cascades to storage locations', async () => {
      dbMock.query.facilities.findFirst.mockResolvedValueOnce({
        id: 'fac-1', tenantId: 'tenant-1', name: 'Main Warehouse', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'DELETE', '/facilities/fac-1');

      expect(res.status).toBe(200);
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('facility.deactivated');
    });
  });

  // ─── Storage Locations (nested under facilities) ──────────────────

  describe('Storage Locations CRUD (nested under facilities)', () => {
    it('creates a storage location under a facility', async () => {
      dbMock.query.facilities.findFirst.mockResolvedValueOnce({
        id: 'fac-1', tenantId: 'tenant-1', name: 'Main Warehouse', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'POST', '/facilities/fac-1/storage-locations', {
        name: 'Aisle A Bin 1',
        code: 'A-01-01',
        zone: 'Raw Materials',
        colorHex: '#F0AD4E',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('storage_location.created');
      expect(entry.entityType).toBe('storage_location');
      expect(entry.metadata).toEqual(expect.objectContaining({ facilityName: 'Main Warehouse' }));
    });

    it('returns 404 when creating storage location under non-existent facility', async () => {
      dbMock.query.facilities.findFirst.mockResolvedValueOnce(null);

      const app = createApp();
      const res = await request(app, 'POST', '/facilities/nonexistent/storage-locations', {
        name: 'Bin 1',
        code: 'B-01',
      });

      expect(res.status).toBe(404);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it('deactivates a storage location with audit entry', async () => {
      dbMock.query.storageLocations.findFirst.mockResolvedValueOnce({
        id: 'sl-1', tenantId: 'tenant-1', name: 'Aisle A Bin 1', isActive: true,
      });

      const app = createApp();
      const res = await request(app, 'DELETE', '/facilities/fac-1/storage-locations/sl-1');

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('storage_location.deactivated');
    });
  });

  // ─── Transaction safety ───────────────────────────────────────────

  describe('Transaction safety', () => {
    it('runs audit writes inside the same transaction as mutations', async () => {
      const app = createApp();
      await request(app, 'POST', '/departments', { name: 'Test', code: 'TST' });

      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const txArg = mockWriteAuditEntry.mock.calls[0][0];
      expect(txArg).toHaveProperty('insert');
      expect(txArg).toHaveProperty('update');
    });

    it('validates colorHex format (rejects invalid)', async () => {
      const app = createApp();
      const res = await request(app, 'POST', '/departments', {
        name: 'Test',
        code: 'TST',
        colorHex: 'invalid',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });
  });
});
