/**
 * Integration tests for Sales Order CRUD APIs (Ticket #193)
 *
 * Tests:
 * - Sales order list/detail/create/update
 * - Line add/update/delete
 * - Status transitions (submit, cancel, convert-quote, generic transition)
 * - RBAC enforcement (salesperson/ecommerce_director can read; only salesperson/tenant_admin write)
 * - Salesperson scoping
 * - Filters: status, customerId, dateFrom, dateTo
 * - Pagination
 */
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  salesOrders: {},
  salesOrderLines: {},
  customers: {},
  customerContacts: {},
  customerAddresses: {},
  soStatusEnum: {
    enumValues: [
      'draft', 'confirmed', 'processing', 'partially_shipped',
      'shipped', 'delivered', 'invoiced', 'closed', 'cancelled',
    ] as const,
  },
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const { dbMock, resetDbMocks, defaults, lineMocks } = vi.hoisted(() => {
  const findFirstMock = vi.fn(async () => null as Record<string, unknown> | null);
  const findManyMock = vi.fn(async () => [] as Record<string, unknown>[]);

  // Sales order line findFirst
  const lineFindFirstMock = vi.fn(async () => null as Record<string, unknown> | null);

  // Customer findFirst
  const customerFindFirstMock = vi.fn(async () => null as Record<string, unknown> | null);

  const T = '00000000-0000-0000-0000-000000000001';
  const U1 = '00000000-0000-0000-0000-000000000011';
  const C = '00000000-0000-0000-0000-000000000021';
  const F = '00000000-0000-0000-0000-000000000031';
  const P = '00000000-0000-0000-0000-000000000041';
  const S = '00000000-0000-0000-0000-000000000051';
  const L = '00000000-0000-0000-0000-000000000061';

  const defaultOrder = {
    id: S,
    tenantId: T,
    soNumber: 'SO-20260215-0001',
    customerId: C,
    facilityId: F,
    status: 'draft',
    orderDate: new Date('2026-02-15T00:00:00Z'),
    requestedShipDate: null,
    promisedShipDate: null,
    actualShipDate: null,
    shippingAddressId: null,
    billingAddressId: null,
    subtotal: '100.00',
    taxAmount: '0',
    shippingAmount: '0',
    discountAmount: '0',
    totalAmount: '100.00',
    currency: 'USD',
    paymentTerms: 'NET30',
    shippingMethod: null,
    trackingNumber: null,
    notes: null,
    internalNotes: null,
    cancelledAt: null,
    cancelReason: null,
    createdByUserId: U1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultLine = {
    id: L,
    tenantId: T,
    salesOrderId: S,
    partId: P,
    lineNumber: 1,
    quantityOrdered: 10,
    quantityAllocated: 0,
    quantityShipped: 0,
    unitPrice: '10.0000',
    discountPercent: '0',
    lineTotal: '100.00',
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultCustomer = {
    id: C,
    tenantId: T,
    name: 'Acme Corp',
    code: 'ACME',
    status: 'active',
  };

  // Insert chain mocks for salesOrders
  const orderReturningMock = vi.fn(async () => [{ ...defaultOrder }]);
  const orderValueMock = vi.fn(() => ({ returning: orderReturningMock }));
  const orderInsertMock = vi.fn(() => ({ values: orderValueMock }));

  // Insert chain mocks for salesOrderLines
  const lineReturningMock = vi.fn(async () => [{ ...defaultLine }]);
  const lineValueMock = vi.fn(() => ({ returning: lineReturningMock }));
  const lineInsertMock = vi.fn(() => ({ values: lineValueMock }));

  // Update chain mocks
  const updateReturningMock = vi.fn(async () => [{ ...defaultOrder }]);
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
  const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: updateSetMock }));

  // Line update chain
  const lineUpdateReturningMock = vi.fn(async () => [{ ...defaultLine }]);
  const lineUpdateWhereMock = vi.fn(() => ({ returning: lineUpdateReturningMock }));
  const lineUpdateSetMock = vi.fn(() => ({ where: lineUpdateWhereMock }));

  // Delete chain
  const deleteWhereMock = vi.fn(async () => undefined);
  const deleteMock = vi.fn(() => ({ where: deleteWhereMock }));

  // List: select().from().where().limit().offset().orderBy()
  const listOrderByMock = vi.fn(async () => [{ ...defaultOrder }]);
  const listOffsetMock = vi.fn(() => ({ orderBy: listOrderByMock }));
  const listLimitMock = vi.fn(() => ({ offset: listOffsetMock }));
  const listWhereMock = vi.fn(() => ({ limit: listLimitMock }));
  const listFromMock = vi.fn(() => ({ where: listWhereMock }));

  // Count: select({count}).from().where()
  const countResult = [{ count: 1 }];
  const countWhereMock = vi.fn(async () => countResult);
  const countFromMock = vi.fn(() => ({ where: countWhereMock }));

  // Line number query: select().from().where().orderBy().limit()
  const lineNumLimitMock = vi.fn(async () => [] as Array<{ lineNumber: number }>);
  const lineNumOrderByMock = vi.fn(() => ({ limit: lineNumLimitMock }));
  const lineNumWhereMock = vi.fn(() => ({ orderBy: lineNumOrderByMock }));
  const lineNumFromMock = vi.fn(() => ({ where: lineNumWhereMock }));

  // All lines query (for totals recalc)
  const allLinesWhereMock = vi.fn(async () => [{ lineTotal: '100.00' }]);
  const allLinesFromMock = vi.fn(() => ({ where: allLinesWhereMock }));

  // Combined select chain — works for both lineNumber query and totals recalc
  // lineNumber chain: select().from().where().orderBy().limit()
  // totals chain: select().from().where() -> resolves directly
  // We combine them by making every step callable both ways
  const combinedFromMock = vi.fn(() => ({
    where: vi.fn(() => ({
      // For line number queries (orderBy().limit())
      orderBy: lineNumOrderByMock,
      // For totals queries, .then() resolves directly (we return array)
      then: (resolve: (v: unknown) => void) => resolve([{ lineTotal: '100.00' }]),
    })),
  }));

  const tx = {
    insert: vi.fn((table: unknown) => {
      if (table === schemaMock.salesOrderLines) return { values: lineValueMock };
      return { values: orderValueMock };
    }),
    update: vi.fn((table: unknown) => {
      if (table === schemaMock.salesOrderLines) return { set: lineUpdateSetMock };
      return { set: updateSetMock };
    }),
    delete: deleteMock,
    select: vi.fn(() => ({ from: combinedFromMock })),
    execute: vi.fn(async () => undefined),
  };

  const dbMock = {
    query: {
      salesOrders: { findFirst: findFirstMock, findMany: findManyMock },
      salesOrderLines: { findFirst: lineFindFirstMock },
      customers: { findFirst: customerFindFirstMock },
    },
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    insert: orderInsertMock,
    update: updateMock,
    delete: deleteMock,
    select: vi.fn((args: unknown) => {
      if (args && typeof args === 'object' && 'count' in args) {
        return { from: countFromMock };
      }
      return { from: listFromMock };
    }),
    execute: vi.fn(async () => undefined),
  };

  const resetDbMocks = () => {
    findFirstMock.mockReset();
    findManyMock.mockReset();
    lineFindFirstMock.mockReset();
    customerFindFirstMock.mockReset();
    orderInsertMock.mockClear();
    orderValueMock.mockClear();
    orderReturningMock.mockClear();
    lineInsertMock.mockClear();
    lineValueMock.mockClear();
    lineReturningMock.mockClear();
    updateMock.mockClear();
    updateSetMock.mockClear();
    updateWhereMock.mockClear();
    updateReturningMock.mockClear();
    lineUpdateSetMock.mockClear();
    lineUpdateWhereMock.mockClear();
    lineUpdateReturningMock.mockClear();
    deleteMock.mockClear();
    deleteWhereMock.mockClear();
    dbMock.select.mockClear();
    listFromMock.mockClear();
    listWhereMock.mockClear();
    listLimitMock.mockClear();
    listOffsetMock.mockClear();
    listOrderByMock.mockClear();
    countFromMock.mockClear();
    countWhereMock.mockClear();
    lineNumOrderByMock.mockClear();
    lineNumLimitMock.mockClear();
    combinedFromMock.mockClear();
    dbMock.transaction.mockClear();
    dbMock.execute.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
    tx.delete.mockClear();
    tx.select.mockClear();
    tx.execute.mockClear();
  };

  return {
    dbMock,
    resetDbMocks,
    defaults: { defaultOrder, defaultLine, defaultCustomer },
    lineMocks: {
      lineFindFirstMock,
      customerFindFirstMock,
      lineReturningMock,
      lineUpdateReturningMock,
      updateReturningMock,
    },
  };
});

