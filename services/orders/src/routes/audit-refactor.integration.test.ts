/**
 * Integration tests for audit refactor (Ticket #253)
 *
 * Validates that orders service audit writes use the shared writeAuditEntry()
 * from @arda/db, with correct action names, entity types, previousState/newState
 * snapshots, and metadata including systemActor for system-initiated actions.
 */
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntryInput } from '@arda/db';

// ─── Mocks (hoisted) ────────────────────────────────────────────────

const { writeAuditEntryMock, writeAuditEntriesMock, auditCalls } = vi.hoisted(() => {
  const auditCalls: AuditEntryInput[] = [];
  const writeAuditEntryMock = vi.fn(async (_dbOrTx: unknown, entry: AuditEntryInput) => {
    auditCalls.push(entry);
    return { id: `audit-${auditCalls.length}`, hashChain: 'test-hash', sequenceNumber: auditCalls.length };
  });
  const writeAuditEntriesMock = vi.fn(
    async (_dbOrTx: unknown, _tenantId: string, entries: Omit<AuditEntryInput, 'tenantId'>[]) => {
      entries.forEach((entry) => {
        auditCalls.push({ ...entry, tenantId: _tenantId });
      });
      return entries.map((_, i) => ({
        id: `audit-batch-${i}`,
        hashChain: `test-hash-${i}`,
        sequenceNumber: i + 1,
      }));
    }
  );
  return { writeAuditEntryMock, writeAuditEntriesMock, auditCalls };
});

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);
  return {
    purchaseOrders: table('purchase_orders'),
    purchaseOrderLines: table('purchase_order_lines'),
    auditLog: table('audit_log'),
  };
});

const { dbMock } = vi.hoisted(() => {
  function queryResult<T>(result: T) {
    return {
      execute: async () => result,
      then: (
        resolve: (value: T) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
      returning: async () => result,
    };
  }

  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => builder;
    builder.orderBy = () => builder;
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  function makeUpdateBuilder() {
    const query: any = {};
    query.set = () => query;
    query.where = () => query;
    query.execute = async () => undefined;
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(undefined).then(resolve, reject);
    query.returning = async () => [];
    return query;
  }

  function makeTx() {
    const tx: any = {};
    tx.select = vi.fn(() =>
      makeSelectBuilder([
        {
          id: 'po-1',
          poNumber: 'PO-1001',
          status: 'draft',
          tenantId: 'tenant-1',
          totalAmount: '100.00',
        },
      ])
    );
    tx.update = vi.fn(() => makeUpdateBuilder());
    tx.insert = vi.fn((_table: unknown) => ({
      values: (values: unknown) => {
        const rows = Array.isArray(values) ? values : [values];
        const tableName = (_table as { __table?: string }).__table;

        if (tableName === 'purchase_orders') {
          const row = rows[0] as Record<string, unknown>;
          return queryResult([
            {
              id: 'po-1',
              poNumber: row.poNumber ?? 'PO-1001',
              status: row.status ?? 'draft',
              tenantId: row.tenantId,
              totalAmount: row.totalAmount ?? '100.00',
            },
          ]);
        }

        if (tableName === 'purchase_order_lines') {
          return queryResult(
            rows.map((row: any, index: number) => ({
              id: `pol-${index + 1}`,
              ...row,
              quantityReceived: row.quantityReceived ?? 0,
            }))
          );
        }

        return queryResult([]);
      },
    }));
    return tx;
  }

  const dbMock = {
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
    select: vi.fn(() =>
      makeSelectBuilder([
        {
          id: 'po-1',
          poNumber: 'PO-1001',
          status: 'draft',
          tenantId: 'tenant-1',
          totalAmount: '100.00',
          supplierId: 'sup-1',
          facilityId: 'fac-1',
        },
      ])
    ),
    update: vi.fn(() => makeUpdateBuilder()),
    insert: vi.fn(() => ({
      values: () => queryResult([]),
    })),
  };

  return { dbMock };
});

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

// ─── Module Mocks ────────────────────────────────────────────────────

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: writeAuditEntryMock,
  writeAuditEntries: writeAuditEntriesMock,
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
  publishKpiRefreshed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@arda/observability', () => ({
  getCorrelationId: vi.fn(() => 'test-corr-id'),
  correlationMiddleware: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/order-number.service.js', () => ({
  getNextPONumber: vi.fn(async () => 'PO-1001'),
  getNextWONumber: vi.fn(async () => 'WO-1001'),
  getNextTONumber: vi.fn(async () => 'TO-1001'),
}));

