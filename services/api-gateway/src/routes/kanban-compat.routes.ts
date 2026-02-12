import { Router } from 'express';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { serviceUrls } from '@arda/config';

interface HttpLikeError extends Error {
  status?: number;
}

export const kanbanCompatRouter = Router();

const listLoopsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  loopType: z.enum(['procurement', 'production', 'transfer']).optional(),
  facilityId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
});

const patchLoopParamsSchema = z.object({
  minQuantity: z.coerce.number().int().positive().optional(),
  orderQuantity: z.coerce.number().int().positive().optional(),
  numberOfCards: z.coerce.number().int().positive().optional(),
  leadTimeDays: z.coerce.number().int().nonnegative().optional(),
  statedLeadTimeDays: z.coerce.number().int().nonnegative().optional(),
  safetyStockDays: z.coerce.number().nonnegative().optional(),
  reason: z.string().trim().min(1).optional(),
});

function requireTenantId(req: AuthRequest): string {
  const tenantId = req.user?.tenantId?.trim();
  if (!tenantId) {
    const error = new Error('Unauthorized') as HttpLikeError;
    error.status = 401;
    throw error;
  }
  return tenantId;
}

function normalizeToken(req: AuthRequest): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    const error = new Error('Unauthorized') as HttpLikeError;
    error.status = 401;
    throw error;
  }
  return header.slice('Bearer '.length).trim();
}

function isServiceUnavailableStatus(status: number): boolean {
  // Fallback should handle any upstream 5xx condition for read-only loop detail.
  return status >= 500 && status < 600;
}

async function parseErrorMessageFromResponse(response: Response): Promise<string> {
  const bodyText = await response.text();
  let message = bodyText?.trim() || `Kanban request failed (${response.status})`;
  if (bodyText?.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        message = parsed.error.trim();
      } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
        message = parsed.message.trim();
      }
    } catch {
      // Keep message fallback when upstream body is plain text.
    }
  }
  return message;
}

type LoopRecord = {
  id: string;
  partId: string;
  facilityId: string;
  primarySupplierId: string | null;
  sourceFacilityId: string | null;
  [key: string]: unknown;
};

async function enrichLoopRecords<T extends LoopRecord>(tenantId: string, loops: T[]): Promise<Array<T & {
  partName: string | null;
  partNumber: string | null;
  facilityName: string | null;
  primarySupplierName: string | null;
  sourceFacilityName: string | null;
}>> {
  if (loops.length === 0) return [];

  const partIds = [...new Set(loops.map((loop) => loop.partId).filter(Boolean))];
  const facilityIds = [...new Set(loops.map((loop) => loop.facilityId).filter(Boolean))];
  const primarySupplierIds = [
    ...new Set(loops.map((loop) => loop.primarySupplierId).filter((id): id is string => !!id)),
  ];
  const sourceFacilityIds = [
    ...new Set(loops.map((loop) => loop.sourceFacilityId).filter((id): id is string => !!id)),
  ];
  const allFacilityIds = [...new Set([...facilityIds, ...sourceFacilityIds])];

  const [partsRows, facilityRows, supplierRows] = await Promise.all([
    partIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: schema.parts.id, name: schema.parts.name, partNumber: schema.parts.partNumber })
          .from(schema.parts)
          .where(and(eq(schema.parts.tenantId, tenantId), inArray(schema.parts.id, partIds)))
          .execute(),
    allFacilityIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: schema.facilities.id, name: schema.facilities.name })
          .from(schema.facilities)
          .where(and(eq(schema.facilities.tenantId, tenantId), inArray(schema.facilities.id, allFacilityIds)))
          .execute(),
    primarySupplierIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: schema.suppliers.id, name: schema.suppliers.name })
          .from(schema.suppliers)
          .where(and(eq(schema.suppliers.tenantId, tenantId), inArray(schema.suppliers.id, primarySupplierIds)))
          .execute(),
  ]);

  const partMap = new Map(partsRows.map((row) => [row.id, row]));
  const facilityMap = new Map(facilityRows.map((row) => [row.id, row.name]));
  const supplierMap = new Map(supplierRows.map((row) => [row.id, row.name]));

  return loops.map((loop) => {
    const part = partMap.get(loop.partId);
    return {
      ...loop,
      partName: part?.name ?? null,
      partNumber: part?.partNumber ?? null,
      facilityName: facilityMap.get(loop.facilityId) ?? null,
      primarySupplierName: loop.primarySupplierId ? supplierMap.get(loop.primarySupplierId) ?? null : null,
      sourceFacilityName: loop.sourceFacilityId ? facilityMap.get(loop.sourceFacilityId) ?? null : null,
    };
  });
}

