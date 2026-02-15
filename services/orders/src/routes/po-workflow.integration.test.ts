import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Test State ─────────────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  selectQueue: [] as unknown[],
  insertQueue: [] as unknown[],
  updateQueue: [] as unknown[],
  auditEntries: [] as unknown[],
  publishedEvents: [] as unknown[],
}));

// ─── Schema Mock ────────────────────────────────────────────────────
const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  return {
    purchaseOrders: table('purchase_orders'),
    purchaseOrderLines: table('purchase_order_lines'),
    emailDrafts: table('email_drafts'),
    suppliers: table('suppliers'),
    parts: table('parts'),
    supplierParts: table('supplier_parts'),
    facilities: table('facilities'),
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
      update: vi.fn(() => makeBuilder(() => [testState.updateQueue.shift() ?? { id: 'po-1' }])),
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
  asc: vi.fn(() => ({})),
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
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({
    publish: vi.fn(async (event: unknown) => {
      testState.publishedEvents.push(event);
    }),
  })),
  publishKpiRefreshed: vi.fn(),
}));

vi.mock('@arda/observability', () => ({
  getCorrelationId: vi.fn(() => 'test-correlation-id'),
}));

vi.mock('../services/po-dispatch.service.js', () => ({
  buildPdfContent: vi.fn(() => 'PURCHASE ORDER: PO-2024-001\nDate: 2026-01-15\n...'),
  SimplePdfGenerator: vi.fn(),
}));

// ─── App Setup ──────────────────────────────────────────────────────
import { poWorkflowRouter } from './po-workflow.routes.js';
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
  app.use('/po-workflow', poWorkflowRouter);
  app.use(errorHandler);
  return app;
}

const originalFetch = globalThis.fetch;

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
const FACILITY_ID = '00000000-0000-0000-0000-000000000040';
const DRAFT_ID = '00000000-0000-0000-0000-000000000050';

const mockPO = {
  id: PO_ID, tenantId: 'tenant-1', poNumber: 'PO-2024-001', supplierId: SUPPLIER_ID,
  facilityId: FACILITY_ID, status: 'draft', orderDate: new Date('2026-01-15'),
  expectedDeliveryDate: new Date('2026-02-15'), subtotal: '1000.00', taxAmount: '80.00',
  shippingAmount: '50.00', totalAmount: '1130.00', currency: 'USD',
  notes: 'Dock B', paymentTerms: 'Net 30', shippingTerms: 'FOB Origin',
  createdAt: new Date('2026-01-15'), updatedAt: new Date('2026-01-15'),
  approvedAt: null, approvedByUserId: null, sentAt: null, sentToEmail: null,
};

const mockPOLines = [
  { id: 'line-1', lineNumber: 1, quantityOrdered: 100, unitCost: '5.00', lineTotal: '500.00', notes: null, description: 'Hex bolt', partId: PART1_ID, tenantId: 'tenant-1', purchaseOrderId: PO_ID },
  { id: 'line-2', lineNumber: 2, quantityOrdered: 50, unitCost: '10.00', lineTotal: '500.00', notes: 'Urgent', description: null, partId: PART2_ID, tenantId: 'tenant-1', purchaseOrderId: PO_ID },
];

const mockSupplier = {
  id: SUPPLIER_ID, name: 'Acme Corp', contactName: 'John Doe', contactEmail: 'orders@acme.com',
  addressLine1: '123 Main St', addressLine2: null, city: 'Anytown', state: 'CA',
  postalCode: '90210', country: 'US', tenantId: 'tenant-1',
};

const mockParts = [
  { id: PART1_ID, partNumber: 'HB-M8', name: 'Hex Bolt M8', uom: 'each' },
  { id: PART2_ID, partNumber: 'WH-10', name: 'Washer 10mm', uom: 'each' },
];
const mockSupplierParts = [{ partId: PART1_ID, supplierPartNumber: 'ACM-HB825' }];
const mockFacility = { name: 'Main Warehouse', code: 'MWH' };

