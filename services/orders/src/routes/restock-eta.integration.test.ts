/**
 * Integration tests for restock ETA routes (Ticket #195)
 *
 * Tests:
 * - GET /restock-eta/:partId — single part ETA with facilityId query param
 * - POST /restock-eta/batch — batch ETA for multiple items
 * - GET /sales-orders/:id/eta — per-line ETA for a sales order
 * - RBAC enforcement (authorized roles vs unauthorized)
 * - Input validation (missing/invalid facilityId, invalid UUID)
 */
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ─────────────────────────────────────────────────
const etaServiceMock = vi.hoisted(() => ({
  calculateRestockEta: vi.fn(async () => ({
    partId: '00000000-0000-0000-0000-000000000003',
    facilityId: '00000000-0000-0000-0000-000000000002',
    etaDays: 7.5,
    etaDate: '2026-02-22T12:00:00.000Z',
    leadTimeSource: 'history_wma' as const,
    baseLeadTimeDays: 10,
    activeCardStage: 'ordered',
    qtyOnHand: 50,
    qtyReserved: 10,
    qtyInTransit: 5,
    netAvailable: 40,
  })),
  calculateBatchRestockEta: vi.fn(async () => [
    {
      partId: '00000000-0000-0000-0000-000000000003',
      facilityId: '00000000-0000-0000-0000-000000000002',
      etaDays: 7.5,
      etaDate: '2026-02-22T12:00:00.000Z',
      leadTimeSource: 'history_wma' as const,
      baseLeadTimeDays: 10,
      activeCardStage: null,
      qtyOnHand: 0,
      qtyReserved: 0,
      qtyInTransit: 0,
      netAvailable: 0,
    },
  ]),
  calculateSalesOrderLineEtas: vi.fn(async () => ({
    orderId: '00000000-0000-0000-0000-000000000010',
    facilityId: '00000000-0000-0000-0000-000000000002',
    lines: [
      {
        lineId: '00000000-0000-0000-0000-000000000020',
        partId: '00000000-0000-0000-0000-000000000003',
        lineNumber: 1,
        quantityOrdered: 100,
        quantityAllocated: 30,
        quantityShipped: 0,
        shortfall: 70,
        eta: {
          partId: '00000000-0000-0000-0000-000000000003',
          facilityId: '00000000-0000-0000-0000-000000000002',
          etaDays: 5,
          etaDate: '2026-02-20T12:00:00.000Z',
          leadTimeSource: 'loop_stated' as const,
          baseLeadTimeDays: 7,
          activeCardStage: 'in_transit',
          qtyOnHand: 10,
          qtyReserved: 0,
          qtyInTransit: 20,
          netAvailable: 10,
        },
      },
    ],
  })),
}));

vi.mock('../services/restock-eta.service.js', () => etaServiceMock);

vi.mock('@arda/db', () => ({
  db: {},
  schema: {},
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1' })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: {},
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@arda/auth-utils', () => ({
  requireRole: (..._roles: string[]) => {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const authReq = req as unknown as { user?: { role: string; tenantId: string; sub: string } };
      if (!authReq.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const allowedRoles = ['tenant_admin', ..._roles];
      if (!allowedRoles.includes(authReq.user.role)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      next();
    };
  },
  authMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../middleware/error-handler.js', async () => {
  class AppError extends Error {
    statusCode: number;
    details?: unknown;
    constructor(statusCode: number, message: string, details?: unknown) {
      super(message);
      this.statusCode = statusCode;
      this.details = details;
    }
  }
  return {
    AppError,
    errorHandler: (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const statusCode = 'statusCode' in err ? (err as AppError).statusCode : 500;
      res.status(statusCode).json({ error: err.message });
    },
  };
});

import request from 'supertest';
import { restockEtaRouter, salesOrderEtaRouter } from './restock-eta.routes.js';

// ─── Test App Setup ─────────────────────────────────────────────────
function createApp(userOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());

  // Inject mock auth user
  app.use((req, _res, next) => {
    (req as unknown as { user: Record<string, unknown> }).user = {
      sub: 'user-1',
      tenantId: '00000000-0000-0000-0000-000000000001',
      role: 'inventory_manager',
      ...userOverrides,
    };
    next();
  });

  app.use('/restock-eta', restockEtaRouter);
  app.use('/sales-orders', salesOrderEtaRouter);

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = 'statusCode' in err ? (err as { statusCode: number }).statusCode : 500;
    res.status(statusCode).json({ error: err.message });
  });

  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────