const { kanbanLoops, kanbanCards, kanbanParameterHistory } = schema;

// Local compatibility route for list loops.
// This router is mounted at /api/kanban/loops.
kanbanCompatRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const query = listLoopsQuerySchema.parse(req.query ?? {});
    const offset = (query.page - 1) * query.pageSize;

    const conditions = [eq(kanbanLoops.tenantId, tenantId), eq(kanbanLoops.isActive, true)];
    if (query.loopType) {
      conditions.push(eq(kanbanLoops.loopType, query.loopType));
    }
    if (query.facilityId) {
      conditions.push(eq(kanbanLoops.facilityId, query.facilityId));
    }
    if (query.partId) {
      conditions.push(eq(kanbanLoops.partId, query.partId));
    }
    const whereClause = and(...conditions);

    const [rawData, totalRows] = await Promise.all([
      db.select().from(kanbanLoops).where(whereClause).limit(query.pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(kanbanLoops).where(whereClause),
    ]);
    const data = await enrichLoopRecords(tenantId, rawData as LoopRecord[]);

    const total = Number(totalRows[0]?.count ?? 0);
    res.json({
      data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors.map((entry) => ({
          field: entry.path.join('.'),
          message: entry.message,
        })),
      });
      return;
    }
    const status = (error as HttpLikeError)?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    next(error);
  }
});