vi.mock('../services/po-dispatch.service.js', () => ({
  SmtpEmailAdapter: vi.fn(),
  SimplePdfGenerator: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────

import { purchaseOrdersRouter } from './purchase-orders.routes.js';

// ─── Test Helpers ────────────────────────────────────────────────────

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { tenantId: 'tenant-1', sub: 'user-1' };
    next();
  });
  app.use('/po', purchaseOrdersRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function postJson(
  app: express.Express,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.5',
        'user-agent': 'vitest-agent',
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json();
    return { status: response.status, body: responseBody as Record<string, any> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function patchJson(
  app: express.Express,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.5',
        'user-agent': 'vitest-agent',
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json();
    return { status: response.status, body: responseBody as Record<string, any> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Audit Refactor — writeAuditEntry integration', () => {
  beforeEach(() => {
    auditCalls.length = 0;
    writeAuditEntryMock.mockClear();
    writeAuditEntriesMock.mockClear();
    publishMock.mockClear();
  });

  describe('PO create', () => {
    it('calls writeAuditEntry with purchase_order.created action', async () => {
      const app = createTestApp();
      const result = await postJson(app, '/po', {
        supplierId: '11111111-1111-4111-8111-111111111111',
        facilityId: '22222222-2222-4222-8222-222222222222',
        expectedDeliveryDate: '2026-03-01T00:00:00Z',
        lines: [
          {
            partId: '33333333-3333-4333-8333-333333333333',
            lineNumber: 1,
            quantityOrdered: 10,
            unitCost: 5.5,
          },
        ],
      });

      expect(result.status).toBe(201);
      expect(writeAuditEntryMock).toHaveBeenCalled();

      const createAudit = auditCalls.find((c) => c.action === 'purchase_order.created');
      expect(createAudit).toBeDefined();
      expect(createAudit?.tenantId).toBe('tenant-1');
      expect(createAudit?.userId).toBe('user-1');
      expect(createAudit?.entityType).toBe('purchase_order');
      expect(createAudit?.previousState).toBeNull();
      expect(createAudit?.newState).toMatchObject({
        status: 'draft',
      });
      expect(createAudit?.metadata).toMatchObject({
        source: 'purchase_orders.create',
        orderNumber: 'PO-1001',
      });
      expect(createAudit?.ipAddress).toBe('203.0.113.5');
      expect(createAudit?.userAgent).toBe('vitest-agent');
    });
  });

  describe('PO status change', () => {
    it('calls writeAuditEntry with purchase_order.status_changed inside a transaction', async () => {
      const app = createTestApp();
      const result = await patchJson(app, '/po/po-1/status', {
        status: 'pending_approval',
      });

      expect(result.status).toBe(200);
      expect(writeAuditEntryMock).toHaveBeenCalled();

      const statusAudit = auditCalls.find(
        (c) => c.action === 'purchase_order.status_changed'
      );
      expect(statusAudit).toBeDefined();
      expect(statusAudit?.tenantId).toBe('tenant-1');
      expect(statusAudit?.userId).toBe('user-1');
      expect(statusAudit?.entityType).toBe('purchase_order');
      expect(statusAudit?.previousState).toMatchObject({ status: 'draft' });
      expect(statusAudit?.newState).toMatchObject({ status: 'pending_approval' });
      expect(statusAudit?.metadata).toMatchObject({
        source: 'purchase_orders.status',
        orderNumber: 'PO-1001',
      });

      // Verify transaction was used (mutation + audit in same tx)
      expect(dbMock.transaction).toHaveBeenCalled();
    });

    it('includes cancelReason in metadata for cancellation', async () => {
      const app = createTestApp();
      const result = await patchJson(app, '/po/po-1/status', {
        status: 'cancelled',
        cancelReason: 'Supplier issue',
      });

      // The mock returns 'draft' status PO, and draft -> cancelled is a valid transition
      expect(result.status).toBe(200);

      const cancelAudit = auditCalls.find(
        (c) => c.action === 'purchase_order.status_changed' && (c.metadata as any)?.cancelReason
      );
      expect(cancelAudit).toBeDefined();
      expect(cancelAudit?.newState).toMatchObject({ status: 'cancelled' });
      expect(cancelAudit?.metadata).toMatchObject({ cancelReason: 'Supplier issue' });
    });
  });

  describe('PO line add', () => {
    it('calls writeAuditEntry with purchase_order.line_added action', async () => {
      const app = createTestApp();
      const result = await postJson(app, '/po/po-1/lines', {
        partId: '33333333-3333-4333-8333-333333333333',
        lineNumber: 2,
        quantityOrdered: 5,
        unitCost: 10,
      });

      expect(result.status).toBe(201);

      const lineAudit = auditCalls.find((c) => c.action === 'purchase_order.line_added');
      expect(lineAudit).toBeDefined();
      expect(lineAudit?.entityType).toBe('purchase_order');
      expect(lineAudit?.previousState).toHaveProperty('totalAmount');
      expect(lineAudit?.newState).toHaveProperty('totalAmount');
      expect(lineAudit?.newState).toHaveProperty('lineId');
      expect(lineAudit?.metadata).toMatchObject({
        source: 'purchase_orders.add_line',
      });
    });
  });

  describe('audit entry structure', () => {
    it('never passes timestamp — writeAuditEntry uses its own timestamp', async () => {
      const app = createTestApp();
      await postJson(app, '/po', {
        supplierId: '11111111-1111-4111-8111-111111111111',
        facilityId: '22222222-2222-4222-8222-222222222222',
        expectedDeliveryDate: '2026-03-01T00:00:00Z',
        lines: [
          { partId: '33333333-3333-4333-8333-333333333333', lineNumber: 1, quantityOrdered: 10, unitCost: 5.5 },
        ],
      });

      // The writeAuditEntry call should NOT have an explicit timestamp
      // (the shared writer generates one internally)
      for (const call of auditCalls) {
        expect(call.timestamp).toBeUndefined();
      }
    });

    it('passes ipAddress and userAgent from request headers', async () => {
      const app = createTestApp();
      await postJson(app, '/po', {
        supplierId: '11111111-1111-4111-8111-111111111111',
        facilityId: '22222222-2222-4222-8222-222222222222',
        expectedDeliveryDate: '2026-03-01T00:00:00Z',
        lines: [
          { partId: '33333333-3333-4333-8333-333333333333', lineNumber: 1, quantityOrdered: 10, unitCost: 5.5 },
        ],
      });

      expect(auditCalls.length).toBeGreaterThan(0);
      const entry = auditCalls[0];
      expect(entry.ipAddress).toBe('203.0.113.5');
      expect(entry.userAgent).toBe('vitest-agent');
    });
  });
});
