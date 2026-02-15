import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Test State ─────────────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  insertQueue: [] as unknown[],
  updateQueue: [] as unknown[],
  auditEntries: [] as unknown[],
  publishedEvents: [] as unknown[],
  gmailSendResponse: null as Response | null,
}));

// ─── Schema Mock ────────────────────────────────────────────────────
const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  return {
    emailDrafts: table('email_drafts'),
    purchaseOrders: table('purchase_orders'),
    purchaseOrderLines: table('purchase_order_lines'),
    workOrders: table('work_orders'),
    transferOrders: table('transfer_orders'),
    transferOrderLines: table('transfer_order_lines'),
    suppliers: table('suppliers'),
    parts: table('parts'),
    supplierParts: table('supplier_parts'),
  };
});

// ─── DB Mock ────────────────────────────────────────────────────────
const dbMock = vi.hoisted(() => {
  function makeBuilder(resultFn: () => unknown) {
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.offset = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.values = vi.fn(() => builder);
    builder.set = vi.fn(() => builder);
    builder.returning = vi.fn(() => builder);
    builder.execute = vi.fn(async () => resultFn());
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(resultFn()).then(resolve, reject);
    return builder;
  }

  function createDbLike() {
    return {
      select: vi.fn(() => makeBuilder(() => testState.selectQueue.shift() ?? [])),
      insert: vi.fn(() => makeBuilder(() => [testState.insertQueue.shift() ?? { id: 'draft-1' }])),
      update: vi.fn(() => makeBuilder(() => [testState.updateQueue.shift() ?? { id: 'draft-1' }])),
    };
  }

  const dbLike = createDbLike();

  return {
    ...dbLike,
    transaction: vi.fn(async (fn: (tx: ReturnType<typeof createDbLike>) => Promise<unknown>) => {
      const tx = createDbLike();
      return fn(tx);
    }),
  };
});

// ─── Mocks ──────────────────────────────────────────────────────────
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: vi.fn(async (...args: unknown[]) => {
    testState.auditEntries.push(args);
    return { id: 'audit-1', hashChain: 'test', sequenceNumber: 1 };
  }),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: {
    REDIS_URL: 'redis://localhost:6379',
    NOTIFICATIONS_SERVICE_URL: 'http://localhost:3004',
    NOTIFICATIONS_SERVICE_PORT: 3004,
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({
    publish: vi.fn(async (event: unknown) => {
      testState.publishedEvents.push(event);
    }),
  })),
}));

// ─── Fetch Mock (intercept Gmail send, pass through to test server) ─
const originalFetch = globalThis.fetch;
vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  if (urlStr.includes('/gmail/send')) {
    if (testState.gmailSendResponse) return testState.gmailSendResponse;
    return new Response(JSON.stringify({ sent: true, messageId: 'gmail-msg-1', threadId: 'gmail-thread-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(url, init);
}));

// ─── App Setup ──────────────────────────────────────────────────────
import { emailOrdersRouter } from './email-orders.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import type { AuthRequest } from '@arda/auth-utils';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthRequest).user = {
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: 'user@arda.cards',
      role: 'tenant_admin',
    };
    next();
  });
  app.use('/email-orders', emailOrdersRouter);
  app.use(errorHandler);
  return app;
}

async function request(app: express.Application, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
    };
    if (body) options.body = JSON.stringify(body);
    const response = await originalFetch(`http://127.0.0.1:${address.port}${path}`, options);
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: response.status, data: data as Record<string, unknown> };
  } finally {
    server.close();
  }
}

// ─── Test Data ──────────────────────────────────────────────────────
const PO_ID = '00000000-0000-0000-0000-000000000010';
const SUPPLIER_ID = '00000000-0000-0000-0000-000000000020';
const PART1_ID = '00000000-0000-0000-0000-000000000030';
const PART2_ID = '00000000-0000-0000-0000-000000000031';

