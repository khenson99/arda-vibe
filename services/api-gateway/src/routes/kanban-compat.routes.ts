import { Router } from 'express';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';

interface HttpLikeError extends Error {
  status?: number;
}

export const kanbanCompatRouter = Router();

const listLoopsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  loopType: z.enum(['procurement', 'production', 'transfer']).optional(),
  facilityId: z.string().uuid().optional(),
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
    const whereClause = and(...conditions);

    const [data, totalRows] = await Promise.all([
      db.select().from(kanbanLoops).where(whereClause).limit(query.pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(kanbanLoops).where(whereClause),
    ]);

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
    res.json(updated);
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