// Compatibility route for loop detail with upstream-first + local fallback.
kanbanCompatRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const token = normalizeToken(req);
    const loopIdRaw = req.params.id;
    const loopId = (Array.isArray(loopIdRaw) ? loopIdRaw[0] : loopIdRaw || '').trim();
    if (!loopId) {
      res.status(400).json({ error: 'Loop id is required' });
      return;
    }

    // Prefer primary kanban service. Fall back only when upstream is unavailable.
    try {
      const upstream = await fetch(`${serviceUrls.kanban}/loops/${encodeURIComponent(loopId)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (upstream.ok) {
        const body = (await upstream.json()) as unknown;
        res.json(body);
        return;
      }

      if (!isServiceUnavailableStatus(upstream.status)) {
        const message = await parseErrorMessageFromResponse(upstream);
        res.status(upstream.status).json({ error: message });
        return;
      }
    } catch {
      // Network-level upstream failure falls through to local fallback.
    }

    const fallbackLoop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
      with: {
        cards: true,
        parameterHistory: { orderBy: schema.kanbanParameterHistory.createdAt },
      },
    });
    if (!fallbackLoop) {
      res.status(404).json({ error: 'Loop not found' });
      return;
    }

    const [enriched] = await enrichLoopRecords(tenantId, [fallbackLoop as LoopRecord]);
    if (!enriched) {
      res.status(404).json({ error: 'Loop not found' });
      return;
    }

    const cards = (fallbackLoop.cards ?? []).map((card) => ({
      ...card,
      loopType: fallbackLoop.loopType,
      partId: fallbackLoop.partId,
      partName: enriched.partName,
      partNumber: enriched.partNumber,
      facilityId: fallbackLoop.facilityId,
      facilityName: enriched.facilityName,
      supplierName: enriched.primarySupplierName,
      minQuantity: fallbackLoop.minQuantity,
      orderQuantity: fallbackLoop.orderQuantity,
      numberOfCards: fallbackLoop.numberOfCards,
    }));

    res.json({
      ...enriched,
      cards,
      parameterHistory: fallbackLoop.parameterHistory,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors.map((entry) => ({
          field: entry.path.join('.'),
          message: entry.message,
        })),
      });
      return;
    }
    const status = (error as HttpLikeError)?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    next(error);
  }
});

// Local compatibility route for updating loop parameters.
// Supports the create-card quick action behavior (incrementing numberOfCards and inserting cards).
kanbanCompatRouter.patch('/:id/parameters', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = requireTenantId(req);
    const loopIdRaw = req.params.id;
    const loopId = (Array.isArray(loopIdRaw) ? loopIdRaw[0] : loopIdRaw || '').trim();
    if (!loopId) {
      res.status(400).json({ error: 'Loop id is required' });
      return;
    }

    const input = patchLoopParamsSchema.parse(req.body ?? {});
    if (
      input.minQuantity === undefined &&
      input.orderQuantity === undefined &&
      input.numberOfCards === undefined &&
      input.statedLeadTimeDays === undefined &&
      input.leadTimeDays === undefined &&
      input.safetyStockDays === undefined
    ) {
      res.status(400).json({ error: 'At least one parameter is required' });
      return;
    }

    const existingLoop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
    });
    if (!existingLoop) {
      res.status(404).json({ error: 'Loop not found' });
      return;
    }

    const reason = input.reason?.trim() || 'Updated via api-gateway compatibility route';
    const changedByUserId = req.user?.sub ?? null;

    await db.transaction(async (tx) => {
      await tx.insert(kanbanParameterHistory).values({
        tenantId,
        loopId,
        changeType: 'manual',
        previousMinQuantity: existingLoop.minQuantity,
        newMinQuantity: input.minQuantity ?? existingLoop.minQuantity,
        previousOrderQuantity: existingLoop.orderQuantity,
        newOrderQuantity: input.orderQuantity ?? existingLoop.orderQuantity,
        previousNumberOfCards: existingLoop.numberOfCards,
        newNumberOfCards: input.numberOfCards ?? existingLoop.numberOfCards,
        reason,
        changedByUserId,
      });

      const updateFields: Record<string, unknown> = { updatedAt: new Date() };
      if (input.minQuantity !== undefined) updateFields.minQuantity = input.minQuantity;
      if (input.orderQuantity !== undefined) updateFields.orderQuantity = input.orderQuantity;
      if (input.numberOfCards !== undefined) updateFields.numberOfCards = input.numberOfCards;
      const leadTimeDays = input.statedLeadTimeDays ?? input.leadTimeDays;
      if (leadTimeDays !== undefined) updateFields.statedLeadTimeDays = leadTimeDays;
      if (input.safetyStockDays !== undefined) {
        updateFields.safetyStockDays = String(input.safetyStockDays);
      }

      await tx
        .update(kanbanLoops)
        .set(updateFields)
        .where(and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)));

      if (input.numberOfCards !== undefined && input.numberOfCards !== existingLoop.numberOfCards) {
        if (input.numberOfCards > existingLoop.numberOfCards) {
          const [maxCardNumberRow] = await tx
            .select({ maxCardNumber: sql<number>`coalesce(max(${kanbanCards.cardNumber}), 0)` })
            .from(kanbanCards)
            .where(and(eq(kanbanCards.loopId, loopId), eq(kanbanCards.tenantId, tenantId)));

          const currentMax = Number(maxCardNumberRow?.maxCardNumber ?? 0);
          const cardsToAdd = input.numberOfCards - existingLoop.numberOfCards;
          const now = new Date();
          const newCards = Array.from({ length: cardsToAdd }, (_, index) => ({
            tenantId,
            loopId,
            cardNumber: currentMax + index + 1,
            currentStage: 'created' as const,
            currentStageEnteredAt: now,
          }));
          if (newCards.length > 0) {
            await tx.insert(kanbanCards).values(newCards);
          }
        }

        if (input.numberOfCards < existingLoop.numberOfCards) {
          await tx
            .update(kanbanCards)
            .set({ isActive: false, updatedAt: new Date() })
            .where(
              and(
                eq(kanbanCards.loopId, loopId),
                eq(kanbanCards.tenantId, tenantId),
                gt(kanbanCards.cardNumber, input.numberOfCards),
              ),
            );
        }
      }
    });

    const updated = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
      with: { cards: true },
    });
    if (!updated) {
      res.status(404).json({ error: 'Loop not found' });
      return;
    }
    const [enriched] = await enrichLoopRecords(tenantId, [updated as LoopRecord]);
    if (!enriched) {
      res.status(404).json({ error: 'Loop not found' });
      return;
    }
    const cards = (updated.cards ?? []).map((card) => ({
      ...card,
      loopType: updated.loopType,
      partId: updated.partId,
      partName: enriched.partName,
      partNumber: enriched.partNumber,
      facilityId: updated.facilityId,
      facilityName: enriched.facilityName,
      supplierName: enriched.primarySupplierName,
      minQuantity: updated.minQuantity,
      orderQuantity: updated.orderQuantity,
      numberOfCards: updated.numberOfCards,
    }));
    res.json({
      ...enriched,
      cards,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors.map((entry) => ({
          field: entry.path.join('.'),
          message: entry.message,
        })),
      });
      return;
    }
    const status = (error as HttpLikeError)?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    next(error);
  }
});
