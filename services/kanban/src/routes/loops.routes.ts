import { Router } from 'express';
import { z } from 'zod';
import { eq, and, inArray, sql, gt } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
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

type LoopRecord = {
  id: string;
  partId: string;
  facilityId: string;
  primarySupplierId: string | null;
  sourceFacilityId: string | null;
  [key: string]: unknown;
};

async function enrichLoops<T extends LoopRecord>(tenantId: string, loops: T[]): Promise<Array<T & {
  partName: string | null;
  partNumber: string | null;
  facilityName: string | null;
  primarySupplierName: string | null;
  sourceFacilityName: string | null;
}>> {
  if (loops.length === 0) return [];

  const partIds = [...new Set(loops.map((loop) => loop.partId).filter(Boolean))];
  const facilityIds = [...new Set(loops.map((loop) => loop.facilityId).filter(Boolean))];
  const sourceFacilityIds = [
    ...new Set(loops.map((loop) => loop.sourceFacilityId).filter((id): id is string => !!id)),
  ];
  const primarySupplierIds = [
    ...new Set(loops.map((loop) => loop.primarySupplierId).filter((id): id is string => !!id)),
  ];
  const allFacilityIds = [...new Set([...facilityIds, ...sourceFacilityIds])];

  const [partsRows, facilitiesRows, suppliersRows] = await Promise.all([
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
  const facilityMap = new Map(facilitiesRows.map((row) => [row.id, row.name]));
  const supplierMap = new Map(suppliersRows.map((row) => [row.id, row.name]));

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

// ─── GET /loops ───────────────────────────────────────────────────────
loopsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const facilityId = req.query.facilityId as string | undefined;
    const loopType = req.query.loopType as string | undefined;
    const partId = req.query.partId as string | undefined;

    const conditions = [eq(kanbanLoops.tenantId, tenantId), eq(kanbanLoops.isActive, true)];
    if (facilityId) conditions.push(eq(kanbanLoops.facilityId, facilityId));
    if (loopType) conditions.push(eq(kanbanLoops.loopType, loopType as (typeof schema.loopTypeEnum.enumValues)[number]));
    if (partId) conditions.push(eq(kanbanLoops.partId, partId));

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [rawData, countResult] = await Promise.all([
      db.select().from(kanbanLoops).where(whereClause).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(kanbanLoops).where(whereClause),
    ]);
    const data = await enrichLoops(tenantId, rawData as LoopRecord[]);

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
    const tenantId = req.user!.tenantId;
    const loopId = req.params.id as string;
    const loop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
    });

    if (!loop) throw new AppError(404, 'Kanban loop not found');
    const [cardsRows, parameterHistoryRows, recommendationsRows] = await Promise.all([
      db
        .select()
        .from(kanbanCards)
        .where(
          and(eq(kanbanCards.loopId, loopId), eq(kanbanCards.tenantId, tenantId), eq(kanbanCards.isActive, true)),
        )
        .orderBy(kanbanCards.cardNumber)
        .execute(),
      db
        .select()
        .from(schema.kanbanParameterHistory)
        .where(and(eq(schema.kanbanParameterHistory.loopId, loopId), eq(schema.kanbanParameterHistory.tenantId, tenantId)))
        .orderBy(schema.kanbanParameterHistory.createdAt)
        .execute(),
      db
        .select()
        .from(schema.reloWisaRecommendations)
        .where(and(eq(schema.reloWisaRecommendations.loopId, loopId), eq(schema.reloWisaRecommendations.tenantId, tenantId)))
        .orderBy(schema.reloWisaRecommendations.createdAt)
        .execute(),
    ]);
    const [enrichedLoop] = await enrichLoops(tenantId, [loop as LoopRecord]);
    if (!enrichedLoop) throw new AppError(404, 'Kanban loop not found');

    const cards = cardsRows.map((card) => ({
      ...card,
      loopType: loop.loopType,
      partId: loop.partId,
      partName: enrichedLoop.partName,
      partNumber: enrichedLoop.partNumber,
      facilityId: loop.facilityId,
      facilityName: enrichedLoop.facilityName,
      supplierName: enrichedLoop.primarySupplierName,
      minQuantity: loop.minQuantity,
      orderQuantity: loop.orderQuantity,
      numberOfCards: loop.numberOfCards,
    }));

    res.json({
      ...enrichedLoop,
      cards,
      parameterHistory: parameterHistoryRows,
      recommendations: recommendationsRows,
    });
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

      // Audit: loop created
      await writeAuditEntry(tx, {
        tenantId,
        userId: req.user!.sub,
        action: 'loop.created',
        entityType: 'kanban_loop',
        entityId: loop.id,
        newState: {
          loopType: input.loopType,
          cardMode: input.cardMode,
          minQuantity: input.minQuantity,
          orderQuantity: input.orderQuantity,
          numberOfCards: input.numberOfCards,
          partId: input.partId,
          facilityId: input.facilityId,
        },
        metadata: {
          cardsCreated: cards.length,
          ...(input.primarySupplierId ? { primarySupplierId: input.primarySupplierId } : {}),
          ...(input.sourceFacilityId ? { sourceFacilityId: input.sourceFacilityId } : {}),
        },
      });

      return { loop, cards };
    });

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      let loopId: string | undefined;
      const parsedInput = createLoopSchema.safeParse(req.body);
      if (parsedInput.success) {
        const existing = await db.query.kanbanLoops.findFirst({
          where: and(
            eq(kanbanLoops.tenantId, req.user!.tenantId),
            eq(kanbanLoops.partId, parsedInput.data.partId),
            eq(kanbanLoops.facilityId, parsedInput.data.facilityId),
            eq(kanbanLoops.loopType, parsedInput.data.loopType)
          ),
        });
        loopId = existing?.id;
      }

      res.status(409).json({
        error: 'A loop already exists for this part, facility, and loop type.',
        code: 'LOOP_ALREADY_EXISTS',
        loopId,
      });
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
      leadTimeDays: z.number().int().nonnegative().optional(),
      statedLeadTimeDays: z.number().int().nonnegative().optional(),
      safetyStockDays: z.number().nonnegative().optional(),
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
      const leadTimeDays = input.statedLeadTimeDays ?? input.leadTimeDays;
      if (leadTimeDays !== undefined) updateFields.statedLeadTimeDays = leadTimeDays;
      if (input.safetyStockDays !== undefined) {
        updateFields.safetyStockDays = String(input.safetyStockDays);
      }

      await tx
        .update(kanbanLoops)
        .set(updateFields)
        .where(and(eq(kanbanLoops.id, req.params.id as string), eq(kanbanLoops.tenantId, tenantId)));

      // Audit: loop parameters changed
      await writeAuditEntry(tx, {
        tenantId,
        userId: req.user!.sub,
        action: 'loop.parameters_changed',
        entityType: 'kanban_loop',
        entityId: req.params.id as string,
        previousState: {
          minQuantity: existingLoop.minQuantity,
          orderQuantity: existingLoop.orderQuantity,
          numberOfCards: existingLoop.numberOfCards,
        },
        newState: {
          minQuantity: input.minQuantity ?? existingLoop.minQuantity,
          orderQuantity: input.orderQuantity ?? existingLoop.orderQuantity,
          numberOfCards: input.numberOfCards ?? existingLoop.numberOfCards,
        },
        metadata: { reason: input.reason },
      });

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
      where: and(eq(kanbanLoops.id, req.params.id as string), eq(kanbanLoops.tenantId, tenantId)),
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

    if (!updated) throw new AppError(404, 'Loop not found');
    const [enrichedUpdated] = await enrichLoops(tenantId, [updated as LoopRecord]);
    if (!enrichedUpdated) throw new AppError(404, 'Loop not found');
    res.json({
      ...enrichedUpdated,
      cards: updated.cards,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});
