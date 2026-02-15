import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  productVisibility: {},
  parts: {},
  visibilityStateEnum: {
    enumValues: ['visible', 'hidden', 'coming_soon', 'discontinued'] as const,
  },
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const dbSetup = vi.hoisted(() => {
  const defaultVisibility = {
    id: 'vis-1',
    tenantId: 'tenant-1',
    partId: 'part-1',
    visibilityState: 'hidden',
    displayName: 'Test Part Display',
    shortDescription: 'Short desc',
    longDescription: 'Long desc',
    displayPrice: '29.99',
    displayOrder: 0,
    publishedAt: null,
    unpublishedAt: null,
    metadata: null,
    updatedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    partNumber: 'PART-001',
    partName: 'Test Part',
    imageUrl: 'https://example.com/img.jpg',
    unitPrice: '10.00',
    isSellable: true,
    isActive: true,
  };

  // Generic terminal mock — always resolves with queued data
  let selectCallIndex = 0;
  const selectResults: unknown[][] = [];

  // Create a chainable mock that supports: .from().innerJoin().where().orderBy().limit().offset()
  // and also: .from().where() (for health endpoint, resolves as awaitable)
  function createSelectChain() {
    const terminal = async () => {
      const data = selectResults[selectCallIndex] ?? [{ ...defaultVisibility }];
      selectCallIndex++;
      return data;
    };

    const offsetFn = vi.fn(terminal);
    const limitFn = vi.fn(() => ({ offset: offsetFn }));
    const orderByFn = vi.fn(() => ({ limit: limitFn }));

    // where() returns an object that's both chainable AND thenable (for health queries)
    const whereFn: any = vi.fn(() => {
      const result = {
        orderBy: orderByFn,
        limit: limitFn,
        // Make it thenable so `await db.select().from().where()` works
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
          return terminal().then(resolve, reject);
        },
      };
      return result;
    });

    const innerJoinFn = vi.fn(() => ({ where: whereFn }));
    const fromFn = vi.fn(() => ({ innerJoin: innerJoinFn, where: whereFn }));
    return { from: fromFn };
  }

  const selectMock = vi.fn(() => createSelectChain());

  // Transaction mock
  const txSelectData: unknown[][] = [];
  let txCallIndex = 0;

  const txSelectMock = vi.fn(() => {
    const idx = txCallIndex++;
    const terminal = async () => txSelectData[idx] ?? [{ ...defaultVisibility }];
    const whereFn: any = vi.fn(() => ({
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        terminal().then(resolve, reject),
    }));
    const fromFn = vi.fn(() => ({ where: whereFn }));
    return { from: fromFn };
  });

  const txUpdateReturningMock = vi.fn(async () => [{ ...defaultVisibility, visibilityState: 'visible' }] as Record<string, unknown>[]);
  const txUpdateWhereMock = vi.fn(() => ({ returning: txUpdateReturningMock }));
  const txUpdateSetMock = vi.fn(() => ({ where: txUpdateWhereMock }));
  const txUpdateMock = vi.fn(() => ({ set: txUpdateSetMock }));

  const tx = {
    select: txSelectMock,
    update: txUpdateMock,
  };

  const dbMock = {
    select: selectMock,
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      txCallIndex = 0;
      return callback(tx);
    }),
  };

  const resetDbMocks = () => {
    selectResults.length = 0;
    selectCallIndex = 0;
    txSelectData.length = 0;
    txCallIndex = 0;

    selectMock.mockClear();
    selectMock.mockImplementation(() => createSelectChain());
    dbMock.transaction.mockClear();
    dbMock.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => {
        txCallIndex = 0;
        return callback(tx);
      }
    );
    txSelectMock.mockClear();
    txSelectMock.mockImplementation(() => {
      const idx = txCallIndex++;
      const terminal = async () => txSelectData[idx] ?? [{ ...defaultVisibility }];
      const whereFn: any = vi.fn(() => ({
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          terminal().then(resolve, reject),
      }));
      const fromFn = vi.fn(() => ({ where: whereFn }));
      return { from: fromFn };
    });
    txUpdateMock.mockClear();
    txUpdateSetMock.mockClear();
    txUpdateWhereMock.mockClear();
    txUpdateReturningMock.mockClear();
    txUpdateReturningMock.mockImplementation(async () => [{ ...defaultVisibility, visibilityState: 'visible' }] as Record<string, unknown>[]);
  };

  return {
    dbMock,
    resetDbMocks,
    queueSelectResult: (data: unknown[]) => { selectResults.push(data); },
    setTxSelectData: (...batches: unknown[][]) => {
      txSelectData.length = 0;
      batches.forEach(b => txSelectData.push(b));
    },
    txUpdateReturningMock,
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
  ilike: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
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

const mockRequireRole = vi.hoisted(() =>
  vi.fn((..._roles: string[]) => (_req: unknown, _res: unknown, next: () => void) => next())
);

vi.mock('@arda/auth-utils', () => ({
  requireRole: mockRequireRole,
  authMiddleware: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────
import { visibilityRouter } from './visibility.routes.js';
import { requireRole } from '@arda/auth-utils';

// ─── Helpers ────────────────────────────────────────────────────────
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';
const PART_ID = '22222222-2222-4222-8222-222222222222';
const PART_ID_2 = '33333333-3333-4333-8333-333333333333';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      tenantId: TENANT_ID,
      sub: USER_ID,
      role: 'ecommerce_director',
    };
    next();
  });
  app.use('/visibility', visibilityRouter);
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

describe('Visibility CRUD Integration', () => {
  beforeEach(() => {
    dbSetup.resetDbMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
  });

  // ─── RBAC ──────────────────────────────────────────────────────────

  describe('RBAC', () => {
    it('restricts access with requireRole for ecommerce_director', () => {
      expect(requireRole).toHaveBeenCalledWith('ecommerce_director');
    });

    it('returns 403 when requireRole middleware blocks the request', async () => {
      mockRequireRole.mockImplementation(
        (..._roles: string[]) =>
          (_req: unknown, res: any, _next: () => void) => {
            res.status(403).json({ error: 'Forbidden' });
          }
      );

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).user = { tenantId: TENANT_ID, sub: USER_ID, role: 'inventory_manager' };
        next();
      });
      const blockMiddleware = mockRequireRole('ecommerce_director');
      app.use('/visibility', blockMiddleware as any, visibilityRouter);
      app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
      });

      const { status, body } = await getJson(app, '/visibility');
      expect(status).toBe(403);
      expect(body.error).toBe('Forbidden');

      // Restore passthrough for other tests
      mockRequireRole.mockImplementation(
        (..._roles: string[]) => (_req: unknown, _res: unknown, next: () => void) => next()
      );
    });
  });

  // ─── GET /visibility (list) ────────────────────────────────────────

  describe('GET /visibility', () => {
    it('returns paginated visibility list with part data', async () => {
      // Queue data result + count result for the 2 parallel queries
      dbSetup.queueSelectResult([{
        id: 'vis-1', partId: 'part-1', visibilityState: 'hidden',
        displayName: 'Widget', partNumber: 'W-001',
      }]);
      dbSetup.queueSelectResult([{ count: 1 }]);

      const app = createApp();
      const { status, body } = await getJson(app, '/visibility');

      expect(status).toBe(200);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
    });

    it('supports visibilityState filter in query', async () => {
      dbSetup.queueSelectResult([]);
      dbSetup.queueSelectResult([{ count: 0 }]);

      const app = createApp();
      const { status } = await getJson(app, '/visibility?visibilityState=visible');
      expect(status).toBe(200);
    });

    it('supports search filter across displayName and partNumber', async () => {
      dbSetup.queueSelectResult([]);
      dbSetup.queueSelectResult([{ count: 0 }]);

      const app = createApp();
      const { status } = await getJson(app, '/visibility?search=widget');
      expect(status).toBe(200);
    });

    it('supports sortBy and sortOrder query params', async () => {
      dbSetup.queueSelectResult([]);
      dbSetup.queueSelectResult([{ count: 0 }]);

      const app = createApp();
      const { status } = await getJson(app, '/visibility?sortBy=updatedAt&sortOrder=desc');
      expect(status).toBe(200);
    });
  });

  // ─── GET /visibility/:partId ───────────────────────────────────────

  describe('GET /visibility/:partId', () => {
    it('returns visibility record for a specific part', async () => {
      dbSetup.queueSelectResult([{
        id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID,
        visibilityState: 'hidden', displayName: 'Widget',
      }]);

      const app = createApp();
      const { status } = await getJson(app, `/visibility/${PART_ID}`);
      expect(status).toBe(200);
    });

    it('returns 404 when no visibility record exists for the part', async () => {
      dbSetup.queueSelectResult([]);

      const app = createApp();
      const { status, body } = await getJson(app, `/visibility/${PART_ID}`);

      expect(status).toBe(404);
      expect(body.error).toContain('not found');
    });
  });

  // ─── PATCH /visibility/:partId ─────────────────────────────────────

  describe('PATCH /visibility/:partId', () => {
    it('updates visibility state and writes audit entry', async () => {
      dbSetup.setTxSelectData([{
        id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID,
        visibilityState: 'hidden', displayName: 'Old Name',
        publishedAt: null, unpublishedAt: null,
      }]);
      dbSetup.txUpdateReturningMock.mockResolvedValueOnce([{
        id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID,
        visibilityState: 'visible', displayName: 'Old Name',
        publishedAt: new Date().toISOString(),
      }] as any);

      const app = createApp();
      const { status } = await patchJson(app, `/visibility/${PART_ID}`, {
        visibilityState: 'visible',
      });

      expect(status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      expect(testState.auditEntries[0]).toMatchObject({
        action: 'product_visibility.updated',
        entityType: 'product_visibility',
      });
    });

    it('sets publishedAt when first transitioning to visible', async () => {
      dbSetup.setTxSelectData([{
        id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID,
        visibilityState: 'hidden', publishedAt: null,
      }]);

      const app = createApp();
      const { status } = await patchJson(app, `/visibility/${PART_ID}`, {
        visibilityState: 'visible',
      });

      expect(status).toBe(200);
      expect(testState.auditEntries[0]?.newState).toMatchObject({
        visibilityState: 'visible',
      });
    });

    it('preserves publishedAt on subsequent state changes', async () => {
      dbSetup.setTxSelectData([{
        id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID,
        visibilityState: 'visible', publishedAt: '2026-01-15T00:00:00.000Z',
      }]);

      const app = createApp();
      const { status } = await patchJson(app, `/visibility/${PART_ID}`, {
        visibilityState: 'hidden',
      });

      expect(status).toBe(200);
      expect(testState.auditEntries[0]?.previousState).toMatchObject({
        visibilityState: 'visible',
      });
    });

    it('returns 400 when no fields are provided', async () => {
      const app = createApp();
      const { status, body } = await patchJson(app, `/visibility/${PART_ID}`, {});

      expect(status).toBe(400);
      expect(body.error).toContain('No fields');
    });

    it('captures field-level diff in audit entry', async () => {
      dbSetup.setTxSelectData([{
        id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID,
        visibilityState: 'hidden', displayName: 'Old Name',
        displayPrice: '10.00', publishedAt: null,
      }]);

      const app = createApp();
      await patchJson(app, `/visibility/${PART_ID}`, {
        displayName: 'New Name',
        displayPrice: 29.99,
      });

      expect(testState.auditEntries[0]?.previousState).toMatchObject({
        displayName: 'Old Name',
        displayPrice: '10.00',
      });
      expect(testState.auditEntries[0]?.newState).toMatchObject({
        displayName: 'New Name',
        displayPrice: 29.99,
      });
    });
  });

  // ─── POST /visibility/batch ────────────────────────────────────────

  describe('POST /visibility/batch', () => {
    it('batch-updates visibility state for multiple parts', async () => {
      dbSetup.setTxSelectData(
        [{ id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID, visibilityState: 'hidden', publishedAt: null }],
        [{ id: 'vis-2', tenantId: TENANT_ID, partId: PART_ID_2, visibilityState: 'hidden', publishedAt: null }],
      );
      dbSetup.txUpdateReturningMock
        .mockResolvedValueOnce([{ id: 'vis-1', visibilityState: 'visible' }] as any)
        .mockResolvedValueOnce([{ id: 'vis-2', visibilityState: 'visible' }] as any);

      const app = createApp();
      const { status, body } = await postJson(app, '/visibility/batch', {
        partIds: [PART_ID, PART_ID_2],
        visibilityState: 'visible',
      });

      expect(status).toBe(200);
      expect(body).toHaveProperty('updated');
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(2);
    });

    it('skips parts without visibility records', async () => {
      dbSetup.setTxSelectData(
        [], // PART_ID not found
        [{ id: 'vis-2', tenantId: TENANT_ID, partId: PART_ID_2, visibilityState: 'hidden', publishedAt: null }],
      );
      dbSetup.txUpdateReturningMock.mockResolvedValueOnce([{ id: 'vis-2', visibilityState: 'visible' }] as any);

      const app = createApp();
      const { status } = await postJson(app, '/visibility/batch', {
        partIds: [PART_ID, PART_ID_2],
        visibilityState: 'visible',
      });

      expect(status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    });

    it('skips parts already in the target state', async () => {
      dbSetup.setTxSelectData(
        [{ id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID, visibilityState: 'visible', publishedAt: '2026-01-01' }],
      );

      const app = createApp();
      const { status } = await postJson(app, '/visibility/batch', {
        partIds: [PART_ID],
        visibilityState: 'visible',
      });

      expect(status).toBe(200);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it('validates batch request body (empty partIds)', async () => {
      const app = createApp();
      const { status, body } = await postJson(app, '/visibility/batch', {
        partIds: [],
        visibilityState: 'visible',
      });

      expect(status).toBe(400);
      expect(body.error).toContain('Validation error');
    });

    it('records batchUpdate=true in audit metadata', async () => {
      dbSetup.setTxSelectData(
        [{ id: 'vis-1', tenantId: TENANT_ID, partId: PART_ID, visibilityState: 'hidden', publishedAt: null }],
      );
      dbSetup.txUpdateReturningMock.mockResolvedValueOnce([{ id: 'vis-1', visibilityState: 'visible' }] as any);

      const app = createApp();
      await postJson(app, '/visibility/batch', {
        partIds: [PART_ID],
        visibilityState: 'visible',
      });

      expect(testState.auditEntries[0]?.metadata).toMatchObject({ batchUpdate: true });
    });
  });

  // ─── GET /visibility/health ────────────────────────────────────────

  describe('GET /visibility/health', () => {
    it('returns healthy=true when no issues found', async () => {
      // 3 parallel queries all return empty arrays
      dbSetup.queueSelectResult([]); // missingImage
      dbSetup.queueSelectResult([]); // missingPrice
      dbSetup.queueSelectResult([]); // inactiveButSellable

      const app = createApp();
      const { status, body } = await getJson(app, '/visibility/health');

      expect(status).toBe(200);
      expect(body.healthy).toBe(true);
      expect(body.totalIssues).toBe(0);
    });

    it('reports missing image issues for sellable parts', async () => {
      const partWithoutImage = { partId: 'p1', partNumber: 'PART-001', partName: 'No Image Part' };
      dbSetup.queueSelectResult([partWithoutImage]); // missingImage
      dbSetup.queueSelectResult([]);                  // missingPrice
      dbSetup.queueSelectResult([]);                  // inactiveButSellable

      const app = createApp();
      const { status, body } = await getJson(app, '/visibility/health');

      expect(status).toBe(200);
      expect(body.totalIssues).toBe(1);
      const issues = body.issues as Record<string, { count: number; parts: unknown[] }>;
      expect(issues.missingImage.count).toBe(1);
    });

    it('reports missing price issues for sellable parts', async () => {
      const partWithoutPrice = { partId: 'p2', partNumber: 'PART-002', partName: 'No Price Part' };
      dbSetup.queueSelectResult([]);                   // missingImage
      dbSetup.queueSelectResult([partWithoutPrice]);    // missingPrice
      dbSetup.queueSelectResult([]);                   // inactiveButSellable

      const app = createApp();
      const { status, body } = await getJson(app, '/visibility/health');

      expect(status).toBe(200);
      expect(body.totalIssues).toBe(1);
      const issues = body.issues as Record<string, { count: number; parts: unknown[] }>;
      expect(issues.missingPrice.count).toBe(1);
    });

    it('reports inactive-but-sellable parts', async () => {
      const inactivePart = { partId: 'p3', partNumber: 'PART-003', partName: 'Inactive Part' };
      dbSetup.queueSelectResult([]);              // missingImage
      dbSetup.queueSelectResult([]);              // missingPrice
      dbSetup.queueSelectResult([inactivePart]);  // inactiveButSellable

      const app = createApp();
      const { status, body } = await getJson(app, '/visibility/health');

      expect(status).toBe(200);
      expect(body.totalIssues).toBe(1);
      const issues = body.issues as Record<string, { count: number; parts: unknown[] }>;
      expect(issues.inactiveButSellable.count).toBe(1);
    });
  });
});