const mockDraft = {
  id: DRAFT_ID, tenantId: 'tenant-1', orderId: PO_ID, orderType: 'purchase_order',
  status: 'draft', toRecipients: ['orders@acme.com'], ccRecipients: [], bccRecipients: [],
  subject: 'Purchase Order PO-2024-001 — Acme Corp', htmlBody: '<html>test</html>',
  textBody: 'test', generatedHtmlBody: '<html>original</html>',
  gmailMessageId: null, gmailThreadId: null, sentAt: null, sentByUserId: null,
  errorMessage: null, metadata: { orderNumber: 'PO-2024-001', supplierName: 'Acme Corp' },
  createdByUserId: 'user-1', createdAt: new Date(), updatedAt: new Date(),
};

// ─── Helpers for setting up select queue ────────────────────────────

/** Sets up the mock queue for fetchPOPreviewData: PO, lines, supplier, parts, supplierParts, facility */
function setupPreviewMocks(poOverride?: Partial<typeof mockPO>) {
  testState.selectQueue = [
    [{ ...mockPO, ...poOverride }], // PO lookup
    mockPOLines,                     // PO lines
    [mockSupplier],                  // Supplier
    mockParts,                       // Parts
    mockSupplierParts,               // Supplier parts
    [mockFacility],                  // Facility
  ];
}