// ─── Hoisted audit mock ─────────────────────────────────────────────
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.auditEntries.push(entry);
    return { id: 'audit-' + testState.auditEntries.length, hashChain: 'mock', sequenceNumber: testState.auditEntries.length };
  })
);

// ─── Hoisted order number mock ──────────────────────────────────────
const mockGetNextSONumber = vi.hoisted(() =>
  vi.fn(async () => 'SO-20260215-0001')
);

// ─── Module mocks ───────────────────────────────────────────────────
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
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

vi.mock('@arda/shared-types', () => ({
  SO_VALID_TRANSITIONS: {
    draft: ['confirmed', 'cancelled'],
    confirmed: ['processing', 'cancelled'],
    processing: ['partially_shipped', 'shipped', 'cancelled'],
    partially_shipped: ['shipped', 'cancelled'],
    shipped: ['delivered'],
    delivered: ['invoiced', 'closed'],
    invoiced: ['closed'],
    closed: [],
    cancelled: [],
  },
}));

vi.mock('../services/order-number.service.js', () => ({
  getNextSONumber: mockGetNextSONumber,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────
import { salesOrdersRouter } from './sales-orders.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────

interface UserPayload {
  tenantId: string;
  sub: string;
  role: string;
}

function createApp(user: UserPayload) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  app.use('/sales-orders', salesOrdersRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: object
) {
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

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const USER_1 = '00000000-0000-0000-0000-000000000011';
const USER_2 = '00000000-0000-0000-0000-000000000012';
const USER_3 = '00000000-0000-0000-0000-000000000013';
const USER_4 = '00000000-0000-0000-0000-000000000014';
const CUST_ID = '00000000-0000-0000-0000-000000000021';
const FAC_ID = '00000000-0000-0000-0000-000000000031';
const PART_ID = '00000000-0000-0000-0000-000000000041';
const PART_ID2 = '00000000-0000-0000-0000-000000000042';
const SO_ID = '00000000-0000-0000-0000-000000000051';
const LINE_ID = '00000000-0000-0000-0000-000000000061';

const salesperson: UserPayload = { tenantId: TENANT_ID, sub: USER_1, role: 'salesperson' };
const ecomDirector: UserPayload = { tenantId: TENANT_ID, sub: USER_2, role: 'ecommerce_director' };
const tenantAdmin: UserPayload = { tenantId: TENANT_ID, sub: USER_3, role: 'tenant_admin' };
const receivingMgr: UserPayload = { tenantId: TENANT_ID, sub: USER_4, role: 'receiving_manager' };

// ═════════════════════════════════════════════════════════════════════

describe('Sales Order CRUD API (Ticket #193)', () => {
  beforeEach(() => {
    resetDbMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
    mockGetNextSONumber.mockClear();
  });

  // ─── RBAC: Read access ─────────────────────────────────────────────

  describe('RBAC: Read access', () => {
    it('salesperson can list sales orders', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'GET', '/sales-orders');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('pagination');
    });

    it('ecommerce_director can list sales orders', async () => {
      const app = createApp(ecomDirector);
      const res = await request(app, 'GET', '/sales-orders');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
    });

    it('tenant_admin can list sales orders', async () => {
      const app = createApp(tenantAdmin);
      const res = await request(app, 'GET', '/sales-orders');
      expect(res.status).toBe(200);
    });

    it('receiving_manager cannot list sales orders (403)', async () => {
      const app = createApp(receivingMgr);
      const res = await request(app, 'GET', '/sales-orders');
      expect(res.status).toBe(403);
    });
  });

  // ─── RBAC: Write access ────────────────────────────────────────────

  describe('RBAC: Write access', () => {
    it('ecommerce_director cannot create sales orders (403)', async () => {
      const app = createApp(ecomDirector);
      const res = await request(app, 'POST', '/sales-orders', {
        customerId: CUST_ID,
        facilityId: FAC_ID,
        lines: [{ partId: PART_ID, quantityOrdered: 5, unitPrice: 20 }],
      });
      expect(res.status).toBe(403);
    });

    it('salesperson can create sales orders', async () => {
      lineMocks.customerFindFirstMock.mockResolvedValueOnce({ ...defaults.defaultCustomer });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/sales-orders', {
        customerId: CUST_ID,
        facilityId: FAC_ID,
        lines: [{ partId: PART_ID, quantityOrdered: 10, unitPrice: 10 }],
      });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('soNumber');
    });
  });

  // ─── Create ────────────────────────────────────────────────────────

  describe('POST /sales-orders', () => {
    it('creates an order with lines and writes audit', async () => {
      lineMocks.customerFindFirstMock.mockResolvedValueOnce({ ...defaults.defaultCustomer });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/sales-orders', {
        customerId: CUST_ID,
        facilityId: FAC_ID,
        paymentTerms: 'NET30',
        lines: [{ partId: PART_ID, quantityOrdered: 10, unitPrice: 10, discountPercent: 5 }],
      });
      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
      const audit = testState.auditEntries[0];
      expect(audit.action).toBe('sales_order.created');
      expect(audit.entityType).toBe('sales_order');
    });

    it('returns 404 if customer not found', async () => {
      lineMocks.customerFindFirstMock.mockResolvedValueOnce(null);
      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/sales-orders', {
        customerId: CUST_ID,
        facilityId: FAC_ID,
        lines: [{ partId: PART_ID, quantityOrdered: 5, unitPrice: 10 }],
      });
      expect(res.status).toBe(404);
    });

    it('validates required fields', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/sales-orders', {
        customerId: CUST_ID,
        // missing facilityId and lines
      });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('details');
    });

    it('requires at least one line', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/sales-orders', {
        customerId: CUST_ID,
        facilityId: FAC_ID,
        lines: [],
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Detail ────────────────────────────────────────────────────────

  describe('GET /sales-orders/:id', () => {
    it('returns order with customer and lines', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({
        ...defaults.defaultOrder,
        customer: defaults.defaultCustomer,
        lines: [defaults.defaultLine],
        shippingAddress: null,
        billingAddress: null,
      });

      const app = createApp(salesperson);
      const res = await request(app, 'GET', `/sales-orders/${SO_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('soNumber');
      expect(res.body).toHaveProperty('lines');
    });

    it('returns 404 for non-existent order', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce(null);
      const app = createApp(salesperson);
      const res = await request(app, 'GET', `/sales-orders/${SO_ID}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Update ────────────────────────────────────────────────────────

  describe('PATCH /sales-orders/:id', () => {
    it('updates a draft order', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      const app = createApp(salesperson);
      const res = await request(app, 'PATCH', `/sales-orders/${SO_ID}`, {
        paymentTerms: 'NET60',
      });
      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
      expect(testState.auditEntries[0].action).toBe('sales_order.updated');
    });

    it('rejects update on processing order (409)', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'processing' });
      const app = createApp(salesperson);
      const res = await request(app, 'PATCH', `/sales-orders/${SO_ID}`, {
        paymentTerms: 'NET90',
      });
      expect(res.status).toBe(409);
    });
  });

  // ─── Status Transitions ────────────────────────────────────────────

  describe('Status transitions', () => {
    it('POST /submit transitions draft → confirmed', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', `/sales-orders/${SO_ID}/submit`);
      expect(res.status).toBe(200);
      expect(testState.auditEntries[0].action).toBe('sales_order.status_changed');
      expect((testState.auditEntries[0].newState as any).status).toBe('confirmed');
    });

    it('POST /cancel transitions draft → cancelled with reason', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', `/sales-orders/${SO_ID}/cancel`, { cancelReason: 'Customer changed mind' });
      expect(res.status).toBe(200);
      const audit = testState.auditEntries[0];
      expect((audit.newState as any).status).toBe('cancelled');
      expect((audit.metadata as any).cancelReason).toBe('Customer changed mind');
    });

    it('POST /convert-quote transitions draft → confirmed', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', `/sales-orders/${SO_ID}/convert-quote`);
      expect(res.status).toBe(200);
      expect(testState.auditEntries[0].action).toBe('sales_order.status_changed');
    });

    it('POST /convert-quote rejects non-draft order', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'confirmed' });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', `/sales-orders/${SO_ID}/convert-quote`);
      expect(res.status).toBe(409);
    });

    it('POST /transition rejects invalid transition', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'closed' });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', `/sales-orders/${SO_ID}/transition`, { status: 'draft' });
      expect(res.status).toBe(409);
    });

    it('POST /transition allows valid generic transition', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'confirmed' });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', `/sales-orders/${SO_ID}/transition`, { status: 'processing' });
      expect(res.status).toBe(200);
      expect((testState.auditEntries[0].newState as any).status).toBe('processing');
    });
  });

  // ─── Line Management ───────────────────────────────────────────────

  describe('Line management', () => {
    it('POST /sales-orders/:id/lines adds a line', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', `/sales-orders/${SO_ID}/lines`, {
        partId: PART_ID2,
        quantityOrdered: 5,
        unitPrice: 25,
      });
      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
      expect(testState.auditEntries[0].action).toBe('sales_order_line.added');
    });

    it('POST /lines rejects on processing order (409)', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'processing' });
      const app = createApp(salesperson);
      const res = await request(app, 'POST', `/sales-orders/${SO_ID}/lines`, {
        partId: PART_ID2,
        quantityOrdered: 5,
        unitPrice: 25,
      });
      expect(res.status).toBe(409);
    });

    it('PATCH /sales-orders/:id/lines/:lineId updates a line', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      lineMocks.lineFindFirstMock.mockResolvedValueOnce({ ...defaults.defaultLine });
      const app = createApp(salesperson);
      const res = await request(app, 'PATCH', `/sales-orders/${SO_ID}/lines/${LINE_ID}`, {
        quantityOrdered: 20,
      });
      expect(res.status).toBe(200);
      expect(testState.auditEntries[0].action).toBe('sales_order_line.updated');
    });

    it('PATCH /lines returns 404 for non-existent line', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      lineMocks.lineFindFirstMock.mockResolvedValueOnce(null);
      const app = createApp(salesperson);
      const res = await request(app, 'PATCH', `/sales-orders/${SO_ID}/lines/${LINE_ID}`, {
        quantityOrdered: 20,
      });
      expect(res.status).toBe(404);
    });

    it('DELETE /sales-orders/:id/lines/:lineId deletes a line', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      lineMocks.lineFindFirstMock.mockResolvedValueOnce({ ...defaults.defaultLine });
      const app = createApp(salesperson);
      const res = await request(app, 'DELETE', `/sales-orders/${SO_ID}/lines/${LINE_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('deleted', true);
      expect(testState.auditEntries[0].action).toBe('sales_order_line.deleted');
    });

    it('DELETE /lines returns 404 for non-existent line', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      lineMocks.lineFindFirstMock.mockResolvedValueOnce(null);
      const app = createApp(salesperson);
      const res = await request(app, 'DELETE', `/sales-orders/${SO_ID}/lines/${LINE_ID}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Filters & Pagination ─────────────────────────────────────────

  describe('Filters and pagination', () => {
    it('accepts status filter', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'GET', '/sales-orders?status=draft');
      expect(res.status).toBe(200);
    });

    it('accepts customerId filter', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'GET', `/sales-orders?customerId=${CUST_ID}`);
      expect(res.status).toBe(200);
    });

    it('accepts date range filters', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'GET', '/sales-orders?dateFrom=2026-01-01T00:00:00Z&dateTo=2026-12-31T00:00:00Z');
      expect(res.status).toBe(200);
    });

    it('paginates results', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'GET', '/sales-orders?page=2&pageSize=10');
      expect(res.status).toBe(200);
      const pagination = res.body.pagination as Record<string, unknown>;
      expect(pagination).toHaveProperty('page', 2);
      expect(pagination).toHaveProperty('pageSize', 10);
    });

    it('rejects invalid status filter', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'GET', '/sales-orders?status=bogus');
      expect(res.status).toBe(400);
    });
  });

  // ─── Transaction safety ────────────────────────────────────────────

  describe('Transaction safety', () => {
    it('create wraps insert + audit in a transaction', async () => {
      lineMocks.customerFindFirstMock.mockResolvedValueOnce({ ...defaults.defaultCustomer });
      const app = createApp(salesperson);
      await request(app, 'POST', '/sales-orders', {
        customerId: CUST_ID,
        facilityId: FAC_ID,
        lines: [{ partId: PART_ID, quantityOrdered: 10, unitPrice: 10 }],
      });
      expect(dbMock.transaction).toHaveBeenCalledOnce();
    });

    it('submit wraps status change + audit in a transaction', async () => {
      dbMock.query.salesOrders.findFirst.mockResolvedValueOnce({ ...defaults.defaultOrder, status: 'draft' });
      const app = createApp(salesperson);
      await request(app, 'POST', `/sales-orders/${SO_ID}/submit`);
      expect(dbMock.transaction).toHaveBeenCalledOnce();
    });
  });
});
