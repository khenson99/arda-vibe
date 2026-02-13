import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  partCategories: {},
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const { dbMock, resetDbMocks } = vi.hoisted(() => {
  const findFirstMock = vi.fn(async () => null as Record<string, unknown> | null);
  const findManyMock = vi.fn(async () => [] as Record<string, unknown>[]);

  const defaultRow = {
    id: 'cat-1', name: 'Fasteners', parentCategoryId: null,
    sortOrder: 0, description: null,
  };

  const returningMock = vi.fn(async () => [{ ...defaultRow }]);
  const valueMock = vi.fn(() => ({ returning: returningMock }));
  const insertMock = vi.fn(() => ({ values: valueMock }));

  const whereUpdateMock = vi.fn(() => ({ returning: vi.fn(async () => [{ ...defaultRow }]) }));
  const setMock = vi.fn(() => ({ where: whereUpdateMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const tx = {
    insert: insertMock,
    update: updateMock,
  };

  const dbMock = {
    query: {
      partCategories: { findFirst: findFirstMock, findMany: findManyMock },
    },
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    insert: insertMock,
    update: updateMock,
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
import { categoriesRouter } from './categories.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────
function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { tenantId: 'tenant-1', sub: 'user-1' };
    next();
  });
  app.use('/categories', categoriesRouter);
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

// ═════════════════════════════════════════════════════════════════════

describe('Category Audit Integration', () => {
  beforeEach(() => {
    resetDbMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
  });

  it('writes category.created audit entry on POST /categories', async () => {
    const app = createApp();
    const res = await postJson(app, '/categories', { name: 'Fasteners', sortOrder: 1 });

    expect(res.status).toBe(201);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

    const entry = testState.auditEntries[0];
    expect(entry.action).toBe('category.created');
    expect(entry.entityType).toBe('category');
    expect(entry.entityId).toBe('cat-1');
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.userId).toBe('user-1');
    expect(entry.newState).toEqual(expect.objectContaining({ name: 'Fasteners' }));
    expect(entry.metadata).toEqual({ source: 'categories.create' });
  });

  it('writes category.updated audit entry on PATCH /categories/:id with field-level snapshots', async () => {
    dbMock.query.partCategories.findFirst.mockResolvedValueOnce({
      id: 'cat-1',
      tenantId: 'tenant-1',
      name: 'Fasteners',
      sortOrder: 0,
      description: null,
    });

    const app = createApp();
    const res = await patchJson(app, '/categories/cat-1', { name: 'Hardware', description: 'Nuts and bolts' });

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

    const entry = testState.auditEntries[0];
    expect(entry.action).toBe('category.updated');
    expect(entry.entityType).toBe('category');
    expect(entry.tenantId).toBe('tenant-1');
    expect(entry.previousState).toEqual({ name: 'Fasteners', description: null });
    expect(entry.newState).toEqual({ name: 'Hardware', description: 'Nuts and bolts' });
    expect(entry.metadata).toEqual(expect.objectContaining({ source: 'categories.update' }));
  });

  it('runs category audit inside a transaction', async () => {
    const app = createApp();
    await postJson(app, '/categories', { name: 'Test' });

    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const txArg = mockWriteAuditEntry.mock.calls[0][0];
    expect(txArg).toHaveProperty('insert');
  });
});
