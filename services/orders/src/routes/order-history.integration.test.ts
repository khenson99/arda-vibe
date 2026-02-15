import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
  insertedRows: [] as unknown[],
  updatedRows: [] as unknown[],
  txResults: [] as unknown[],
  selectCallCount: 0,
}));

const schemaMock = vi.hoisted(() => {
  const col = (table: string, colName: string) => `${table}.${colName}`;
  return {
    purchaseOrders: {
      id: col('purchase_orders', 'id'),
      tenantId: col('purchase_orders', 'tenant_id'),
      poNumber: col('purchase_orders', 'po_number'),
      status: col('purchase_orders', 'status'),
      updatedAt: col('purchase_orders', 'updated_at'),
      createdAt: col('purchase_orders', 'created_at'),
    },
    purchaseOrderLines: {
      purchaseOrderId: col('purchase_order_lines', 'purchase_order_id'),
      tenantId: col('purchase_order_lines', 'tenant_id'),
      lineNumber: col('purchase_order_lines', 'line_number'),
    },
    workOrders: {
      id: col('work_orders', 'id'),
      tenantId: col('work_orders', 'tenant_id'),
      woNumber: col('work_orders', 'wo_number'),
      status: col('work_orders', 'status'),
      updatedAt: col('work_orders', 'updated_at'),
      createdAt: col('work_orders', 'created_at'),
    },
    workOrderRoutings: {
      workOrderId: col('work_order_routings', 'work_order_id'),
      tenantId: col('work_order_routings', 'tenant_id'),
      stepNumber: col('work_order_routings', 'step_number'),
    },
    transferOrders: {
      id: col('transfer_orders', 'id'),
      tenantId: col('transfer_orders', 'tenant_id'),
      toNumber: col('transfer_orders', 'to_number'),
      status: col('transfer_orders', 'status'),
      updatedAt: col('transfer_orders', 'updated_at'),
      createdAt: col('transfer_orders', 'created_at'),
    },
    transferOrderLines: {
      transferOrderId: col('transfer_order_lines', 'transfer_order_id'),
      tenantId: col('transfer_order_lines', 'tenant_id'),
    },
    receipts: {
      tenantId: col('receipts', 'tenant_id'),
      orderId: col('receipts', 'order_id'),
      createdAt: col('receipts', 'created_at'),
      id: col('receipts', 'id'),
    },
    receiptLines: {
      tenantId: col('receipt_lines', 'tenant_id'),
      receiptId: col('receipt_lines', 'receipt_id'),
    },
    receivingExceptions: {
      tenantId: col('receiving_exceptions', 'tenant_id'),
      receiptId: col('receiving_exceptions', 'receipt_id'),
    },
    orderIssues: {
      id: col('order_issues', 'id'),
      tenantId: col('order_issues', 'tenant_id'),
      orderId: col('order_issues', 'order_id'),
      orderType: col('order_issues', 'order_type'),
      status: col('order_issues', 'status'),
      category: col('order_issues', 'category'),
      priority: col('order_issues', 'priority'),
      createdAt: col('order_issues', 'created_at'),
    },
    orderIssueResolutionSteps: {
      tenantId: col('order_issue_resolution_steps', 'tenant_id'),
      issueId: col('order_issue_resolution_steps', 'issue_id'),
      actionType: col('order_issue_resolution_steps', 'action_type'),
      createdAt: col('order_issue_resolution_steps', 'created_at'),
    },
    orderNotes: {
      tenantId: col('order_notes', 'tenant_id'),
      orderId: col('order_notes', 'order_id'),
      createdAt: col('order_notes', 'created_at'),
    },
    auditLog: {
      tenantId: col('audit_log', 'tenant_id'),
      entityType: col('audit_log', 'entity_type'),
      entityId: col('audit_log', 'entity_id'),
      timestamp: col('audit_log', 'timestamp'),
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
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(getResult()).then(resolve, reject);
    return builder;
  }

  function makeInsertBuilder(getResult: () => unknown) {
    const builder: any = {};
    builder.values = () => builder;
    builder.returning = () => builder;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(getResult()).then(resolve, reject);
    return builder;
  }

  function makeUpdateBuilder(getResult: () => unknown) {
    const builder: any = {};
    builder.set = () => builder;
    builder.where = () => builder;
    builder.returning = () => builder;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(getResult()).then(resolve, reject);
    return builder;
  }

  const selectCallTracker = { count: 0 };

  const dbMock = {
    select: vi.fn(() => {
      const idx = selectCallTracker.count;
      selectCallTracker.count++;
      return makeSelectBuilder(() => testState.selectResults[idx] ?? []);
    }),
    selectDistinct: vi.fn(() =>
      makeSelectBuilder(() => testState.selectResults.shift() ?? []),
    ),
    insert: vi.fn(() =>
      makeInsertBuilder(() => testState.insertedRows.shift() ?? []),
    ),
    update: vi.fn(() =>
      makeUpdateBuilder(() => testState.updatedRows.shift() ?? []),
    ),
    transaction: vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
      const txMock = {
        select: vi.fn(() =>
          makeSelectBuilder(() => testState.txResults.shift() ?? []),
        ),
        insert: vi.fn(() =>
          makeInsertBuilder(() => testState.txResults.shift() ?? []),
        ),
        update: vi.fn(() =>
          makeUpdateBuilder(() => testState.txResults.shift() ?? []),
        ),
      };
      return cb(txMock);
    }),
    selectCallTracker,
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.selectDistinct.mockClear();
    dbMock.insert.mockClear();
    dbMock.update.mockClear();
    dbMock.transaction.mockClear();
    dbMock.selectCallTracker.count = 0;
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  asc: vi.fn((col: unknown) => ({ __asc: col })),
  desc: vi.fn((col: unknown) => ({ __desc: col })),
  eq: vi.fn((a: unknown, b: unknown) => ({ __eq: [a, b] })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ __inArray: [a, b] })),
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

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({ publish: vi.fn(async () => {}) })),
  publishKpiRefreshed: vi.fn(),
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@arda/observability', () => ({
  getCorrelationId: vi.fn(() => 'test-correlation-id'),
}));

