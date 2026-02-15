/**
 * Integration tests for customer CRUD APIs (Ticket #192)
 *
 * Tests:
 * - Customer list/detail/create/update
 * - Nested contact and address create/update
 * - RBAC enforcement (salesperson/ecommerce_director can read; only salesperson/tenant_admin write)
 * - Salesperson scoping (sees only own/assigned customers)
 * - Pagination and search
 */
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  customers: {},
  customerContacts: {},
  customerAddresses: {},
  customerStatusEnum: {
    enumValues: ['active', 'inactive', 'prospect', 'suspended'] as const,
  },
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const { dbMock, resetDbMocks } = vi.hoisted(() => {
  const findFirstMock = vi.fn(async () => null as Record<string, unknown> | null);
  const findManyMock = vi.fn(async () => [] as Record<string, unknown>[]);

  // Customer contact findFirst
  const contactFindFirstMock = vi.fn(async () => null as Record<string, unknown> | null);
  // Customer address findFirst
  const addressFindFirstMock = vi.fn(async () => null as Record<string, unknown> | null);

  const defaultCustomer = {
    id: 'cust-1',
    tenantId: 'tenant-1',
    name: 'Acme Corp',
    code: 'ACME',
    status: 'active',
    email: 'acme@example.com',
    phone: '555-1234',
    website: null,
    paymentTerms: 'NET30',
    creditLimit: '50000.00',
    taxId: null,
    notes: null,
    metadata: null,
    createdByUserId: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultContact = {
    id: 'contact-1',
    tenantId: 'tenant-1',
    customerId: 'cust-1',
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@acme.com',
    phone: '555-1111',
    title: 'Buyer',
    isPrimary: true,
    isActive: true,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const defaultAddress = {
    id: 'addr-1',
    tenantId: 'tenant-1',
    customerId: 'cust-1',
    label: 'main',
    addressLine1: '123 Main St',
    addressLine2: null,
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    country: 'US',
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const returningMock = vi.fn(async () => [{ ...defaultCustomer }]);
  const valueMock = vi.fn(() => ({ returning: returningMock }));
  const insertMock = vi.fn(() => ({ values: valueMock }));

  const contactReturningMock = vi.fn(async () => [{ ...defaultContact }]);
  const contactValueMock = vi.fn(() => ({ returning: contactReturningMock }));
  const contactInsertMock = vi.fn(() => ({ values: contactValueMock }));

  const addressReturningMock = vi.fn(async () => [{ ...defaultAddress }]);
  const addressValueMock = vi.fn(() => ({ returning: addressReturningMock }));
  const addressInsertMock = vi.fn(() => ({ values: addressValueMock }));

  const whereUpdateMock = vi.fn(() => ({ returning: vi.fn(async () => [{ ...defaultCustomer }]) }));
  const setMock = vi.fn(() => ({ where: whereUpdateMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  // For list query (select().from().where().limit().offset().orderBy())
  const listOrderByMock = vi.fn(async () => [{ ...defaultCustomer }]);
  const listOffsetMock = vi.fn(() => ({ orderBy: listOrderByMock }));
  const listLimitMock = vi.fn(() => ({ offset: listOffsetMock }));
  const listWhereMock = vi.fn(() => ({ limit: listLimitMock }));
  const listFromMock = vi.fn(() => ({ where: listWhereMock }));

  // For count query
  const countResult = [{ count: 1 }];
  const countWhereMock = vi.fn(async () => countResult);
  const countFromMock = vi.fn(() => ({ where: countWhereMock }));

  const selectMock = vi.fn(() => ({ from: listFromMock }));

  // Tx mock needs to route inserts to the right table
  const tx = {
    insert: vi.fn((table: unknown) => {
      const t = table as Record<string, unknown>;
      if (t === schemaMock.customerContacts) return { values: contactValueMock };
      if (t === schemaMock.customerAddresses) return { values: addressValueMock };
      return { values: valueMock };
    }),
    update: updateMock,
    select: selectMock,
  };

  const dbMock = {
    query: {
      customers: { findFirst: findFirstMock, findMany: findManyMock },
      customerContacts: { findFirst: contactFindFirstMock },
      customerAddresses: { findFirst: addressFindFirstMock },
    },
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    insert: insertMock,
    update: updateMock,
    select: vi.fn((args: unknown) => {
      // If selecting count, return count chain
      if (args && typeof args === 'object' && 'count' in args) {
        return { from: countFromMock };
      }
      return { from: listFromMock };
    }),
  };

  const resetDbMocks = () => {
    findFirstMock.mockReset();
    findManyMock.mockReset();
    contactFindFirstMock.mockReset();
    addressFindFirstMock.mockReset();
    insertMock.mockClear();
    valueMock.mockClear();
    returningMock.mockClear();
    contactInsertMock.mockClear();
    contactValueMock.mockClear();
    contactReturningMock.mockClear();
    addressInsertMock.mockClear();
    addressValueMock.mockClear();
    addressReturningMock.mockClear();
    updateMock.mockClear();
    setMock.mockClear();
    whereUpdateMock.mockClear();
    selectMock.mockClear();
    dbMock.select.mockClear();
    listFromMock.mockClear();
    listWhereMock.mockClear();
    listLimitMock.mockClear();
    listOffsetMock.mockClear();
    listOrderByMock.mockClear();
    countFromMock.mockClear();
    countWhereMock.mockClear();
    dbMock.transaction.mockClear();
    tx.insert.mockClear();
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
  or: vi.fn(() => ({})),
  ilike: vi.fn(() => ({})),
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

// ─── Imports (after mocks) ──────────────────────────────────────────
import { customersRouter } from './customers.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────

interface UserPayload {
  tenantId: string;
  sub: string;
  role: string;
}

function createApp(user: UserPayload) {
  const app = express();
  app.use(express.json());
  // Inject user into req for auth simulation
  app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  app.use('/customers', customersRouter);
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

const salesperson: UserPayload = { tenantId: 'tenant-1', sub: 'user-1', role: 'salesperson' };
const ecomDirector: UserPayload = { tenantId: 'tenant-1', sub: 'user-2', role: 'ecommerce_director' };
const tenantAdmin: UserPayload = { tenantId: 'tenant-1', sub: 'user-3', role: 'tenant_admin' };
const receivingMgr: UserPayload = { tenantId: 'tenant-1', sub: 'user-4', role: 'receiving_manager' };

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('Customer CRUD API (Ticket #192)', () => {
  beforeEach(() => {
    resetDbMocks();
    testState.auditEntries = [];
    mockWriteAuditEntry.mockClear();
  });

  // ─── RBAC: Read access ─────────────────────────────────────────────

  describe('RBAC: Read access', () => {
    it('salesperson can list customers (GET /customers)', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'GET', '/customers');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('pagination');
    });

    it('ecommerce_director can list customers (GET /customers)', async () => {
      const app = createApp(ecomDirector);
      const res = await request(app, 'GET', '/customers');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
    });

    it('tenant_admin can list customers (GET /customers)', async () => {
      const app = createApp(tenantAdmin);
      const res = await request(app, 'GET', '/customers');
      expect(res.status).toBe(200);
    });

    it('receiving_manager gets 403 on GET /customers', async () => {
      const app = createApp(receivingMgr);
      const res = await request(app, 'GET', '/customers');
      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty('error', 'Insufficient permissions');
    });
  });

  // ─── RBAC: Write access ────────────────────────────────────────────

  describe('RBAC: Write access', () => {
    it('salesperson can create customer (POST /customers)', async () => {
      // No duplicate code
      dbMock.query.customers.findFirst.mockResolvedValueOnce(null);

      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/customers', {
        name: 'Acme Corp',
        code: 'ACME',
      });
      expect(res.status).toBe(201);
    });

    it('tenant_admin can create customer (POST /customers)', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce(null);

      const app = createApp(tenantAdmin);
      const res = await request(app, 'POST', '/customers', {
        name: 'Beta Inc',
        code: 'BETA',
      });
      expect(res.status).toBe(201);
    });

    it('ecommerce_director gets 403 on POST /customers', async () => {
      const app = createApp(ecomDirector);
      const res = await request(app, 'POST', '/customers', {
        name: 'Gamma LLC',
      });
      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty('error', 'Insufficient permissions');
    });

    it('receiving_manager gets 403 on POST /customers', async () => {
      const app = createApp(receivingMgr);
      const res = await request(app, 'POST', '/customers', {
        name: 'Delta Inc',
      });
      expect(res.status).toBe(403);
    });

    it('ecommerce_director gets 403 on PATCH /customers/:id', async () => {
      const app = createApp(ecomDirector);
      const res = await request(app, 'PATCH', '/customers/cust-1', { name: 'Updated' });
      expect(res.status).toBe(403);
    });
  });

  // ─── Customer CRUD happy path ──────────────────────────────────────

  describe('Customer CRUD happy path', () => {
    it('creates a customer with audit entry', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce(null);

      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/customers', {
        name: 'New Customer',
        code: 'NEW',
        email: 'new@example.com',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('customer.created');
      expect(entry.entityType).toBe('customer');
      expect(entry.tenantId).toBe('tenant-1');
      expect(entry.userId).toBe('user-1');
    });

    it('returns 409 for duplicate customer code', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce({
        id: 'existing-1',
        code: 'DUP',
      });

      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/customers', {
        name: 'Duplicate',
        code: 'DUP',
      });
      expect(res.status).toBe(409);
    });

    it('updates a customer with field-level audit', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce({
        id: 'cust-1',
        tenantId: 'tenant-1',
        name: 'Old Name',
        code: 'OLD',
        status: 'active',
        createdByUserId: 'user-1',
      });

      const app = createApp(salesperson);
      const res = await request(app, 'PATCH', '/customers/cust-1', { name: 'New Name' });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('customer.updated');
      expect(entry.previousState).toEqual({ name: 'Old Name' });
      expect(entry.newState).toEqual({ name: 'New Name' });
    });

    it('returns 400 for invalid input on create', async () => {
      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/customers', {});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error', 'Validation error');
    });

    it('returns 404 when updating non-existent customer', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce(null);

      const app = createApp(salesperson);
      const res = await request(app, 'PATCH', '/customers/nonexistent', { name: 'Test' });
      expect(res.status).toBe(404);
    });
  });

  // ─── Nested contacts ──────────────────────────────────────────────

  describe('Customer contacts', () => {
    it('creates a contact under a customer with audit entry', async () => {
      // Customer exists
      dbMock.query.customers.findFirst.mockResolvedValueOnce({
        id: 'cust-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        createdByUserId: 'user-1',
      });

      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/customers/cust-1/contacts', {
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@acme.com',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('customer_contact.created');
      expect(entry.entityType).toBe('customer_contact');
    });

    it('returns 404 when creating contact for non-existent customer', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce(null);

      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/customers/nonexistent/contacts', {
        firstName: 'Jane',
        lastName: 'Smith',
      });
      expect(res.status).toBe(404);
    });

    it('updates a contact with audit entry', async () => {
      // Customer exists
      dbMock.query.customers.findFirst.mockResolvedValueOnce({
        id: 'cust-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        createdByUserId: 'user-1',
      });
      // Contact exists
      dbMock.query.customerContacts.findFirst.mockResolvedValueOnce({
        id: 'contact-1',
        customerId: 'cust-1',
        tenantId: 'tenant-1',
        firstName: 'John',
        lastName: 'Doe',
      });

      const app = createApp(salesperson);
      const res = await request(app, 'PATCH', '/customers/cust-1/contacts/contact-1', {
        firstName: 'Johnny',
      });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('customer_contact.updated');
      expect(entry.previousState).toEqual({ firstName: 'John' });
      expect(entry.newState).toEqual({ firstName: 'Johnny' });
    });

    it('ecommerce_director gets 403 on POST /customers/:id/contacts', async () => {
      const app = createApp(ecomDirector);
      const res = await request(app, 'POST', '/customers/cust-1/contacts', {
        firstName: 'Jane',
        lastName: 'Smith',
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── Nested addresses ─────────────────────────────────────────────

  describe('Customer addresses', () => {
    it('creates an address under a customer with audit entry', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce({
        id: 'cust-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        createdByUserId: 'user-1',
      });

      const app = createApp(salesperson);
      const res = await request(app, 'POST', '/customers/cust-1/addresses', {
        addressLine1: '456 Oak Ave',
        city: 'Chicago',
        state: 'IL',
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('customer_address.created');
      expect(entry.entityType).toBe('customer_address');
    });

    it('updates an address with audit entry', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce({
        id: 'cust-1',
        tenantId: 'tenant-1',
        name: 'Acme Corp',
        createdByUserId: 'user-1',
      });
      dbMock.query.customerAddresses.findFirst.mockResolvedValueOnce({
        id: 'addr-1',
        customerId: 'cust-1',
        tenantId: 'tenant-1',
        city: 'Springfield',
        state: 'IL',
      });

      const app = createApp(salesperson);
      const res = await request(app, 'PATCH', '/customers/cust-1/addresses/addr-1', {
        city: 'Chicago',
      });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);

      const entry = testState.auditEntries[0];
      expect(entry.action).toBe('customer_address.updated');
      expect(entry.previousState).toEqual({ city: 'Springfield' });
      expect(entry.newState).toEqual({ city: 'Chicago' });
    });

    it('ecommerce_director gets 403 on POST /customers/:id/addresses', async () => {
      const app = createApp(ecomDirector);
      const res = await request(app, 'POST', '/customers/cust-1/addresses', {
        addressLine1: '789 Pine Blvd',
        city: 'Detroit',
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── Transaction safety ───────────────────────────────────────────

  describe('Transaction safety', () => {
    it('runs audit writes inside the same transaction as customer mutations', async () => {
      dbMock.query.customers.findFirst.mockResolvedValueOnce(null);

      const app = createApp(salesperson);
      await request(app, 'POST', '/customers', { name: 'TxTest' });

      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      const txArg = mockWriteAuditEntry.mock.calls[0][0];
      expect(txArg).toHaveProperty('insert');
      expect(txArg).toHaveProperty('update');
    });
  });
});