const mockPO = {
  id: PO_ID, tenantId: 'tenant-1', poNumber: 'PO-2024-001', supplierId: SUPPLIER_ID,
  facilityId: 'facility-1', status: 'approved', orderDate: new Date('2026-01-15'),
  expectedDeliveryDate: new Date('2026-02-15'), subtotal: '1000.00', taxAmount: '80.00',
  shippingAmount: '50.00', totalAmount: '1130.00', currency: 'USD',
  notes: 'Dock B', paymentTerms: 'Net 30', shippingTerms: 'FOB Origin',
  createdAt: new Date('2026-01-15'),
};

const mockPOLines = [
  { lineNumber: 1, quantityOrdered: 100, unitCost: '5.00', lineTotal: '500.00', notes: null, description: 'Hex bolt', partId: PART1_ID },
  { lineNumber: 2, quantityOrdered: 50, unitCost: '10.00', lineTotal: '500.00', notes: 'Urgent', description: null, partId: PART2_ID },
];

const mockSupplier = { id: SUPPLIER_ID, name: 'Acme', contactName: 'John', contactEmail: 'orders@acme.com' };
const mockParts = [{ id: PART1_ID, partNumber: 'HB-M8', name: 'Hex Bolt' }, { id: PART2_ID, partNumber: 'WH-10', name: 'Washer' }];
const mockSupplierParts = [{ partId: PART1_ID, supplierPartNumber: 'ACM-HB825' }];

const mockDraft = {
  id: 'draft-1', tenantId: 'tenant-1', orderId: PO_ID, orderType: 'purchase_order',
  status: 'draft', toRecipients: ['orders@acme.com'], ccRecipients: [], bccRecipients: [],
  subject: 'Order PO-2024-001 — Acme', htmlBody: '<html>test</html>', textBody: 'test',
  generatedHtmlBody: '<html>original</html>', gmailMessageId: null, gmailThreadId: null,
  sentAt: null, sentByUserId: null, errorMessage: null,
  metadata: { orderNumber: 'PO-2024-001', supplierName: 'Acme' },
  createdByUserId: 'user-1', createdAt: new Date(), updatedAt: new Date(),
};

// ─── Helper: Setup generate mocks ──────────────────────────────────
function setupGenerateMocks() {
  // fetchPurchaseOrderData calls: db.select (PO), db.select (lines), db.select (supplier), db.select (parts), db.select (supplierParts)
  // Then db.transaction -> tx.insert (draft) + writeAuditEntry
  testState.selectQueue = [
    [mockPO],           // PO lookup
    mockPOLines,        // PO lines
    [mockSupplier],     // Supplier
    mockParts,          // Parts
    mockSupplierParts,  // Supplier parts
  ];
  testState.insertQueue = [{ ...mockDraft, id: 'new-draft-1' }];
}

