import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
  selectDistinctResults: [] as unknown[],
  executeResults: [] as unknown[],
}));

const schemaMock = vi.hoisted(() => {
  const col = (table: string, col: string) => `${table}.${col}`;
  return {
    auditLog: {
      tenantId: col('audit_log', 'tenant_id'),
      userId: col('audit_log', 'user_id'),
      action: col('audit_log', 'action'),
      entityType: col('audit_log', 'entity_type'),
      entityId: col('audit_log', 'entity_id'),
      newState: col('audit_log', 'new_state'),
      timestamp: col('audit_log', 'timestamp'),
      metadata: col('audit_log', 'metadata'),
      id: col('audit_log', 'id'),
    },
    auditLogArchive: {
      tenantId: col('audit_log_archive', 'tenant_id'),
    },
    users: {
      id: col('users', 'id'),
      firstName: col('users', 'first_name'),
      lastName: col('users', 'last_name'),
    },
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder(getResult: () => unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.groupBy = () => builder;
    builder.leftJoin = () => builder;
    builder.execute = async () => getResult();
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(getResult()).then(resolve, reject);
    return builder;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(() => testState.selectResults.shift() ?? [])),
    selectDistinct: vi.fn(() => makeSelectBuilder(() => testState.selectDistinctResults.shift() ?? [])),
    execute: vi.fn(async () => testState.executeResults.shift() ?? []),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.selectDistinct.mockClear();
    dbMock.execute.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  asc: vi.fn((col: unknown) => ({ __asc: col })),
  desc: vi.fn((col: unknown) => ({ __desc: col })),
  eq: vi.fn((a: unknown, b: unknown) => ({ __eq: [a, b] })),
  sql: Object.assign(
    vi.fn((...args: unknown[]) => ({ __sql: args })),
    { raw: vi.fn((s: string) => ({ __raw: s })) },
  ),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'test', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

import { auditRouter } from './audit.routes.js';

// ─── Test helpers ────────────────────────────────────────────────────

function createTestApp(withUser = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (withUser) {
      (req as any).user = {
        tenantId: 'tenant-1',
        sub: 'user-1',
      };
    }
    next();
  });
  app.use('/audit', auditRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function getJson(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const text = await response.text();
    let body: Record<string, any>;
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      body = { error: text };
    }
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('audit query API enhancements', () => {
  beforeEach(() => {
    testState.selectResults = [];
    testState.selectDistinctResults = [];
    testState.executeResults = [];
    resetDbMockCalls();
  });

  // ─── GET /audit — actorName filter ────────────────────────────────

  describe('GET /audit with actorName filter', () => {
    it('returns filtered results when actorName is provided', async () => {
      // countResult (from joined query)
      testState.selectResults = [
        [{ count: 1 }],
        // data rows — Drizzle joined shape: { audit_log: {...}, users: {...} }
        [
          {
            audit_log: {
              id: 'a1',
              action: 'part.created',
              entityType: 'part',
              entityId: '11111111-1111-4111-8111-111111111111',
            },
            users: { firstName: 'John', lastName: 'Doe' },
          },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit?actorName=John');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].action).toBe('part.created');
      expect(response.body.pagination.total).toBe(1);
    });
  });

  // ─── GET /audit — entityName filter ───────────────────────────────

  describe('GET /audit with entityName filter', () => {
    it('returns metadata-searched results', async () => {
      testState.selectResults = [
        [{ count: 2 }],
        [
          { id: 'a1', action: 'part.created', metadata: { partNumber: 'PN-001' } },
          { id: 'a2', action: 'part.updated', metadata: { partNumber: 'PN-001' } },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit?entityName=PN-001');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.pagination.total).toBe(2);
    });
  });

  // ─── GET /audit — search filter ───────────────────────────────────

  describe('GET /audit with search filter', () => {
    it('returns text-searched results across action, entityType, metadata', async () => {
      testState.selectResults = [
        [{ count: 1 }],
        [{ id: 'a1', action: 'purchase_order.created', entityType: 'purchase_order' }],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit?search=purchase');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].action).toBe('purchase_order.created');
    });
  });

  // ─── GET /audit — includeArchived filter ──────────────────────────

  describe('GET /audit with includeArchived', () => {
    it('executes UNION query when includeArchived=true', async () => {
      // UNION queries use db.execute, which returns raw results
      testState.executeResults = [
        [{ count: 3 }],  // count query
        [                  // data query
          { id: 'a1', action: 'part.created', timestamp: '2026-01-01T00:00:00.000Z' },
          { id: 'a2', action: 'part.updated', timestamp: '2025-12-01T00:00:00.000Z' },
          { id: 'a3', action: 'part.deactivated', timestamp: '2025-11-01T00:00:00.000Z' },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit?includeArchived=true');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(3);
      expect(response.body.pagination.total).toBe(3);
      // Verify db.execute was called (UNION path)
      expect(dbMock.execute).toHaveBeenCalled();
    });

    it('does not use UNION when includeArchived=false', async () => {
      testState.selectResults = [
        [{ count: 1 }],
        [{ id: 'a1', action: 'part.created' }],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit?includeArchived=false');

      expect(response.status).toBe(200);
      expect(dbMock.execute).not.toHaveBeenCalled();
      expect(dbMock.select).toHaveBeenCalled();
    });
  });

  // ─── GET /audit/actions — distinct actions ────────────────────────

  describe('GET /audit/actions', () => {
    it('returns distinct action values for the tenant', async () => {
      testState.selectDistinctResults = [
        [
          { action: 'part.created' },
          { action: 'part.updated' },
          { action: 'purchase_order.created' },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit/actions');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
        'part.created',
        'part.updated',
        'purchase_order.created',
      ]);
    });

    it('returns 401 without tenant context', async () => {
      const app = createTestApp(false);
      const response = await getJson(app, '/audit/actions');

      expect(response.status).toBe(401);
    });
  });

  // ─── GET /audit/entity-types — distinct entity types ──────────────

  describe('GET /audit/entity-types', () => {
    it('returns distinct entity type values for the tenant', async () => {
      testState.selectDistinctResults = [
        [
          { entityType: 'kanban_card' },
          { entityType: 'part' },
          { entityType: 'purchase_order' },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit/entity-types');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
        'kanban_card',
        'part',
        'purchase_order',
      ]);
    });

    it('returns 401 without tenant context', async () => {
      const app = createTestApp(false);
      const response = await getJson(app, '/audit/entity-types');

      expect(response.status).toBe(401);
    });
  });

  // ─── GET /audit/entity/:entityType/:entityId — entity history ─────

  describe('GET /audit/entity/:entityType/:entityId', () => {
    const validEntityId = '11111111-1111-4111-8111-111111111111';

    it('returns chronological history for one entity', async () => {
      testState.selectResults = [
        [{ count: 3 }],
        [
          { id: 'a1', action: 'part.created', timestamp: '2026-01-01T00:00:00.000Z' },
          { id: 'a2', action: 'part.updated', timestamp: '2026-01-02T00:00:00.000Z' },
          { id: 'a3', action: 'part.deactivated', timestamp: '2026-01-03T00:00:00.000Z' },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(app, `/audit/entity/part/${validEntityId}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(3);
      expect(response.body.pagination.total).toBe(3);
    });

    it('returns 400 for invalid entity ID format', async () => {
      const app = createTestApp();
      const response = await getJson(app, '/audit/entity/part/not-a-uuid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid entity ID format');
    });

    it('returns 401 without tenant context', async () => {
      const app = createTestApp(false);
      const response = await getJson(app, `/audit/entity/part/${validEntityId}`);

      expect(response.status).toBe(401);
    });

    it('supports includeArchived for entity history', async () => {
      testState.executeResults = [
        [{ count: 5 }],
        [
          { id: 'a1', action: 'part.created', timestamp: '2025-06-01T00:00:00.000Z' },
          { id: 'a2', action: 'part.updated', timestamp: '2025-07-01T00:00:00.000Z' },
          { id: 'a3', action: 'part.updated', timestamp: '2025-08-01T00:00:00.000Z' },
          { id: 'a4', action: 'part.updated', timestamp: '2026-01-01T00:00:00.000Z' },
          { id: 'a5', action: 'part.deactivated', timestamp: '2026-02-01T00:00:00.000Z' },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(
        app,
        `/audit/entity/part/${validEntityId}?includeArchived=true`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(5);
      expect(response.body.pagination.total).toBe(5);
      expect(dbMock.execute).toHaveBeenCalled();
    });

    it('paginates entity history correctly', async () => {
      testState.selectResults = [
        [{ count: 50 }],
        Array.from({ length: 10 }, (_, i) => ({
          id: `a${i + 1}`,
          action: 'part.updated',
          timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        })),
      ];

      const app = createTestApp();
      const response = await getJson(
        app,
        `/audit/entity/part/${validEntityId}?page=2&limit=10`,
      );

      expect(response.status).toBe(200);
      expect(response.body.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 50,
        pages: 5,
      });
    });
  });

  // ─── GET /audit — combined filters ────────────────────────────────

  describe('GET /audit with combined filters', () => {
    it('supports action + search combined', async () => {
      testState.selectResults = [
        [{ count: 1 }],
        [{ id: 'a1', action: 'part.created', metadata: { partNumber: 'ABC' } }],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit?action=part.created&search=ABC');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
    });

    it('supports entityType + dateFrom + dateTo', async () => {
      testState.selectResults = [
        [{ count: 2 }],
        [
          { id: 'a1', action: 'part.created' },
          { id: 'a2', action: 'part.updated' },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(
        app,
        '/audit?entityType=part&dateFrom=2026-01-01T00:00:00.000Z&dateTo=2026-01-31T23:59:59.999Z',
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
    });
  });

  // ─── Existing endpoints still work ────────────────────────────────

  describe('backward compatibility', () => {
    it('GET /audit without new filters works as before', async () => {
      testState.selectResults = [
        [{ count: 2 }],
        [
          { id: 'a1', action: 'purchase_order.created' },
          { id: 'a2', action: 'work_order.status_changed' },
        ],
      ];

      const app = createTestApp();
      const response = await getJson(app, '/audit?page=1&limit=20');

      expect(response.status).toBe(200);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        pages: 1,
      });
      expect(response.body.data).toHaveLength(2);
    });
  });
});
