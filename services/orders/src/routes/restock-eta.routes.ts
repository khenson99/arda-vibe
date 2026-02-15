import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type AuthRequest } from '@arda/auth-utils';
import { createLogger } from '@arda/config';
import {
  calculateRestockEta,
  calculateBatchRestockEta,
  calculateSalesOrderLineEtas,
} from '../services/restock-eta.service.js';
import { AppError } from '../middleware/error-handler.js';

const log = createLogger('orders:restock-eta-routes');

// ─── RBAC ───────────────────────────────────────────────────────────
// Readers: inventory_manager, purchasing_manager, production_manager, salesperson
// (+ tenant_admin via middleware)
const canRead = requireRole(
  'inventory_manager',
  'purchasing_manager',
  'production_manager',
  'salesperson',
);

// ─── Validation Schemas ─────────────────────────────────────────────
const batchEtaSchema = z.object({
  items: z
    .array(
      z.object({
        partId: z.string().uuid(),
        facilityId: z.string().uuid(),
      }),
    )
    .min(1)
    .max(100),
});

export const restockEtaRouter = Router();

// ─── GET /restock-eta/:partId ───────────────────────────────────────
// Single part ETA at a facility.
// Query param: facilityId (required)
restockEtaRouter.get('/:partId', canRead, async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user!.tenantId;
    const partId = Array.isArray(req.params.partId)
      ? req.params.partId[0]
      : req.params.partId;
    const facilityId = req.query.facilityId;

    if (!facilityId || typeof facilityId !== 'string') {
      throw new AppError(400, 'facilityId query parameter is required');
    }

    // Validate UUIDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(partId)) {
      throw new AppError(400, 'Invalid partId format');
    }
    if (!uuidRegex.test(facilityId)) {
      throw new AppError(400, 'Invalid facilityId format');
    }

    const result = await calculateRestockEta(tenantId, facilityId, partId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST /restock-eta/batch ────────────────────────────────────────
// Batch ETA for multiple part+facility combinations.
restockEtaRouter.post('/batch', canRead, async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user!.tenantId;

    const parsed = batchEtaSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, `Validation error: ${parsed.error.errors.map((e) => e.message).join(', ')}`);
    }

    const results = await calculateBatchRestockEta(tenantId, parsed.data.items);
    res.json({ items: results });
  } catch (err) {
    next(err);
  }
});

// ─── GET /sales-orders/:id/eta ──────────────────────────────────────
// Per-line ETA for a sales order.
// This is mounted at /sales-orders/:id/eta in the index.
export const salesOrderEtaRouter = Router();

salesOrderEtaRouter.get('/:id/eta', canRead, async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user!.tenantId;
    const orderId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(orderId)) {
      throw new AppError(400, 'Invalid order ID format');
    }

    const result = await calculateSalesOrderLineEtas(tenantId, orderId);
    res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message === 'Sales order not found') {
      next(new AppError(404, 'Sales order not found'));
    } else {
      next(err);
    }
  }
});
