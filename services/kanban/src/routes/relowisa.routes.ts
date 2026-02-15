import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import { getEventBus } from '@arda/events';
import { config } from '@arda/config';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

export const reloWisaRouter = Router();
const {
  kanbanLoops,
  kanbanCards,
  kanbanParameterHistory,
  reloWisaRecommendations,
} = schema;

// Counting stages: cards in these stages represent in-flight replenishment
const COUNTING_STAGES = ['triggered', 'ordered', 'in_transit'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────

interface ReloWisaMetrics {
  reorderPoint: number;
  lotSize: number;
  wipLimit: number | null;
  safetyStockDays: number;
  leadTimeDays: number | null;
  numberOfCards: number;
  // Calculated
  inFlightCards: number;
  inFlightQuantity: number;
  totalInferredQuantity: number;
  wipUtilization: number | null; // percentage of wip limit used
  // Thresholds
  nearReorderPoint: boolean;
  atWipLimit: boolean;
  belowSafetyStock: boolean;
}

function computeReloWisaMetrics(
  loop: {
    minQuantity: number;
    orderQuantity: number;
    numberOfCards: number;
    wipLimit: number | null;
    safetyStockDays: string | null;
    statedLeadTimeDays: number | null;
  },
  cards: Array<{ currentStage: string }>,
): ReloWisaMetrics {
  const inFlightCards = cards.filter((c) =>
    COUNTING_STAGES.includes(c.currentStage as typeof COUNTING_STAGES[number]),
  ).length;
  const inFlightQuantity = inFlightCards * loop.orderQuantity;

  // WIP utilization: percentage of wip limit consumed by in-flight cards
  const wipUtilization =
    loop.wipLimit != null && loop.wipLimit > 0
      ? Math.round((inFlightCards / loop.wipLimit) * 100)
      : null;

  // Threshold indicators
  const nearReorderPoint = inFlightQuantity <= loop.minQuantity * 1.2;
  const atWipLimit =
    loop.wipLimit != null && inFlightCards >= loop.wipLimit;
  const safetyStockDays = Number(loop.safetyStockDays) || 0;
  const belowSafetyStock = safetyStockDays > 0 && inFlightQuantity < loop.minQuantity;

  return {
    reorderPoint: loop.minQuantity,
    lotSize: loop.orderQuantity,
    wipLimit: loop.wipLimit,
    safetyStockDays,
    leadTimeDays: loop.statedLeadTimeDays,
    numberOfCards: loop.numberOfCards,
    inFlightCards,
    inFlightQuantity,
    totalInferredQuantity: inFlightQuantity,
    wipUtilization,
    nearReorderPoint,
    atWipLimit,
    belowSafetyStock,
  };
}

// ─── GET /:loopId/relowisa — ReLoWiSa summary for a loop ─────────────
reloWisaRouter.get('/:loopId/relowisa', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const loopId = req.params.loopId as string;

    const loop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
    });
    if (!loop) throw new AppError(404, 'Kanban loop not found');

    // Get active cards for metrics
    const cards = await db
      .select({ currentStage: kanbanCards.currentStage })
      .from(kanbanCards)
      .where(
        and(
          eq(kanbanCards.loopId, loopId),
          eq(kanbanCards.tenantId, tenantId),
          eq(kanbanCards.isActive, true),
        ),
      );

    const metrics = computeReloWisaMetrics(loop, cards);

    // Get latest pending recommendation
    const latestRecommendation = await db
      .select()
      .from(reloWisaRecommendations)
      .where(
        and(
          eq(reloWisaRecommendations.loopId, loopId),
          eq(reloWisaRecommendations.tenantId, tenantId),
          eq(reloWisaRecommendations.status, 'pending'),
        ),
      )
      .orderBy(desc(reloWisaRecommendations.createdAt))
      .limit(1);

    // Get recent parameter changes (last 10)
    const recentChanges = await db
      .select()
      .from(kanbanParameterHistory)
      .where(
        and(
          eq(kanbanParameterHistory.loopId, loopId),
          eq(kanbanParameterHistory.tenantId, tenantId),
        ),
      )
      .orderBy(desc(kanbanParameterHistory.createdAt))
      .limit(10);

    res.json({
      loopId,
      metrics,
      pendingRecommendation: latestRecommendation[0] ?? null,
      recentChanges,
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /:loopId/relowisa — Update all ReLoWiSa parameters ──────────
const updateReloWisaSchema = z.object({
  reorderPoint: z.number().int().positive().optional(),
  lotSize: z.number().int().positive().optional(),
  wipLimit: z.number().int().positive().nullable().optional(),
  safetyStockDays: z.number().nonnegative().optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
  numberOfCards: z.number().int().positive().optional(),
  reason: z.string().min(1, 'Reason is required for ReLoWiSa changes'),
});

reloWisaRouter.put('/:loopId/relowisa', async (req: AuthRequest, res, next) => {
  try {
    const input = updateReloWisaSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const loopId = req.params.loopId as string;

    const existingLoop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
    });
    if (!existingLoop) throw new AppError(404, 'Kanban loop not found');

    // Build the update fields
    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (input.reorderPoint !== undefined) updateFields.minQuantity = input.reorderPoint;
    if (input.lotSize !== undefined) updateFields.orderQuantity = input.lotSize;
    if (input.wipLimit !== undefined) updateFields.wipLimit = input.wipLimit;
    if (input.safetyStockDays !== undefined) updateFields.safetyStockDays = String(input.safetyStockDays);
    if (input.leadTimeDays !== undefined) updateFields.statedLeadTimeDays = input.leadTimeDays;
    if (input.numberOfCards !== undefined) updateFields.numberOfCards = input.numberOfCards;

    await db.transaction(async (tx) => {
      // Record parameter change history
      await tx.insert(kanbanParameterHistory).values({
        tenantId,
        loopId,
        changeType: 'manual',
        reason: input.reason,
        changedByUserId: req.user!.sub,
        ...(input.reorderPoint !== undefined ? {
          previousMinQuantity: existingLoop.minQuantity,
          newMinQuantity: input.reorderPoint,
        } : {}),
        ...(input.lotSize !== undefined ? {
          previousOrderQuantity: existingLoop.orderQuantity,
          newOrderQuantity: input.lotSize,
        } : {}),
        ...(input.numberOfCards !== undefined ? {
          previousNumberOfCards: existingLoop.numberOfCards,
          newNumberOfCards: input.numberOfCards,
        } : {}),
        ...(input.wipLimit !== undefined ? {
          previousWipLimit: existingLoop.wipLimit,
          newWipLimit: input.wipLimit,
        } : {}),
        ...(input.safetyStockDays !== undefined ? {
          previousSafetyStockDays: existingLoop.safetyStockDays,
          newSafetyStockDays: String(input.safetyStockDays),
        } : {}),
        ...(input.leadTimeDays !== undefined ? {
          previousLeadTimeDays: existingLoop.statedLeadTimeDays,
          newLeadTimeDays: input.leadTimeDays,
        } : {}),
      });

      // Update the loop
      await tx
        .update(kanbanLoops)
        .set(updateFields)
        .where(and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)));

      // Handle card count changes
      if (input.numberOfCards !== undefined && input.numberOfCards !== existingLoop.numberOfCards) {
        if (input.numberOfCards > existingLoop.numberOfCards) {
          const newCards = Array.from(
            { length: input.numberOfCards - existingLoop.numberOfCards },
            (_, i) => ({
              tenantId,
              loopId,
              cardNumber: existingLoop.numberOfCards + i + 1,
              currentStage: 'created' as const,
              currentStageEnteredAt: new Date(),
            }),
          );
          await tx.insert(kanbanCards).values(newCards);
        }
        if (input.numberOfCards < existingLoop.numberOfCards) {
          const { gt } = await import('drizzle-orm');
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

      // Audit: relowisa parameters changed
      const previousState: Record<string, unknown> = {};
      const newState: Record<string, unknown> = {};
      if (input.reorderPoint !== undefined) {
        previousState.reorderPoint = existingLoop.minQuantity;
        newState.reorderPoint = input.reorderPoint;
      }
      if (input.lotSize !== undefined) {
        previousState.lotSize = existingLoop.orderQuantity;
        newState.lotSize = input.lotSize;
      }
      if (input.wipLimit !== undefined) {
        previousState.wipLimit = existingLoop.wipLimit;
        newState.wipLimit = input.wipLimit;
      }
      if (input.safetyStockDays !== undefined) {
        previousState.safetyStockDays = Number(existingLoop.safetyStockDays) || 0;
        newState.safetyStockDays = input.safetyStockDays;
      }
      if (input.leadTimeDays !== undefined) {
        previousState.leadTimeDays = existingLoop.statedLeadTimeDays;
        newState.leadTimeDays = input.leadTimeDays;
      }
      if (input.numberOfCards !== undefined) {
        previousState.numberOfCards = existingLoop.numberOfCards;
        newState.numberOfCards = input.numberOfCards;
      }

      await writeAuditEntry(tx, {
        tenantId,
        userId: req.user!.sub,
        action: 'loop.relowisa_updated',
        entityType: 'kanban_loop',
        entityId: loopId,
        previousState,
        newState,
        metadata: { reason: input.reason },
      });
    });

    // Re-fetch the updated loop with cards for metrics
    const updatedLoop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
    });
    if (!updatedLoop) throw new AppError(404, 'Kanban loop not found');

    const cards = await db
      .select({ currentStage: kanbanCards.currentStage })
      .from(kanbanCards)
      .where(
        and(
          eq(kanbanCards.loopId, loopId),
          eq(kanbanCards.tenantId, tenantId),
          eq(kanbanCards.isActive, true),
        ),
      );

    const metrics = computeReloWisaMetrics(updatedLoop, cards);

    // Publish parameter change event (best-effort)
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'loop.parameters_changed',
        tenantId,
        loopId,
        changeType: 'manual',
        reason: input.reason,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-critical — log and continue
    }

    res.json({
      loopId,
      metrics,
      updatedAt: updatedLoop.updatedAt,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── POST /:loopId/relowisa/apply — Apply a ReLoWiSa recommendation ──
const applyRecommendationSchema = z.object({
  recommendationId: z.string().uuid(),
  action: z.enum(['approve', 'reject']),
  reason: z.string().optional(),
});

reloWisaRouter.post('/:loopId/relowisa/apply', async (req: AuthRequest, res, next) => {
  try {
    const input = applyRecommendationSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const loopId = req.params.loopId as string;

    // Verify loop exists
    const loop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
    });
    if (!loop) throw new AppError(404, 'Kanban loop not found');

    // Fetch the recommendation
    const [recommendation] = await db
      .select()
      .from(reloWisaRecommendations)
      .where(
        and(
          eq(reloWisaRecommendations.id, input.recommendationId),
          eq(reloWisaRecommendations.loopId, loopId),
          eq(reloWisaRecommendations.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!recommendation) throw new AppError(404, 'Recommendation not found');
    if (recommendation.status !== 'pending') {
      throw new AppError(400, `Recommendation has already been ${recommendation.status}`);
    }

    if (input.action === 'reject') {
      // Mark as rejected
      await db
        .update(reloWisaRecommendations)
        .set({
          status: 'rejected',
          reviewedByUserId: req.user!.sub,
          reviewedAt: new Date(),
        })
        .where(eq(reloWisaRecommendations.id, input.recommendationId));

      await writeAuditEntry(db, {
        tenantId,
        userId: req.user!.sub,
        action: 'loop.relowisa_rejected',
        entityType: 'kanban_loop',
        entityId: loopId,
        metadata: {
          recommendationId: input.recommendationId,
          reason: input.reason ?? 'Rejected by user',
        },
      });

      res.json({ status: 'rejected', recommendationId: input.recommendationId });
      return;
    }

    // Approve: apply recommended values to the loop
    await db.transaction(async (tx) => {
      const updateFields: Record<string, unknown> = { updatedAt: new Date() };

      if (recommendation.recommendedMinQuantity != null) {
        updateFields.minQuantity = recommendation.recommendedMinQuantity;
      }
      if (recommendation.recommendedOrderQuantity != null) {
        updateFields.orderQuantity = recommendation.recommendedOrderQuantity;
      }
      if (recommendation.recommendedNumberOfCards != null) {
        updateFields.numberOfCards = recommendation.recommendedNumberOfCards;
      }
      if (recommendation.recommendedWipLimit != null) {
        updateFields.wipLimit = recommendation.recommendedWipLimit;
      }

      await tx.insert(kanbanParameterHistory).values({
        tenantId,
        loopId,
        changeType: 'relowisa_approved',
        reason: input.reason ?? `Applied recommendation ${input.recommendationId}`,
        changedByUserId: req.user!.sub,
        ...(recommendation.recommendedMinQuantity != null ? {
          previousMinQuantity: loop.minQuantity,
          newMinQuantity: recommendation.recommendedMinQuantity,
        } : {}),
        ...(recommendation.recommendedOrderQuantity != null ? {
          previousOrderQuantity: loop.orderQuantity,
          newOrderQuantity: recommendation.recommendedOrderQuantity,
        } : {}),
        ...(recommendation.recommendedNumberOfCards != null ? {
          previousNumberOfCards: loop.numberOfCards,
          newNumberOfCards: recommendation.recommendedNumberOfCards,
        } : {}),
        ...(recommendation.recommendedWipLimit != null ? {
          previousWipLimit: loop.wipLimit,
          newWipLimit: recommendation.recommendedWipLimit,
        } : {}),
      });

      await tx
        .update(kanbanLoops)
        .set(updateFields)
        .where(and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)));

      // Handle card count changes from recommendation
      if (
        recommendation.recommendedNumberOfCards != null &&
        recommendation.recommendedNumberOfCards !== loop.numberOfCards
      ) {
        if (recommendation.recommendedNumberOfCards > loop.numberOfCards) {
          const newCards = Array.from(
            { length: recommendation.recommendedNumberOfCards - loop.numberOfCards },
            (_, i) => ({
              tenantId,
              loopId,
              cardNumber: loop.numberOfCards + i + 1,
              currentStage: 'created' as const,
              currentStageEnteredAt: new Date(),
            }),
          );
          await tx.insert(kanbanCards).values(newCards);
        }
        if (recommendation.recommendedNumberOfCards < loop.numberOfCards) {
          const { gt } = await import('drizzle-orm');
          await tx
            .update(kanbanCards)
            .set({ isActive: false, updatedAt: new Date() })
            .where(
              and(
                eq(kanbanCards.loopId, loopId),
                eq(kanbanCards.tenantId, tenantId),
                gt(kanbanCards.cardNumber, recommendation.recommendedNumberOfCards),
              ),
            );
        }
      }

      // Mark recommendation as approved
      await tx
        .update(reloWisaRecommendations)
        .set({
          status: 'approved',
          reviewedByUserId: req.user!.sub,
          reviewedAt: new Date(),
        })
        .where(eq(reloWisaRecommendations.id, input.recommendationId));

      // Audit: recommendation applied
      await writeAuditEntry(tx, {
        tenantId,
        userId: req.user!.sub,
        action: 'loop.relowisa_applied',
        entityType: 'kanban_loop',
        entityId: loopId,
        previousState: {
          reorderPoint: loop.minQuantity,
          lotSize: loop.orderQuantity,
          numberOfCards: loop.numberOfCards,
          wipLimit: loop.wipLimit,
        },
        newState: {
          reorderPoint: recommendation.recommendedMinQuantity ?? loop.minQuantity,
          lotSize: recommendation.recommendedOrderQuantity ?? loop.orderQuantity,
          numberOfCards: recommendation.recommendedNumberOfCards ?? loop.numberOfCards,
          wipLimit: recommendation.recommendedWipLimit ?? loop.wipLimit,
        },
        metadata: {
          recommendationId: input.recommendationId,
          confidenceScore: recommendation.confidenceScore,
          dataPointsUsed: recommendation.dataPointsUsed,
          reason: input.reason,
        },
      });
    });

    // Publish parameter change event (best-effort)
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'loop.parameters_changed',
        tenantId,
        loopId,
        changeType: 'relowisa_approved',
        reason: input.reason ?? `Applied recommendation ${input.recommendationId}`,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-critical
    }

    // Re-fetch updated loop for response
    const updatedLoop = await db.query.kanbanLoops.findFirst({
      where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
    });
    if (!updatedLoop) throw new AppError(404, 'Kanban loop not found');

    const cards = await db
      .select({ currentStage: kanbanCards.currentStage })
      .from(kanbanCards)
      .where(
        and(
          eq(kanbanCards.loopId, loopId),
          eq(kanbanCards.tenantId, tenantId),
          eq(kanbanCards.isActive, true),
        ),
      );

    const metrics = computeReloWisaMetrics(updatedLoop, cards);

    res.json({
      status: 'approved',
      recommendationId: input.recommendationId,
      loopId,
      metrics,
      updatedAt: updatedLoop.updatedAt,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});
