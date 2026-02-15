/**
 * Inventory Ledger Routes
 *
 * CRUD + quantity-adjustment endpoints for the per-facility inventory ledger.
 *
 * Routes:
 *   GET    /facilities/:facilityId/inventory         — paginated list
 *   GET    /facilities/:facilityId/inventory/:partId  — single row
 *   POST   /facilities/:facilityId/inventory          — upsert a row
 *   PATCH  /facilities/:facilityId/inventory/:partId/adjust — adjust quantity
 *   POST   /facilities/:facilityId/inventory/batch-adjust   — batch adjust
 *   GET    /cross-location                            — facility-part matrix
 *   GET    /cross-location/summary                    — network KPIs
 */

import { Router } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@arda/auth-utils';
import type { InventoryField, InventoryAdjustmentType } from '@arda/shared-types';
import { AppError } from '../middleware/error-handler.js';
import {
  getInventory,
  listInventoryByFacility,
  upsertInventory,
  adjustQuantity,
  batchAdjust,
} from '../services/inventory-ledger.service.js';
import {
  getCrossLocationMatrix,
  getCrossLocationSummary,
} from '../services/inventory-cross-location.service.js';

export const inventoryRouter = Router();

function getCorrelationId(req: AuthRequest): string | undefined {
  const header = req.headers['x-correlation-id'];
  if (Array.isArray(header)) {
    return header[0]?.trim() || undefined;
  }
  if (typeof header === 'string') {
    return header.trim() || undefined;
  }
  return undefined;
}

// ─── Schemas ──────────────────────────────────────────────────────────

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

const upsertSchema = z.object({
  partId: z.string().uuid(),
  qtyOnHand: z.number().int().min(0).optional(),
  qtyReserved: z.number().int().min(0).optional(),
  qtyInTransit: z.number().int().min(0).optional(),
  reorderPoint: z.number().int().min(0).optional(),
  reorderQty: z.number().int().min(0).optional(),
});

const adjustSchema = z.object({
  field: z.enum(['qtyOnHand', 'qtyReserved', 'qtyInTransit']),
  adjustmentType: z.enum(['set', 'increment', 'decrement']),
  quantity: z.number().int().min(0),
  source: z.string().optional(),
});

const batchAdjustSchema = z.object({
  adjustments: z.array(
    z.object({
      partId: z.string().uuid(),
      field: z.enum(['qtyOnHand', 'qtyReserved', 'qtyInTransit']),
      adjustmentType: z.enum(['set', 'increment', 'decrement']),
      quantity: z.number().int().min(0),
      source: z.string().optional(),
    })
  ).min(1).max(50),
});

/** Split a comma-separated string of UUIDs and validate each one. */
const csvUuids = z
  .string()
  .optional()
  .transform((val) =>
    val
      ? val.split(',').map((id) => z.string().uuid().parse(id.trim()))
      : undefined
  );

const crossLocationMatrixSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
  partIds: csvUuids,
  facilityIds: csvUuids,
});

const crossLocationSummarySchema = z.object({
  facilityIds: csvUuids,
});

// ─── GET /facilities/:facilityId/inventory — paginated list ───────────

inventoryRouter.get('/facilities/:facilityId/inventory', async (req: AuthRequest, res, next) => {
  try {
    const facilityId = req.params.facilityId as string;
    const { page, pageSize } = paginationSchema.parse(req.query);
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const result = await listInventoryByFacility({
      tenantId,
      facilityId,
      page: page ?? 1,
      pageSize: pageSize ?? 50,
    });

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── GET /facilities/:facilityId/inventory/:partId — single row ──────

inventoryRouter.get('/facilities/:facilityId/inventory/:partId', async (req: AuthRequest, res, next) => {
  try {
    const facilityId = req.params.facilityId as string;
    const partId = req.params.partId as string;
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const row = await getInventory({ tenantId, facilityId, partId });

    if (!row) {
      throw new AppError(404, 'Inventory record not found');
    }

    res.json({ data: row });
  } catch (error) {
    next(error);
  }
});

// ─── POST /facilities/:facilityId/inventory — upsert ─────────────────

inventoryRouter.post('/facilities/:facilityId/inventory', async (req: AuthRequest, res, next) => {
  try {
    const facilityId = req.params.facilityId as string;
    const body = upsertSchema.parse(req.body);
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const result = await upsertInventory({
      tenantId,
      facilityId,
      ...body,
    });

    res.status(201).json({ data: result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// ─── PATCH /facilities/:facilityId/inventory/:partId/adjust ──────────

inventoryRouter.patch('/facilities/:facilityId/inventory/:partId/adjust', async (req: AuthRequest, res, next) => {
  try {
    const facilityId = req.params.facilityId as string;
    const partId = req.params.partId as string;
    const body = adjustSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const correlationId = getCorrelationId(req);

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const result = await adjustQuantity({
      tenantId,
      facilityId,
      partId,
      field: body.field as InventoryField,
      adjustmentType: body.adjustmentType as InventoryAdjustmentType,
      quantity: body.quantity,
      source: body.source,
      userId: req.user?.sub,
      correlationId,
      route: '/inventory/facilities/:facilityId/inventory/:partId/adjust',
    });

    res.json({ data: result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// ─── POST /facilities/:facilityId/inventory/batch-adjust ─────────────

inventoryRouter.post('/facilities/:facilityId/inventory/batch-adjust', async (req: AuthRequest, res, next) => {
  try {
    const facilityId = req.params.facilityId as string;
    const { adjustments } = batchAdjustSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const correlationId = getCorrelationId(req);

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const results = await batchAdjust(
      adjustments.map((a) => ({
        tenantId,
        facilityId,
        partId: a.partId,
        field: a.field as InventoryField,
        adjustmentType: a.adjustmentType as InventoryAdjustmentType,
        quantity: a.quantity,
        source: a.source,
        userId: req.user?.sub,
        correlationId,
        route: '/inventory/facilities/:facilityId/inventory/batch-adjust',
      }))
    );

    res.json({ data: results });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// ─── GET /cross-location — facility-part matrix ───────────────────────

inventoryRouter.get('/cross-location', async (req: AuthRequest, res, next) => {
  try {
    const { page, pageSize, partIds, facilityIds } = crossLocationMatrixSchema.parse(req.query);
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const result = await getCrossLocationMatrix({
      tenantId,
      page: page ?? 1,
      pageSize: pageSize ?? 50,
      partIds,
      facilityIds,
    });

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── GET /cross-location/summary — network KPIs ───────────────────────

inventoryRouter.get('/cross-location/summary', async (req: AuthRequest, res, next) => {
  try {
    const { facilityIds } = crossLocationSummarySchema.parse(req.query);
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const result = await getCrossLocationSummary({
      tenantId,
      facilityIds,
    });

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});
