import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
}));

const sendMailMock = vi.hoisted(() => vi.fn(async () => ({ messageId: 'smtp-msg-1' })));
const createTransportMock = vi.hoisted(() => vi.fn(() => ({ sendMail: sendMailMock })));
const sendEmailAdapterMock = vi.hoisted(() =>
  vi.fn(async (_message?: unknown) => ({ messageId: 'smtp-msg-1', success: true }))
);

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  return {
    purchaseOrders: table('purchase_orders'),
    purchaseOrderLines: table('purchase_order_lines'),
    suppliers: table('suppliers'),
    parts: table('parts'),
    facilities: table('facilities'),
    auditLog: table('audit_log'),
  };
});

const dbMock = vi.hoisted(() => {
  function makeBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => builder;
    builder.orderBy = () => builder;
    builder.execute = async () => result;
    builder.then = (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result as unknown[]).then(resolve, reject);
    return builder;
  }

  return {
    select: vi.fn(() => makeBuilder(testState.selectResults.shift() ?? [])),
  };
});

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
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'test', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: {
    REDIS_URL: 'redis://localhost:6379',
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: 'noreply@arda.cards',
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({ publish: vi.fn(async () => undefined) })),
}));

vi.mock('../services/order-number.service.js', () => ({
  getNextPONumber: vi.fn(async () => 'PO-1'),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: createTransportMock,
  },
  createTransport: createTransportMock,
}));

vi.mock('../services/po-dispatch.service.js', () => ({
  SmtpEmailAdapter: class {
    async send(message: unknown) {
      return sendEmailAdapterMock(message);
    }
  },
  SimplePdfGenerator: class {
    async generatePurchaseOrderPdf() {
      return Buffer.from('pdf');
    }
  },
}));

// @ts-expect-error Vitest resolves TS source for route modules in tests.
import { purchaseOrdersRouter } from './purchase-orders.routes.ts';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { tenantId: 'tenant-1', sub: 'user-1' };
    next();
  });
  app.use('/purchase-orders', purchaseOrdersRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function postJson(path: string, body: Record<string, unknown>) {
  const app = createTestApp();
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to start server');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('purchase-orders send-email-draft endpoint', () => {
  beforeEach(() => {
    testState.selectResults = [];
    dbMock.select.mockClear();
    sendMailMock.mockClear();
    createTransportMock.mockClear();
    sendEmailAdapterMock.mockClear();
  });

  it('sends draft email with attachment', async () => {
    testState.selectResults = [
      [
        {
          id: 'po-1',
          tenantId: 'tenant-1',
          poNumber: 'PO-1',
          supplierId: 'sup-1',
          facilityId: 'fac-1',
          orderDate: new Date('2026-02-11T00:00:00.000Z'),
          expectedDeliveryDate: new Date('2026-02-12T00:00:00.000Z'),
          subtotal: '0',
          taxAmount: '0',
          shippingAmount: '0',
          totalAmount: '0',
          currency: 'USD',
          notes: null,
          paymentTerms: null,
        },
      ],
      [
        {
          id: 'sup-1',
          tenantId: 'tenant-1',
          name: 'Acme',
          contactName: 'Buyer',
          contactEmail: 'buyer@acme.com',
          addressLine1: '123 Main',
          addressLine2: null,
          city: 'Austin',
          state: 'TX',
          postalCode: '73301',
        },
      ],
      [
        {
          id: 'line-1',
          purchaseOrderId: 'po-1',
          partId: 'part-1',
          lineNumber: 1,
          quantityOrdered: 2,
          unitCost: '0',
          lineTotal: '0',
          description: null,
        },
      ],
      [
        {
          id: 'part-1',
          partNumber: 'P-1',
          name: 'Widget',
          uom: 'each',
        },
      ],
      [
        {
          name: 'Main Facility',
          code: 'FAC1',
        },
      ],
    ];

    const response = await postJson('/purchase-orders/po-1/send-email-draft', {
      includeAttachment: true,
      bodyText: 'Custom body',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          messageId: 'smtp-msg-1',
          to: 'buyer@acme.com',
          attachmentIncluded: true,
        }),
      }),
    );

    expect(sendEmailAdapterMock).toHaveBeenCalledTimes(1);
    const message = (sendEmailAdapterMock.mock.calls[0] as unknown[])[0] as {
      attachments?: unknown[];
    };
    expect(message.attachments).toHaveLength(1);
  });
});