const PART_ID = '00000000-0000-0000-0000-000000000003';
const FACILITY_ID = '00000000-0000-0000-0000-000000000002';
const ORDER_ID = '00000000-0000-0000-0000-000000000010';

describe('GET /restock-eta/:partId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ETA for a valid partId + facilityId', async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/restock-eta/${PART_ID}?facilityId=${FACILITY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.partId).toBe(PART_ID);
    expect(res.body.etaDays).toBe(7.5);
    expect(res.body.leadTimeSource).toBe('history_wma');
    expect(res.body.activeCardStage).toBe('ordered');
    expect(res.body.netAvailable).toBe(40);
    expect(etaServiceMock.calculateRestockEta).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001', // tenantId
      FACILITY_ID,
      PART_ID,
    );
  });

  it('returns 400 when facilityId is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/restock-eta/${PART_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/facilityId/);
  });

  it('returns 400 for invalid UUID in partId', async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/restock-eta/not-a-uuid?facilityId=${FACILITY_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/partId/i);
  });

  it('returns 403 for unauthorized role', async () => {
    const app = createApp({ role: 'ecommerce_director' });
    const res = await request(app)
      .get(`/restock-eta/${PART_ID}?facilityId=${FACILITY_ID}`);

    expect(res.status).toBe(403);
  });

  it('allows tenant_admin access', async () => {
    const app = createApp({ role: 'tenant_admin' });
    const res = await request(app)
      .get(`/restock-eta/${PART_ID}?facilityId=${FACILITY_ID}`);

    expect(res.status).toBe(200);
  });

  it('allows salesperson access', async () => {
    const app = createApp({ role: 'salesperson' });
    const res = await request(app)
      .get(`/restock-eta/${PART_ID}?facilityId=${FACILITY_ID}`);

    expect(res.status).toBe(200);
  });
});

describe('POST /restock-eta/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns batch ETA results', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/restock-eta/batch')
      .send({
        items: [
          { partId: PART_ID, facilityId: FACILITY_ID },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].partId).toBe(PART_ID);
    expect(etaServiceMock.calculateBatchRestockEta).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      [{ partId: PART_ID, facilityId: FACILITY_ID }],
    );
  });

  it('returns 400 for empty items array', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/restock-eta/batch')
      .send({ items: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing items', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/restock-eta/batch')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 403 for unauthorized role', async () => {
    const app = createApp({ role: 'ecommerce_director' });
    const res = await request(app)
      .post('/restock-eta/batch')
      .send({ items: [{ partId: PART_ID, facilityId: FACILITY_ID }] });

    expect(res.status).toBe(403);
  });
});

describe('GET /sales-orders/:id/eta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns per-line ETAs for a sales order', async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/sales-orders/${ORDER_ID}/eta`);

    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe(ORDER_ID);
    expect(res.body.facilityId).toBe(FACILITY_ID);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].shortfall).toBe(70);
    expect(res.body.lines[0].eta.activeCardStage).toBe('in_transit');
    expect(etaServiceMock.calculateSalesOrderLineEtas).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      ORDER_ID,
    );
  });

  it('returns 404 when order not found', async () => {
    etaServiceMock.calculateSalesOrderLineEtas.mockRejectedValueOnce(
      new Error('Sales order not found'),
    );

    const app = createApp();
    const res = await request(app)
      .get(`/sales-orders/${ORDER_ID}/eta`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Sales order not found');
  });

  it('returns 400 for invalid UUID', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/sales-orders/not-a-uuid/eta');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/order ID/i);
  });

  it('returns 403 for unauthorized role', async () => {
    const app = createApp({ role: 'ecommerce_director' });
    const res = await request(app)
      .get(`/sales-orders/${ORDER_ID}/eta`);

    expect(res.status).toBe(403);
  });

  it('allows purchasing_manager access', async () => {
    const app = createApp({ role: 'purchasing_manager' });
    const res = await request(app)
      .get(`/sales-orders/${ORDER_ID}/eta`);

    expect(res.status).toBe(200);
  });
});