// ─── Tests ──────────────────────────────────────────────────────────
describe('Email Orders Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createApp();
    testState.selectQueue = [];
    testState.insertQueue = [];
    testState.updateQueue = [];
    testState.auditEntries = [];
    testState.publishedEvents = [];
    testState.gmailSendResponse = null;
    vi.clearAllMocks();
  });

  describe('POST /email-orders/generate', () => {
    it('should generate a draft email from a purchase order', async () => {
      setupGenerateMocks();

      const { status, data } = await request(app, 'POST', '/email-orders/generate', {
        orderId: PO_ID, orderType: 'purchase_order',
      });

      expect(status).toBe(201);
      expect(data.data).toBeDefined();
      expect(testState.auditEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should return 404 for non-existent order', async () => {
      testState.selectQueue = [[/* empty — PO not found */]];

      const { status } = await request(app, 'POST', '/email-orders/generate', {
        orderId: '00000000-0000-0000-0000-000000000001', orderType: 'purchase_order',
      });

      expect(status).toBe(404);
    });

    it('should return 400 for invalid payload', async () => {
      const { status } = await request(app, 'POST', '/email-orders/generate', {
        orderId: 'not-a-uuid', orderType: 'invalid_type',
      });

      expect(status).toBe(400);
    });

    it('should emit order.email_draft_created event', async () => {
      setupGenerateMocks();

      await request(app, 'POST', '/email-orders/generate', {
        orderId: PO_ID, orderType: 'purchase_order',
      });

      expect(testState.publishedEvents.length).toBe(1);
      const event = testState.publishedEvents[0] as Record<string, unknown>;
      expect(event.type).toBe('order.email_draft_created');
      expect(event.tenantId).toBe('tenant-1');
    });

    it('should set vendor email as recipient when available', async () => {
      setupGenerateMocks();

      const { status } = await request(app, 'POST', '/email-orders/generate', {
        orderId: PO_ID, orderType: 'purchase_order',
      });

      expect(status).toBe(201);
      // Audit entry should show toRecipients with vendor email
      const [, auditInput] = testState.auditEntries[0] as [unknown, Record<string, unknown>];
      const newState = auditInput.newState as Record<string, unknown>;
      expect(newState.toRecipients).toEqual(['orders@acme.com']);
    });
  });

  describe('GET /email-orders', () => {
    it('should list drafts for tenant', async () => {
      testState.selectQueue = [[mockDraft]];

      const { status, data } = await request(app, 'GET', '/email-orders');

      expect(status).toBe(200);
      expect(data.data).toHaveLength(1);
      expect(data.page).toBe(1);
    });

    it('should return empty list when no drafts', async () => {
      testState.selectQueue = [[]];

      const { status, data } = await request(app, 'GET', '/email-orders?status=sent');

      expect(status).toBe(200);
      expect(data.data).toHaveLength(0);
    });
  });

  describe('GET /email-orders/:draftId', () => {
    it('should return a single draft', async () => {
      testState.selectQueue = [[mockDraft]];

      const { status, data } = await request(app, 'GET', '/email-orders/00000000-0000-0000-0000-000000000001');

      expect(status).toBe(200);
      expect(data.data).toBeDefined();
    });

    it('should return 404 for non-existent draft', async () => {
      testState.selectQueue = [[]];

      const { status } = await request(app, 'GET', '/email-orders/00000000-0000-0000-0000-000000000001');

      expect(status).toBe(404);
    });
  });

  describe('PUT /email-orders/:draftId', () => {
    it('should update draft fields', async () => {
      const updatedDraft = { ...mockDraft, status: 'editing', subject: 'Updated Subject' };
      testState.selectQueue = [[mockDraft]]; // tx.select existing
      testState.updateQueue = [updatedDraft]; // tx.update returning

      const { status, data } = await request(app, 'PUT', '/email-orders/00000000-0000-0000-0000-000000000001', {
        subject: 'Updated Subject',
      });

      expect(status).toBe(200);
      expect(testState.auditEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should reject editing a sent draft', async () => {
      testState.selectQueue = [[{ ...mockDraft, status: 'sent' }]];

      const { status } = await request(app, 'PUT', '/email-orders/00000000-0000-0000-0000-000000000001', {
        subject: 'New Subject',
      });

      expect(status).toBe(409);
    });

    it('should return 404 for non-existent draft', async () => {
      testState.selectQueue = [[]];

      const { status } = await request(app, 'PUT', '/email-orders/00000000-0000-0000-0000-000000000001', {
        subject: 'test',
      });

      expect(status).toBe(404);
    });
  });

  describe('POST /email-orders/:draftId/ready', () => {
    it('should mark draft as ready', async () => {
      testState.selectQueue = [[mockDraft]];
      testState.updateQueue = [{ ...mockDraft, status: 'ready' }];

      const { status, data } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/ready');

      expect(status).toBe(200);
      expect(testState.auditEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should reject marking sent draft as ready', async () => {
      testState.selectQueue = [[{ ...mockDraft, status: 'sent' }]];

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/ready');

      expect(status).toBe(409);
    });

    it('should reject draft with no recipients', async () => {
      testState.selectQueue = [[{ ...mockDraft, toRecipients: [] }]];

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/ready');

      expect(status).toBe(400);
    });
  });

  describe('POST /email-orders/:draftId/send', () => {
    it('should send email via Gmail and update draft', async () => {
      // db.select for initial draft lookup
      testState.selectQueue = [[mockDraft]];
      // db.update for marking as "sending", then tx.update for "sent" + PO update
      testState.updateQueue = [
        { ...mockDraft, status: 'sending' },
        { ...mockDraft, status: 'sent', gmailMessageId: 'gmail-msg-1', sentAt: new Date() },
        { id: 'po-1' }, // PO status update
      ];

      const { status, data } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/send');

      expect(status).toBe(200);
      expect(testState.publishedEvents.length).toBe(1);
      const event = testState.publishedEvents[0] as Record<string, unknown>;
      expect(event.type).toBe('order.email_sent');
    });

    it('should reject sending already-sent draft', async () => {
      testState.selectQueue = [[{ ...mockDraft, status: 'sent' }]];

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/send');

      expect(status).toBe(409);
    });

    it('should reject draft with no recipients', async () => {
      testState.selectQueue = [[{ ...mockDraft, toRecipients: [] }]];

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/send');

      expect(status).toBe(400);
    });

    it('should handle Gmail API failure', async () => {
      testState.selectQueue = [[mockDraft]];
      testState.updateQueue = [
        { ...mockDraft, status: 'sending' },
        { ...mockDraft, status: 'failed' },
      ];
      testState.gmailSendResponse = new Response(JSON.stringify({ error: 'AUTH_EXPIRED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/send');

      expect(status).toBe(502);
    });

    it('should return 404 for non-existent draft', async () => {
      testState.selectQueue = [[]];

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/send');

      expect(status).toBe(404);
    });
  });

  describe('POST /email-orders/:draftId/reset', () => {
    it('should reset draft body to generated version', async () => {
      testState.selectQueue = [[mockDraft]];
      testState.updateQueue = [{ ...mockDraft, status: 'draft', htmlBody: mockDraft.generatedHtmlBody }];

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/reset');

      expect(status).toBe(200);
      expect(testState.auditEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should reject resetting a sent draft', async () => {
      testState.selectQueue = [[{ ...mockDraft, status: 'sent' }]];

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/reset');

      expect(status).toBe(409);
    });

    it('should reject reset when no generated body', async () => {
      testState.selectQueue = [[{ ...mockDraft, generatedHtmlBody: null }]];

      const { status } = await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/reset');

      expect(status).toBe(400);
    });
  });

  describe('Audit trail', () => {
    it('should create audit entry on generate with correct action', async () => {
      setupGenerateMocks();

      await request(app, 'POST', '/email-orders/generate', {
        orderId: PO_ID, orderType: 'purchase_order',
      });

      expect(testState.auditEntries.length).toBeGreaterThanOrEqual(1);
      const [, auditInput] = testState.auditEntries[0] as [unknown, Record<string, unknown>];
      expect(auditInput.action).toBe('email_draft.created');
      expect(auditInput.entityType).toBe('email_draft');
    });

    it('should create audit entry on send', async () => {
      testState.selectQueue = [[mockDraft]];
      testState.updateQueue = [
        { ...mockDraft, status: 'sending' },
        { ...mockDraft, status: 'sent', gmailMessageId: 'gmail-msg-1' },
        { id: 'po-1' },
      ];

      await request(app, 'POST', '/email-orders/00000000-0000-0000-0000-000000000001/send');

      expect(testState.auditEntries.length).toBeGreaterThanOrEqual(1);
      const [, auditInput] = testState.auditEntries[0] as [unknown, Record<string, unknown>];
      expect(auditInput.action).toBe('email_draft.sent');
    });
  });
});
