import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, gt } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import { getEventBus } from '@arda/events';
import { config } from '@arda/config';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

export const loopsRouter = Router();
const { kanbanLoops, kanbanCards } = schema;

const createLoopSchema = z.object({
  partId: z.string().uuid(),
  facilityId: z.string().uuid(),
  storageLocationId: z.string().uuid().optional(),
  loopType: z.enum(['procurement', 'production', 'transfer']),
  cardMode: z.enum(['single', 'multi']).default('single'),
  minQuantity: z.number().int().positive(),
  orderQuantity: z.number().int().positive(),
  numberOfCards: z.number().int().positive().default(1),
  safetyStockDays: z.string().optional(),
  primarySupplierId: z.string().uuid().optional(),
  sourceFacilityId: z.string().uuid().optional(),
  statedLeadTimeDays: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

// ─── GET /loops ───────────────────────────────────────────────────────
loopsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const facilityId = req.query.facilityId as string | undefined;
    const loopType = req.query.loopType as string | undefined;

    const conditions = [eq(kanbanLoops.tenantId, tenantId), eq(kanbanLoops.isActive, true)];
    if (facilityId) conditions.push(eq(kanbanLoops.facilityId, facilityId));
    if (loopType) conditions.push(eq(kanbanLoops.loopType, loopType as (typeof schema.loopTypeEnum.enumValues)[number]));

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [data, countResult] = await Promise.all([
      db.select().from(kanbanLoops).where(whereClause).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(kanbanLoops).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    res.json({
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /loops/:id ──────────────────────────────────────────────────
loopsRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const loop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, req.params.id as string), eq(kanbanLoops.tenantId, req.user!.tenantId)),
      with: {
        cards: true,
        parameterHistory: { orderBy: schema.kanbanParameterHistory.createdAt },
        recommendations: { orderBy: schema.reloWisaRecommendations.createdAt },
      },
    });

    if (!loop) throw new AppError(404, 'Kanban loop not found');
    res.json(loop);
  } catch (err) {
    next(err);
  }
});

// ─── POST /loops — Create a Loop + Its Cards ─────────────────────────
loopsRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const input = createLoopSchema.parse(req.body);
    const tenantId = req.user!.tenantId;

    // Validate loop type constraints
    if (input.loopType === 'procurement' && !input.primarySupplierId) {
      throw new AppError(400, 'Procurement loops require a primarySupplierId');
    }
    if (input.loopType === 'transfer' && !input.sourceFacilityId) {
      throw new AppError(400, 'Transfer loops require a sourceFacilityId');
    }
    if (input.cardMode === 'single' && input.numberOfCards !== 1) {
      throw new AppError(400, 'Single-card mode requires numberOfCards = 1');
    }

    // Create loop + cards in a transaction
    const result = await db.transaction(async (tx) => {
      const [loop] = await tx
        .insert(kanbanLoops)
        .values({ ...input, tenantId })
        .returning();

      // Create the physical cards for this loop
      const cardValues = Array.from({ length: input.numberOfCards }, (_, i) => ({
        tenantId,
        loopId: loop.id,
        cardNumber: i + 1,
        currentStage: 'created' as const,
        currentStageEnteredAt: new Date(),
      }));

      const cards = await tx.insert(kanbanCards).values(cardValues).returning();

      // Record initial parameter set in history
      await tx.insert(schema.kanbanParameterHistory).values({
        tenantId,
        loopId: loop.id,
        changeType: 'manual',
        newMinQuantity: input.minQuantity,
        newOrderQuantity: input.orderQuantity,
        newNumberOfCards: input.numberOfCards,
        reason: 'Initial loop creation',
        changedByUserId: req.user!.sub,
      });

      return { loop, cards };
    });

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /loops/:id/parameters — Update Kanban Parameters ──────────
loopsRouter.patch('/:id/parameters', async (req: AuthRequest, res, next) => {
  try {
    const paramSchema = z.object({
      minQuantity: z.number().int().positive().optional(),
      orderQuantity: z.number().int().positive().optional(),
      numberOfCards: z.number().int().positive().optional(),
      reason: z.string().min(1, 'Reason is required for parameter changes'),
    });

    const input = paramSchema.parse(req.body);
    const tenantId = req.user!.tenantId;

    const existingLoop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, req.params.id as string), eq(kanbanLoops.tenantId, tenantId)),
    });
    if (!existingLoop) throw new AppError(404, 'Loop not found');

    await db.transaction(async (tx) => {
      // Record parameter change history
      await tx.insert(schema.kanbanParameterHistory).values({
        tenantId,
        loopId: req.params.id as string,
        changeType: 'manual',
        previousMinQuantity: existingLoop.minQuantity,
        newMinQuantity: input.minQuantity ?? existingLoop.minQuantity,
        previousOrderQuantity: existingLoop.orderQuantity,
        newOrderQuantity: input.orderQuantity ?? existingLoop.orderQuantity,
        previousNumberOfCards: existingLoop.numberOfCards,
        newNumberOfCards: input.numberOfCards ?? existingLoop.numberOfCards,
        reason: input.reason,
        changedByUserId: req.user!.sub,
      });

      // Update the loop
      const updateFields: Record<string, unknown> = { updatedAt: new Date() };
      if (input.minQuantity) updateFields.minQuantity = input.minQuantity;
      if (input.orderQuantity) updateFields.orderQuantity = input.orderQuantity;
      if (input.numberOfCards) updateFields.numberOfCards = input.numberOfCards;

      await tx
        .update(kanbanLoops)
        .set(updateFields)
        .where(eq(kanbanLoops.id, req.params.id as string));

      // If numberOfCards changed, add or deactivate cards
      if (input.numberOfCards && input.numberOfCards !== existingLoop.numberOfCards) {
        if (input.numberOfCards > existingLoop.numberOfCards) {
          // Add new cards
          const newCards = Array.from(
            { length: input.numberOfCards - existingLoop.numberOfCards },
            (_, i) => ({
              tenantId,
              loopId: req.params.id as string,
              cardNumber: existingLoop.numberOfCards + i + 1,
              currentStage: 'created' as const,
              currentStageEnteredAt: new Date(),
            })
          );
          await tx.insert(kanbanCards).values(newCards);
        }
        // If reducing, we deactivate excess cards (don't delete — preserve history)
        if (input.numberOfCards < existingLoop.numberOfCards) {
          await tx
            .update(kanbanCards)
            .set({ isActive: false, updatedAt: new Date() })
            .where(
              and(
                eq(kanbanCards.loopId, req.params.id as string),
                eq(kanbanCards.tenantId, tenantId),
                gt(kanbanCards.cardNumber, input.numberOfCards)
              )
            );
        }
      }
    });

    const updated = await db.query.kanbanLoops.findFirst({
      where: eq(kanbanLoops.id, req.params.id as string),
      with: { cards: true },
    });

    if (updated) {
      try {
        const eventBus = getEventBus(config.REDIS_URL);
        await eventBus.publish({
          type: 'loop.parameters_changed',
          tenantId,
          loopId: updated.id,
          changeType: 'manual',
          reason: input.reason,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(
          `[loops] Failed to publish loop.parameters_changed event for loop ${req.params.id as string}`
        );
      }
    }

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});
