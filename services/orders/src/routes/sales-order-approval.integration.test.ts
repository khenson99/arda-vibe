/**
 * Integration tests for Sales Order Approval Routes (Ticket #194)
 *
 * Tests:
 * - POST /:id/approve — RBAC + happy path
 * - POST /:id/cancel-with-release — RBAC + happy path
 */
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  salesOrders: {},
  salesOrderLines: {},
  customers: {},
  customerContacts: {},
  customerAddresses: {},
  demandSignals: {},
  inventoryLedger: {
    tenantId: 'tenantId',
    facilityId: 'facilityId',
    partId: 'partId',
    qtyReserved: 'qtyReserved',
  },
  kanbanLoops: {},
  kanbanCards: {},
}));

const IDS = vi.hoisted(() => ({
  T: '00000000-0000-0000-0000-000000000001',
  U: '00000000-0000-0000-0000-000000000011',
  C: '00000000-0000-0000-0000-000000000021',
  F: '00000000-0000-0000-0000-000000000031',
  P: '00000000-0000-0000-0000-000000000041',
  SO: '00000000-0000-0000-0000-000000000051',
  L: '00000000-0000-0000-0000-000000000061',
}));

const { dbMock } = vi.hoisted(() => {
  const defaultOrder = {
    id: IDS.SO,
    tenantId: IDS.T,
    soNumber: 'SO-20260215-0001',
    customerId: IDS.C,
    facilityId: IDS.F,
    status: 'confirmed',
    subtotal: '100.00',
    totalAmount: '100.00',
    cancelledAt: null,
    cancelReason: null,
    createdByUserId: IDS.U,
  };

  const findFirstMock = vi.fn(async () => ({ ...defaultOrder }));

  const dbMock = {
    query: {
      salesOrders: { findFirst: findFirstMock },
      salesOrderLines: { findFirst: vi.fn() },
      customers: { findFirst: vi.fn() },
    },
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  };

  return { dbMock, findFirstMock, defaultOrder };
});

// ─── Hoisted mocks ─────────────────────────────────────────────────
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.auditEntries.push(entry);
    return { id: 'audit-1', hashChain: 'mock', sequenceNumber: 1 };
  })
);

const mockApproveSalesOrder = vi.hoisted(() =>
  vi.fn(async () => ({
    orderId: IDS.SO,
    orderNumber: 'SO-20260215-0001',
    previousStatus: 'confirmed',
    newStatus: 'processing',
    reservations: [{
      lineId: IDS.L,
      partId: IDS.P,
      quantityOrdered: 10,
      quantityReserved: 10,
      shortfall: 0,
    }],
    demandSignalsCreated: 1,
    kanbanCardsTriggered: 0,
  }))
);

const mockCancelSalesOrder = vi.hoisted(() =>
  vi.fn(async () => ({
    orderId: IDS.SO,
    orderNumber: 'SO-20260215-0001',
    previousStatus: 'processing',
    inventoryReleased: 10,
    demandSignalsCancelled: 1,
  }))
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
  inArray: vi.fn(() => ({})),
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

vi.mock('@arda/events', () => ({
  getEventBus: () => ({ publish: vi.fn(async () => undefined), subscribe: vi.fn() }),
}));

vi.mock('../services/order-number.service.js', () => ({
  getNextSONumber: vi.fn(async () => 'SO-20260215-0001'),
}));

vi.mock('../services/sales-order-approval.service.js', () => ({
  approveSalesOrder: mockApproveSalesOrder,
  cancelSalesOrder: mockCancelSalesOrder,
}));

// ─── Imports ────────────────────────────────────────────────────────
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
    (req as unknown as Record<string, unknown>).user = user;
    next();
  });
  app.use('/sales-orders', salesOrdersRouter);
  app.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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

// ─── Tests ──────────────────────────────────────────────────────────

describe('Sales Order Approval Routes', () => {
  beforeEach(() => {
    testState.auditEntries.length = 0;
    mockApproveSalesOrder.mockClear();
    mockCancelSalesOrder.mockClear();
  });

  describe('POST /sales-orders/:id/approve', () => {
    it('should approve a confirmed order (ecommerce_director)', async () => {
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'ecommerce_director' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/approve`);

      expect(res.status).toBe(200);
      expect(res.body.newStatus).toBe('processing');
      expect(res.body.reservations).toHaveLength(1);
      expect(mockApproveSalesOrder).toHaveBeenCalledTimes(1);
    });

    it('should approve a confirmed order (tenant_admin)', async () => {
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'tenant_admin' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/approve`);

      expect(res.status).toBe(200);
      expect(mockApproveSalesOrder).toHaveBeenCalledTimes(1);
    });

    it('should reject non-authorized roles (salesperson)', async () => {
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'salesperson' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/approve`);

      expect(res.status).toBe(403);
      expect(mockApproveSalesOrder).not.toHaveBeenCalled();
    });

    it('should reject non-authorized roles (inventory_manager)', async () => {
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'inventory_manager' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/approve`);

      expect(res.status).toBe(403);
      expect(mockApproveSalesOrder).not.toHaveBeenCalled();
    });

    it('should return 404 for order not found', async () => {
      (dbMock.query.salesOrders.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'ecommerce_director' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/approve`);

      expect(res.status).toBe(404);
    });

    it('should forward service errors with correct status code', async () => {
      mockApproveSalesOrder.mockRejectedValueOnce(
        Object.assign(new Error('Cannot approve order in "draft" status'), { statusCode: 409 }),
      );
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'ecommerce_director' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/approve`);

      expect(res.status).toBe(409);
    });
  });

  describe('POST /sales-orders/:id/cancel-with-release', () => {
    it('should cancel and release inventory (salesperson)', async () => {
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'salesperson' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/cancel-with-release`, {
        cancelReason: 'Customer cancelled',
      });

      expect(res.status).toBe(200);
      expect(res.body.inventoryReleased).toBe(10);
      expect(res.body.demandSignalsCancelled).toBe(1);
      expect(mockCancelSalesOrder).toHaveBeenCalledTimes(1);
    });

    it('should cancel and release inventory (tenant_admin)', async () => {
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'tenant_admin' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/cancel-with-release`);

      expect(res.status).toBe(200);
      expect(mockCancelSalesOrder).toHaveBeenCalledTimes(1);
    });

    it('should reject non-authorized roles (executive)', async () => {
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'executive' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/cancel-with-release`);

      expect(res.status).toBe(403);
      expect(mockCancelSalesOrder).not.toHaveBeenCalled();
    });

    it('should forward service errors with correct status code', async () => {
      mockCancelSalesOrder.mockRejectedValueOnce(
        Object.assign(new Error('Cannot cancel order in "cancelled" status'), { statusCode: 409 }),
      );
      const app = createApp({ tenantId: IDS.T, sub: IDS.U, role: 'salesperson' });

      const res = await request(app, 'POST', `/sales-orders/${IDS.SO}/cancel-with-release`, {
        cancelReason: 'test',
      });

      expect(res.status).toBe(409);
    });
  });
});
