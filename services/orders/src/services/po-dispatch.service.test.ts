import { describe, expect, it, vi } from 'vitest';

vi.mock('@arda/config', () => ({
  config: {
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: 'noreply@arda.cards',
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  buildPdfContent,
  ConsoleEmailAdapter,
  SimplePdfGenerator,
  PODispatchService,
  type PurchaseOrderPdfData,
  type DispatchInput,
  type EmailAdapter,
} from './po-dispatch.service.js';

// ─── Test Data ───────────────────────────────────────────────────────

function makePdfData(overrides: Partial<PurchaseOrderPdfData> = {}): PurchaseOrderPdfData {
  return {
    poNumber: 'PO-20250601-0001',
    orderDate: '2025-06-01',
    expectedDeliveryDate: '2025-06-15',
    supplierName: 'Acme Corp',
    supplierContact: 'John Smith',
    supplierEmail: 'john@acme.com',
    supplierAddress: '123 Main St, Springfield',
    buyerCompanyName: 'Arda Industries',
    buyerAddress: '456 Oak Ave, Metropolis',
    facilityName: 'Main Warehouse',
    lines: [
      {
        lineNumber: 1,
        partNumber: 'PN-001',
        partName: 'Widget A',
        quantity: 100,
        unitCost: '5.00',
        lineTotal: '500.00',
        uom: 'each',
      },
      {
        lineNumber: 2,
        partNumber: 'PN-002',
        partName: 'Gasket B',
        quantity: 50,
        unitCost: '12.50',
        lineTotal: '625.00',
        uom: 'each',
      },
    ],
    subtotal: '1125.00',
    taxAmount: '0.00',
    shippingAmount: '0.00',
    totalAmount: '1125.00',
    currency: 'USD',
    notes: 'Rush delivery requested',
    terms: 'Net 30',
    ...overrides,
  };
}

function makeDispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    poNumber: 'PO-20250601-0001',
    supplierEmail: 'john@acme.com',
    supplierName: 'Acme Corp',
    pdfData: makePdfData(),
    ...overrides,
  };
}

// ─── buildPdfContent ─────────────────────────────────────────────────
describe('buildPdfContent', () => {
  it('includes the PO number in the header', () => {
    const content = buildPdfContent(makePdfData());
    expect(content).toContain('PO-20250601-0001');
  });

  it('includes supplier and buyer info', () => {
    const content = buildPdfContent(makePdfData());
    expect(content).toContain('Acme Corp');
    expect(content).toContain('Arda Industries');
  });

  it('includes all line items', () => {
    const content = buildPdfContent(makePdfData());
    expect(content).toContain('PN-001');
    expect(content).toContain('PN-002');
    expect(content).toContain('Widget A');
    expect(content).toContain('Gasket B');
  });

  it('includes totals', () => {
    const content = buildPdfContent(makePdfData());
    expect(content).toContain('1125.00');
    expect(content).toContain('TOTAL:');
  });

  it('includes notes and terms when provided', () => {
    const content = buildPdfContent(makePdfData());
    expect(content).toContain('Rush delivery requested');
    expect(content).toContain('Net 30');
  });

  it('omits notes line when not provided', () => {
    const content = buildPdfContent(makePdfData({ notes: undefined }));
    expect(content).not.toContain('Notes:');
  });
});

// ─── ConsoleEmailAdapter ─────────────────────────────────────────────
describe('ConsoleEmailAdapter', () => {
  it('captures sent messages', async () => {
    const adapter = new ConsoleEmailAdapter();
    const result = await adapter.send({
      to: 'test@example.com',
      subject: 'Test',
      bodyHtml: '<p>Test</p>',
      bodyText: 'Test',
      attachments: [],
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBeTruthy();
    expect(adapter.sentMessages).toHaveLength(1);
  });
});

// ─── SimplePdfGenerator ──────────────────────────────────────────────
describe('SimplePdfGenerator', () => {
  it('returns a Buffer', async () => {
    const generator = new SimplePdfGenerator();
    const buffer = await generator.generatePurchaseOrderPdf(makePdfData());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('contains PO data in the buffer', async () => {
    const generator = new SimplePdfGenerator();
    const buffer = await generator.generatePurchaseOrderPdf(makePdfData());
    const text = buffer.toString('utf-8');
    expect(text).toContain('PO-20250601-0001');
  });
});

// ─── PODispatchService ───────────────────────────────────────────────
describe('PODispatchService', () => {
  it('dispatches successfully on first attempt', async () => {
    const emailAdapter = new ConsoleEmailAdapter();
    const pdfGenerator = new SimplePdfGenerator();

    const service = new PODispatchService({ emailAdapter, pdfGenerator });
    const result = await service.dispatch(makeDispatchInput());

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.messageId).toBeTruthy();
    expect(emailAdapter.sentMessages).toHaveLength(1);
    expect(emailAdapter.sentMessages[0].to).toBe('john@acme.com');
    expect(emailAdapter.sentMessages[0].attachments).toHaveLength(1);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    let callCount = 0;
    const flakyAdapter: EmailAdapter = {
      send: async (message) => {
        callCount++;
        if (callCount === 1) throw new Error('Temporary failure');
        return { messageId: 'retry-success', success: true };
      },
    };

    const service = new PODispatchService({
      emailAdapter: flakyAdapter,
      pdfGenerator: new SimplePdfGenerator(),
      maxRetries: 3,
      retryDelayMs: 1, // fast retries for testing
    });

    const result = await service.dispatch(makeDispatchInput());
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('fails after exhausting retries', async () => {
    const failAdapter: EmailAdapter = {
      send: async () => { throw new Error('Always fails'); },
    };

    const service = new PODispatchService({
      emailAdapter: failAdapter,
      pdfGenerator: new SimplePdfGenerator(),
      maxRetries: 2,
      retryDelayMs: 1,
    });

    const result = await service.dispatch(makeDispatchInput());
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toContain('Failed after 2 attempts');
  });

  it('reports PDF generation failure without retrying', async () => {
    const failPdf = {
      generatePurchaseOrderPdf: async () => { throw new Error('PDF engine down'); },
    };

    const service = new PODispatchService({
      emailAdapter: new ConsoleEmailAdapter(),
      pdfGenerator: failPdf,
    });

    const result = await service.dispatch(makeDispatchInput());
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.error).toContain('PDF generation failed');
  });

  it('includes cc recipients when provided', async () => {
    const adapter = new ConsoleEmailAdapter();
    const service = new PODispatchService({
      emailAdapter: adapter,
      pdfGenerator: new SimplePdfGenerator(),
    });

    await service.dispatch(makeDispatchInput({ cc: ['boss@arda.app'] }));
    expect(adapter.sentMessages[0].cc).toEqual(['boss@arda.app']);
  });
});