import { orderHistoryRouter } from './order-history.routes.js';

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
  app.use('/order-history', orderHistoryRouter);
  app.use(
    (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
    },
  );
  return app;
}

async function getJson(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const text = await response.text();
    let body: Record<string, any>;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: Record<string, any>;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text };
    }
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function patchJson(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: Record<string, any>;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text };
    }
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';

// ─── Tests ──────────────────────────────────────────────────────────

describe('Order History API', () => {
  beforeEach(() => {
    testState.selectResults = [];
    testState.insertedRows = [];
    testState.updatedRows = [];
    testState.txResults = [];
    testState.selectCallCount = 0;
    resetDbMockCalls();
  });

  // ─── GET /order-history/detail/:orderType/:orderId ────────────────

  describe('GET /order-history/detail/:orderType/:orderId', () => {
    it('returns enriched PO detail with timeline, receipts, issues, and notes', async () => {
      const po = {
        id: ORDER_ID,
        tenantId: TENANT_ID,
        poNumber: 'PO-2026-0001',
        status: 'sent',
        supplierId: 'sup-1',
      };
      const poLines = [
        { id: 'line-1', lineNumber: 1, partId: 'part-1', quantityOrdered: 100 },
      ];
      const timeline = [
        { id: 'audit-1', action: 'purchase_order.created', timestamp: '2026-01-01' },
        { id: 'audit-2', action: 'purchase_order.status_changed', timestamp: '2026-01-02' },
      ];

      // Order detail: 7 sequential selects
      // 1. PO fetch
      testState.selectResults.push([po]);
      // 2. PO lines
      testState.selectResults.push(poLines);
      // 3. Audit timeline
      testState.selectResults.push(timeline);
      // 4. Receipts
      testState.selectResults.push([]);
      // 5. Issues
      testState.selectResults.push([]);
      // 6. Notes
      testState.selectResults.push([]);

      const app = createTestApp();
      const response = await getJson(
        app,
        `/order-history/detail/purchase_order/${ORDER_ID}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.order.poNumber).toBe('PO-2026-0001');
      expect(response.body.data.order.lines).toHaveLength(1);
      expect(response.body.data.timeline).toHaveLength(2);
      expect(response.body.data.receipts).toHaveLength(0);
      expect(response.body.data.issues).toHaveLength(0);
      expect(response.body.data.notes).toHaveLength(0);
    });

    it('returns 400 for invalid order type', async () => {
      const app = createTestApp();
      const response = await getJson(
        app,
        `/order-history/detail/invalid_type/${ORDER_ID}`,
      );
      expect(response.status).toBe(400);
    });

    it('returns 404 when order not found', async () => {
      testState.selectResults.push([]); // empty PO result

      const app = createTestApp();
      const response = await getJson(
        app,
        `/order-history/detail/purchase_order/${ORDER_ID}`,
      );
      expect(response.status).toBe(404);
    });

    it('includes receipts with exceptions for orders that have them', async () => {
      const po = { id: ORDER_ID, tenantId: TENANT_ID, poNumber: 'PO-2026-0002', status: 'received' };
      const receipt = { id: 'rcpt-1', tenantId: TENANT_ID, orderId: ORDER_ID, receiptNumber: 'RCV-001' };
      const rcptLine = { id: 'rl-1', receiptId: 'rcpt-1', quantityAccepted: 90 };
      const exception = { id: 'exc-1', receiptId: 'rcpt-1', exceptionType: 'short_shipment', status: 'open' };

      // 1. PO
      testState.selectResults.push([po]);
      // 2. PO lines
      testState.selectResults.push([]);
      // 3. Timeline
      testState.selectResults.push([]);
      // 4. Receipts
      testState.selectResults.push([receipt]);
      // 5. Receipt lines
      testState.selectResults.push([rcptLine]);
      // 6. Receiving exceptions
      testState.selectResults.push([exception]);
      // 7. Issues
      testState.selectResults.push([]);
      // 8. Notes
      testState.selectResults.push([]);

      const app = createTestApp();
      const response = await getJson(
        app,
        `/order-history/detail/purchase_order/${ORDER_ID}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.receipts).toHaveLength(1);
      expect(response.body.data.receipts[0].lines).toHaveLength(1);
      expect(response.body.data.receipts[0].exceptions).toHaveLength(1);
    });

    it('includes issues with resolution steps', async () => {
      const po = { id: ORDER_ID, tenantId: TENANT_ID, poNumber: 'PO-2026-0003', status: 'sent' };
      const issue = {
        id: ISSUE_ID,
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        category: 'wrong_items',
        status: 'in_progress',
        title: 'Wrong parts received',
      };
      const step = {
        id: 'step-1',
        issueId: ISSUE_ID,
        actionType: 'contact_vendor',
        description: 'Called supplier about wrong items',
      };

      // 1. PO
      testState.selectResults.push([po]);
      // 2. PO lines
      testState.selectResults.push([]);
      // 3. Timeline
      testState.selectResults.push([]);
      // 4. Receipts
      testState.selectResults.push([]);
      // 5. Issues
      testState.selectResults.push([issue]);
      // 6. Resolution steps
      testState.selectResults.push([step]);
      // 7. Notes
      testState.selectResults.push([]);

      const app = createTestApp();
      const response = await getJson(
        app,
        `/order-history/detail/purchase_order/${ORDER_ID}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.issues).toHaveLength(1);
      expect(response.body.data.issues[0].resolutionSteps).toHaveLength(1);
      expect(response.body.data.issues[0].resolutionSteps[0].actionType).toBe('contact_vendor');
    });
  });

  // ─── POST /order-history/issues ───────────────────────────────────

  describe('POST /order-history/issues', () => {
    it('creates an issue and returns 201', async () => {
      const createdIssue = {
        id: ISSUE_ID,
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        category: 'wrong_items',
        priority: 'high',
        status: 'open',
        title: 'Wrong items received',
      };

      // db.select: verifyOrderExists check (PO lookup)
      testState.selectResults.push([{ id: ORDER_ID }]);
      // TX: insert issue
      testState.txResults.push([createdIssue]);
      // TX: insert initial resolution step
      testState.txResults.push([{ id: 'step-1' }]);
      // TX: writeAuditEntry (handled by mock)

      const app = createTestApp();
      const response = await postJson(app, '/order-history/issues', {
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        category: 'wrong_items',
        priority: 'high',
        title: 'Wrong items received',
        description: 'Supplier sent wrong SKU',
      });

      expect(response.status).toBe(201);
      expect(response.body.data.category).toBe('wrong_items');
      expect(response.body.data.priority).toBe('high');
    });

    it('returns 400 for missing required fields', async () => {
      const app = createTestApp();
      const response = await postJson(app, '/order-history/issues', {
        orderId: ORDER_ID,
        // missing orderType, category, title
      });
      expect(response.status).toBe(400);
    });

    it('returns 404 when order does not exist', async () => {
      // db.select: verifyOrderExists returns empty
      testState.selectResults.push([]);

      const app = createTestApp();
      const response = await postJson(app, '/order-history/issues', {
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        category: 'damaged',
        title: 'Damaged goods',
      });
      expect(response.status).toBe(404);
    });
  });

  // ─── GET /order-history/issues ────────────────────────────────────

  describe('GET /order-history/issues', () => {
    it('returns paginated issues list', async () => {
      const issues = [
        { id: 'i1', status: 'open', category: 'damaged', title: 'Issue 1' },
        { id: 'i2', status: 'resolved', category: 'late_delivery', title: 'Issue 2' },
      ];

      // items query + count query (in parallel via Promise.all)
      testState.selectResults.push(issues);
      testState.selectResults.push([{ count: 2 }]);

      const app = createTestApp();
      const response = await getJson(app, '/order-history/issues');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.pagination.total).toBe(2);
    });

    it('filters by status', async () => {
      testState.selectResults.push([{ id: 'i1', status: 'open' }]);
      testState.selectResults.push([{ count: 1 }]);

      const app = createTestApp();
      const response = await getJson(app, '/order-history/issues?status=open');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
    });

    it('filters by category', async () => {
      testState.selectResults.push([{ id: 'i1', category: 'damaged' }]);
      testState.selectResults.push([{ count: 1 }]);

      const app = createTestApp();
      const response = await getJson(app, '/order-history/issues?category=damaged');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
    });
  });

  // ─── GET /order-history/issues/:issueId ───────────────────────────

  describe('GET /order-history/issues/:issueId', () => {
    it('returns issue with resolution steps', async () => {
      const issue = {
        id: ISSUE_ID,
        status: 'in_progress',
        category: 'wrong_quantity',
        title: 'Short shipment',
      };
      const steps = [
        { id: 'step-1', actionType: 'contact_vendor', description: 'Emailed vendor' },
        { id: 'step-2', actionType: 'credit_requested', description: 'Requested credit' },
      ];

      testState.selectResults.push([issue]);
      testState.selectResults.push(steps);

      const app = createTestApp();
      const response = await getJson(app, `/order-history/issues/${ISSUE_ID}`);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('in_progress');
      expect(response.body.data.resolutionSteps).toHaveLength(2);
    });

    it('returns 404 for nonexistent issue', async () => {
      testState.selectResults.push([]);

      const app = createTestApp();
      const response = await getJson(app, `/order-history/issues/${ISSUE_ID}`);
      expect(response.status).toBe(404);
    });
  });

  // ─── PATCH /order-history/issues/:issueId/status ──────────────────

  describe('PATCH /order-history/issues/:issueId/status', () => {
    it('transitions issue status and creates resolution step', async () => {
      const existing = {
        id: ISSUE_ID,
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        status: 'open',
        category: 'damaged',
      };
      const updated = { ...existing, status: 'in_progress' };

      // TX: fetch existing
      testState.txResults.push([existing]);
      // TX: update
      testState.txResults.push([updated]);
      // TX: insert resolution step
      testState.txResults.push([{ id: 'step-1' }]);
      // TX: writeAuditEntry

      const app = createTestApp();
      const response = await patchJson(
        app,
        `/order-history/issues/${ISSUE_ID}/status`,
        { status: 'in_progress' },
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('in_progress');
    });

    it('sets resolvedByUserId when resolving', async () => {
      const existing = {
        id: ISSUE_ID,
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        status: 'in_progress',
      };
      const resolved = {
        ...existing,
        status: 'resolved',
        resolvedByUserId: USER_ID,
        resolvedAt: new Date().toISOString(),
      };

      testState.txResults.push([existing]);
      testState.txResults.push([resolved]);
      testState.txResults.push([{ id: 'step-1' }]);

      const app = createTestApp();
      const response = await patchJson(
        app,
        `/order-history/issues/${ISSUE_ID}/status`,
        { status: 'resolved', description: 'Issue resolved via credit' },
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('resolved');
    });

    it('returns 409 when trying to change status of closed issue', async () => {
      testState.txResults.push([{
        id: ISSUE_ID,
        tenantId: TENANT_ID,
        status: 'closed',
      }]);

      const app = createTestApp();
      const response = await patchJson(
        app,
        `/order-history/issues/${ISSUE_ID}/status`,
        { status: 'open' },
      );

      expect(response.status).toBe(409);
    });

    it('returns 404 when issue not found', async () => {
      testState.txResults.push([]);

      const app = createTestApp();
      const response = await patchJson(
        app,
        `/order-history/issues/${ISSUE_ID}/status`,
        { status: 'in_progress' },
      );

      expect(response.status).toBe(404);
    });
  });

  // ─── POST /order-history/issues/:issueId/steps ────────────────────

  describe('POST /order-history/issues/:issueId/steps', () => {
    it('adds a resolution step and auto-transitions open issues to in_progress', async () => {
      const issue = {
        id: ISSUE_ID,
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        status: 'open',
      };
      const createdStep = {
        id: 'step-1',
        issueId: ISSUE_ID,
        actionType: 'contact_vendor',
        description: 'Called vendor about issue',
      };

      // TX: fetch issue
      testState.txResults.push([issue]);
      // TX: insert step
      testState.txResults.push([createdStep]);
      // TX: update issue status (auto-transition to in_progress)
      // TX: writeAuditEntry

      const app = createTestApp();
      const response = await postJson(
        app,
        `/order-history/issues/${ISSUE_ID}/steps`,
        {
          actionType: 'contact_vendor',
          description: 'Called vendor about issue',
        },
      );

      expect(response.status).toBe(201);
      expect(response.body.data.actionType).toBe('contact_vendor');
    });

    it('returns 409 when issue is closed', async () => {
      testState.txResults.push([{
        id: ISSUE_ID,
        tenantId: TENANT_ID,
        status: 'closed',
      }]);

      const app = createTestApp();
      const response = await postJson(
        app,
        `/order-history/issues/${ISSUE_ID}/steps`,
        { actionType: 'note_added', description: 'test' },
      );

      expect(response.status).toBe(409);
    });

    it('returns 404 when issue not found', async () => {
      testState.txResults.push([]);

      const app = createTestApp();
      const response = await postJson(
        app,
        `/order-history/issues/${ISSUE_ID}/steps`,
        { actionType: 'note_added' },
      );

      expect(response.status).toBe(404);
    });
  });

  // ─── POST /order-history/notes ────────────────────────────────────

  describe('POST /order-history/notes', () => {
    it('creates a note for an order', async () => {
      const createdNote = {
        id: 'note-1',
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        content: 'Vendor confirmed shipment date',
        createdByUserId: USER_ID,
      };

      // db.select: verifyOrderExists
      testState.selectResults.push([{ id: ORDER_ID }]);
      // TX: insert note
      testState.txResults.push([createdNote]);
      // TX: writeAuditEntry

      const app = createTestApp();
      const response = await postJson(app, '/order-history/notes', {
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        content: 'Vendor confirmed shipment date',
      });

      expect(response.status).toBe(201);
      expect(response.body.data.content).toBe('Vendor confirmed shipment date');
    });

    it('returns 400 for empty content', async () => {
      const app = createTestApp();
      const response = await postJson(app, '/order-history/notes', {
        orderId: ORDER_ID,
        orderType: 'purchase_order',
        content: '',
      });
      expect(response.status).toBe(400);
    });
  });

  // ─── GET /order-history — Order history list ──────────────────────

  describe('GET /order-history', () => {
    it('returns paginated order history with issue counts', async () => {
      const poItems = [
        { id: 'po-1', poNumber: 'PO-001', status: 'sent', updatedAt: '2026-02-10' },
      ];
      const poIssueCounts = [{ orderId: 'po-1', openIssues: 1, totalIssues: 2 }];

      // PO: items + count
      testState.selectResults.push(poItems);
      testState.selectResults.push([{ count: 1 }]);
      // PO: issue counts
      testState.selectResults.push(poIssueCounts);

      // WO: items + count
      testState.selectResults.push([]);
      testState.selectResults.push([{ count: 0 }]);

      // TO: items + count
      testState.selectResults.push([]);
      testState.selectResults.push([{ count: 0 }]);

      const app = createTestApp();
      const response = await getJson(app, '/order-history');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(response.body.pagination.total).toBe(1);
    });

    it('filters by orderType', async () => {
      const woItems = [
        { id: 'wo-1', woNumber: 'WO-001', status: 'in_progress', updatedAt: '2026-02-10' },
      ];

      testState.selectResults.push(woItems);
      testState.selectResults.push([{ count: 1 }]);
      testState.selectResults.push([]);

      const app = createTestApp();
      const response = await getJson(app, '/order-history?orderType=work_order');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
    });
  });
});