// ─── Tests ──────────────────────────────────────────────────────────
describe('PO Workflow Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createApp();
    testState.selectQueue = [];
    testState.insertQueue = [];
    testState.updateQueue = [];
    testState.auditEntries = [];
    testState.publishedEvents = [];
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /po-workflow/:poId/preview
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /po-workflow/:poId/preview', () => {
    it('should return formatted PO preview with all fields', async () => {
      setupPreviewMocks();

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/preview`);

      expect(status).toBe(200);
      const result = data.data as Record<string, unknown>;
      expect(result.poId).toBe(PO_ID);
      expect(result.poNumber).toBe('PO-2024-001');
      expect(result.status).toBe('draft');
      expect(result.supplierName).toBe('Acme Corp');
      expect(result.supplierEmail).toBe('orders@acme.com');
      expect(result.lineCount).toBe(2);
      expect(result.canApprove).toBe(true);
      expect(typeof result.previewHtml).toBe('string');
      expect((result.previewHtml as string)).toContain('PO-2024-001');
      expect(typeof result.pdfContent).toBe('string');
    });

    it('should set canApprove=true for draft status', async () => {
      setupPreviewMocks({ status: 'draft' });

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/preview`);

      expect(status).toBe(200);
      expect((data.data as Record<string, unknown>).canApprove).toBe(true);
    });

    it('should set canApprove=true for pending_approval status', async () => {
      setupPreviewMocks({ status: 'pending_approval' });

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/preview`);

      expect(status).toBe(200);
      expect((data.data as Record<string, unknown>).canApprove).toBe(true);
    });

    it('should set canApprove=false for approved status', async () => {
      setupPreviewMocks({ status: 'approved' });

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/preview`);

      expect(status).toBe(200);
      expect((data.data as Record<string, unknown>).canApprove).toBe(false);
    });

    it('should return 404 for non-existent PO', async () => {
      testState.selectQueue = [[/* empty */]];

      const { status } = await request(app, 'GET', `/po-workflow/${PO_ID}/preview`);

      expect(status).toBe(404);
    });

    it('should return 400 for invalid PO ID', async () => {
      const { status } = await request(app, 'GET', '/po-workflow/not-a-uuid/preview');

      expect(status).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /po-workflow/:poId/approve
  // ═══════════════════════════════════════════════════════════════════
  describe('POST /po-workflow/:poId/approve', () => {
    it('should approve PO and auto-generate email draft', async () => {
      setupPreviewMocks({ status: 'draft' });
      // tx.update (PO) returning, tx.insert (draft) returning
      testState.updateQueue = [{ ...mockPO, status: 'approved', approvedByUserId: 'user-1' }];
      testState.insertQueue = [{ ...mockDraft, id: 'new-draft-1' }];

      const { status, data } = await request(app, 'POST', `/po-workflow/${PO_ID}/approve`, {});

      expect(status).toBe(200);
      const result = data.data as Record<string, unknown>;
      expect(result.purchaseOrder).toBeDefined();
      expect(result.emailDraft).toBeDefined();
      expect((result.purchaseOrder as Record<string, unknown>).status).toBe('approved');
    });

    it('should write audit entries for both approval and draft creation', async () => {
      setupPreviewMocks({ status: 'pending_approval' });
      testState.updateQueue = [{ ...mockPO, status: 'approved' }];
      testState.insertQueue = [{ ...mockDraft, id: 'new-draft-2' }];

      await request(app, 'POST', `/po-workflow/${PO_ID}/approve`, {});

      // Should have 2 audit entries: PO approval + email draft creation
      expect(testState.auditEntries.length).toBe(2);
      const approvalAudit = (testState.auditEntries[0] as unknown[])[1] as Record<string, unknown>;
      expect(approvalAudit.action).toBe('purchase_order.approved');
      const draftAudit = (testState.auditEntries[1] as unknown[])[1] as Record<string, unknown>;
      expect(draftAudit.action).toBe('email_draft.created');
    });

    it('should publish order.status_changed and order.email_draft_created events', async () => {
      setupPreviewMocks({ status: 'draft' });
      testState.updateQueue = [{ ...mockPO, status: 'approved' }];
      testState.insertQueue = [{ ...mockDraft, id: 'new-draft-3' }];

      await request(app, 'POST', `/po-workflow/${PO_ID}/approve`, {});

      expect(testState.publishedEvents.length).toBe(2);
      const statusEvent = testState.publishedEvents[0] as Record<string, unknown>;
      expect(statusEvent.type).toBe('order.status_changed');
      expect(statusEvent.toStatus).toBe('approved');
      const draftEvent = testState.publishedEvents[1] as Record<string, unknown>;
      expect(draftEvent.type).toBe('order.email_draft_created');
    });

    it('should approve without generating email draft when generateEmailDraft=false', async () => {
      setupPreviewMocks({ status: 'draft' });
      testState.updateQueue = [{ ...mockPO, status: 'approved' }];

      const { status, data } = await request(app, 'POST', `/po-workflow/${PO_ID}/approve`, {
        generateEmailDraft: false,
      });

      expect(status).toBe(200);
      const result = data.data as Record<string, unknown>;
      expect(result.purchaseOrder).toBeDefined();
      expect(result.emailDraft).toBeNull();
      // Only 1 audit entry (approval only)
      expect(testState.auditEntries.length).toBe(1);
      // Only 1 event (status_changed only)
      expect(testState.publishedEvents.length).toBe(1);
    });

    it('should return 409 for already-approved PO', async () => {
      setupPreviewMocks({ status: 'approved' });

      const { status, data } = await request(app, 'POST', `/po-workflow/${PO_ID}/approve`, {});

      expect(status).toBe(409);
      expect((data as Record<string, unknown>).error).toContain('approved');
    });

    it('should return 409 for sent PO', async () => {
      setupPreviewMocks({ status: 'sent' });

      const { status } = await request(app, 'POST', `/po-workflow/${PO_ID}/approve`, {});

      expect(status).toBe(409);
    });

    it('should return 404 for non-existent PO', async () => {
      testState.selectQueue = [[/* empty */]];

      const { status } = await request(app, 'POST', `/po-workflow/${PO_ID}/approve`, {});

      expect(status).toBe(404);
    });

    it('should pre-populate email draft with vendor email', async () => {
      setupPreviewMocks({ status: 'draft' });
      let capturedInsert: Record<string, unknown> | null = null;
      testState.updateQueue = [{ ...mockPO, status: 'approved' }];
      testState.insertQueue = [{ ...mockDraft, id: 'new-draft-4' }];

      // Override transaction to capture the insert values
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dbMock.transaction.mockImplementationOnce(async (fn: any) => {
        const txProxy = {
          update: vi.fn(() => {
            const builder: Record<string, unknown> = {};
            builder.set = vi.fn(() => builder);
            builder.where = vi.fn(() => builder);
            builder.returning = vi.fn(() => builder);
            builder.then = (resolve: (v: unknown) => unknown) =>
              resolve([{ ...mockPO, status: 'approved', approvedByUserId: 'user-1' }]);
            return builder;
          }),
          insert: vi.fn(() => {
            const builder: Record<string, unknown> = {};
            builder.values = vi.fn((vals: Record<string, unknown>) => {
              capturedInsert = vals;
              return builder;
            });
            builder.returning = vi.fn(() => builder);
            builder.then = (resolve: (v: unknown) => unknown) =>
              resolve([{ ...mockDraft, id: 'new-draft-5' }]);
            return builder;
          }),
        };
        return fn(txProxy);
      });

      await request(app, 'POST', `/po-workflow/${PO_ID}/approve`, {});

      expect(capturedInsert).not.toBeNull();
      expect(capturedInsert!.toRecipients).toEqual(['orders@acme.com']);
      expect(capturedInsert!.subject).toContain('PO-2024-001');
      expect(capturedInsert!.subject).toContain('Acme Corp');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /po-workflow/:poId/status
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /po-workflow/:poId/status', () => {
    it('should return draft workflow step for draft PO with no email draft', async () => {
      testState.selectQueue = [
        [mockPO],     // PO lookup
        [],           // No email draft
      ];

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(200);
      const result = data.data as Record<string, unknown>;
      expect(result.poStatus).toBe('draft');
      expect(result.workflowStep).toBe('draft');
      expect(result.emailDraft).toBeNull();
      expect(result.steps).toBeDefined();
    });

    it('should return approved workflow step for approved PO with no email draft', async () => {
      testState.selectQueue = [
        [{ ...mockPO, status: 'approved', approvedAt: new Date(), approvedByUserId: 'user-1' }],
        [],
      ];

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(200);
      const result = data.data as Record<string, unknown>;
      expect(result.workflowStep).toBe('approved');
    });

    it('should return email_editing step when PO is approved with a draft email', async () => {
      testState.selectQueue = [
        [{ ...mockPO, status: 'approved' }],
        [{ ...mockDraft, status: 'draft' }],
      ];

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(200);
      const result = data.data as Record<string, unknown>;
      expect(result.workflowStep).toBe('email_editing');
      expect(result.emailDraft).toBeDefined();
    });

    it('should return email_ready step when draft is marked ready', async () => {
      testState.selectQueue = [
        [{ ...mockPO, status: 'approved' }],
        [{ ...mockDraft, status: 'ready' }],
      ];

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(200);
      expect((data.data as Record<string, unknown>).workflowStep).toBe('email_ready');
    });

    it('should return sent step when email draft is sent', async () => {
      testState.selectQueue = [
        [{ ...mockPO, status: 'approved' }],
        [{ ...mockDraft, status: 'sent', sentAt: new Date() }],
      ];

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(200);
      expect((data.data as Record<string, unknown>).workflowStep).toBe('sent');
    });

    it('should return failed step when email send failed', async () => {
      testState.selectQueue = [
        [{ ...mockPO, status: 'approved' }],
        [{ ...mockDraft, status: 'failed', errorMessage: 'Gmail API error' }],
      ];

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(200);
      expect((data.data as Record<string, unknown>).workflowStep).toBe('failed');
    });

    it('should return cancelled step for cancelled PO', async () => {
      testState.selectQueue = [
        [{ ...mockPO, status: 'cancelled' }],
        [],
      ];

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(200);
      expect((data.data as Record<string, unknown>).workflowStep).toBe('cancelled');
    });

    it('should include workflow steps with completion status', async () => {
      testState.selectQueue = [
        [{ ...mockPO, status: 'approved' }],
        [{ ...mockDraft, status: 'ready' }],
      ];

      const { status, data } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(200);
      const steps = (data.data as Record<string, unknown>).steps as Array<{ step: string; completed: boolean }>;
      expect(steps).toHaveLength(6);

      const draftStep = steps.find((s) => s.step === 'draft');
      expect(draftStep?.completed).toBe(true);

      const approvedStep = steps.find((s) => s.step === 'approved');
      expect(approvedStep?.completed).toBe(true);

      const emailEditStep = steps.find((s) => s.step === 'email_editing');
      expect(emailEditStep?.completed).toBe(true);

      const sentStep = steps.find((s) => s.step === 'sent');
      expect(sentStep?.completed).toBe(false);
    });

    it('should return 404 for non-existent PO', async () => {
      testState.selectQueue = [[/* empty */]];

      const { status } = await request(app, 'GET', `/po-workflow/${PO_ID}/status`);

      expect(status).toBe(404);
    });

    it('should return 400 for invalid PO ID', async () => {
      const { status } = await request(app, 'GET', '/po-workflow/not-a-uuid/status');

      expect(status).toBe(400);
    });
  });
});
