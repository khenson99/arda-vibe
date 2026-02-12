import { eq, and, sql, inArray } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import { AppError } from '../middleware/error-handler.js';
import type { CardStage, CardMode } from '@arda/shared-types';

const {
  kanbanCards,
  kanbanLoops,
  kanbanParameterHistory,
} = schema;

// ═══════════════════════════════════════════════════════════════════════
// QUANTITY ACCOUNTING SERVICE
// ═══════════════════════════════════════════════════════════════════════
//
// Manages the relationship between loop parameters (orderQuantity,
// numberOfCards) and the individual card quantities. Key concepts:
//
// - cardQuantity = loop.orderQuantity (synced on loop parameter change)
// - In multi-card mode, total in-flight = sum of cardQuantity for cards
//   in counting stages (triggered, ordered, in_transit)
// - When switching modes, cards are created/retired to match new count
// - All changes are audited in kanban_parameter_history
//
// ═══════════════════════════════════════════════════════════════════════

// Counting stages: cards in these stages represent in-flight replenishment
const COUNTING_STAGES: CardStage[] = ['triggered', 'ordered', 'in_transit'];

// ─── Calculate Loop Inferred Quantity ────────────────────────────────
// Returns the total quantity that is currently in-flight (requested but
// not yet restocked) across all active cards in the loop.
export async function calculateLoopInferredQuantity(loopId: string, tenantId: string) {
  const loop = await db.query.kanbanLoops.findFirst({
    where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
  });

  if (!loop) {
    throw new AppError(404, 'Loop not found', 'LOOP_NOT_FOUND');
  }

  const cards = await db.query.kanbanCards.findMany({
    where: and(
      eq(kanbanCards.loopId, loopId),
      eq(kanbanCards.tenantId, tenantId),
      eq(kanbanCards.isActive, true),
    ),
  });

  const cardBreakdown = cards.map((card) => ({
    cardId: card.id,
    cardNumber: card.cardNumber,
    stage: card.currentStage,
    cardQuantity: loop.orderQuantity,
    isCounting: COUNTING_STAGES.includes(card.currentStage as CardStage),
  }));

  const totalInferredQuantity = cardBreakdown
    .filter((c) => c.isCounting)
    .reduce((sum, c) => sum + c.cardQuantity, 0);

  return {
    loopId,
    orderQuantityPerCard: loop.orderQuantity,
    totalCards: cards.length,
    countingStages: COUNTING_STAGES,
    totalInferredQuantity,
    cardBreakdown,
  };
}

// ─── Recalculate Loop Quantity ────────────────────────────────────────
// Force a full recalculation of the loop's in-flight quantities.
// Useful after manual corrections or data migrations.
export async function recalculateLoopQuantity(loopId: string, tenantId: string) {
  const result = await calculateLoopInferredQuantity(loopId, tenantId);

  return {
    loopId,
    recalculatedAt: new Date().toISOString(),
    totalInferredQuantity: result.totalInferredQuantity,
    totalCards: result.totalCards,
    cardBreakdown: result.cardBreakdown,
  };
}

// ─── Initialize Card Quantities ──────────────────────────────────────
// Called when a loop is first created or when numberOfCards changes.
// Creates the appropriate number of cards for the loop.
export async function initializeCardQuantities(
  loopId: string,
  tenantId: string,
  numberOfCards: number,
) {
  const loop = await db.query.kanbanLoops.findFirst({
    where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
  });

  if (!loop) {
    throw new AppError(404, 'Loop not found', 'LOOP_NOT_FOUND');
  }

  // Check for existing active cards
  const existingCards = await db.query.kanbanCards.findMany({
    where: and(
      eq(kanbanCards.loopId, loopId),
      eq(kanbanCards.tenantId, tenantId),
      eq(kanbanCards.isActive, true),
    ),
  });

  if (existingCards.length > 0) {
    throw new AppError(
      400,
      `Loop already has ${existingCards.length} active cards. Use switchCardMode to change.`,
      'CARDS_ALREADY_EXIST'
    );
  }

  // Create cards
  const cardValues = Array.from({ length: numberOfCards }, (_, i) => ({
    tenantId,
    loopId,
    cardNumber: i + 1,
    currentStage: 'created' as const,
    currentStageEnteredAt: new Date(),
    isActive: true,
  }));

  const cards = await db
    .insert(kanbanCards)
    .values(cardValues)
    .returning();

  return {
    loopId,
    cardsCreated: cards.length,
    cards: cards.map((c) => ({
      id: c.id,
      cardNumber: c.cardNumber,
      currentStage: c.currentStage,
    })),
  };
}

// ─── Switch Card Mode ────────────────────────────────────────────────
// Transitions a loop between single-card and multi-card modes.
// When switching to multi, additional cards are created in 'created' stage.
// When switching to single, extra cards are deactivated (only if in 'created' stage).
export async function switchCardMode(
  loopId: string,
  tenantId: string,
  input: {
    newMode: CardMode;
    newNumberOfCards?: number;
    reason: string;
    userId?: string;
  }
) {
  const { newMode, newNumberOfCards, reason, userId } = input;

  const loop = await db.query.kanbanLoops.findFirst({
    where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
  });

  if (!loop) {
    throw new AppError(404, 'Loop not found', 'LOOP_NOT_FOUND');
  }

  const currentCards = await db.query.kanbanCards.findMany({
    where: and(
      eq(kanbanCards.loopId, loopId),
      eq(kanbanCards.tenantId, tenantId),
      eq(kanbanCards.isActive, true),
    ),
    orderBy: kanbanCards.cardNumber,
  });

  const previousMode = loop.cardMode;
  const previousNumberOfCards = loop.numberOfCards;
  const targetNumberOfCards = newMode === 'single' ? 1 : (newNumberOfCards ?? loop.numberOfCards);

  if (targetNumberOfCards < 1) {
    throw new AppError(400, 'Number of cards must be at least 1', 'INVALID_CARD_COUNT');
  }

  const result = await db.transaction(async (tx) => {
    // Update loop parameters
    await tx
      .update(kanbanLoops)
      .set({
        cardMode: newMode,
        numberOfCards: targetNumberOfCards,
        updatedAt: new Date(),
      })
      .where(eq(kanbanLoops.id, loopId));

    // Record parameter change
    await tx.insert(kanbanParameterHistory).values({
      tenantId,
      loopId,
      changeType: 'manual',
      previousNumberOfCards: previousNumberOfCards,
      newNumberOfCards: targetNumberOfCards,
      reason,
      changedByUserId: userId,
    });

    let cardsCreated = 0;
    let cardsDeactivated = 0;

    if (targetNumberOfCards > currentCards.length) {
      // Need more cards — create them
      const toCreate = targetNumberOfCards - currentCards.length;
      const maxCardNumber = currentCards.reduce((max, c) => Math.max(max, c.cardNumber), 0);

      const newCardValues = Array.from({ length: toCreate }, (_, i) => ({
        tenantId,
        loopId,
        cardNumber: maxCardNumber + i + 1,
        currentStage: 'created' as const,
        currentStageEnteredAt: new Date(),
        isActive: true,
      }));

      await tx.insert(kanbanCards).values(newCardValues);
      cardsCreated = toCreate;
    } else if (targetNumberOfCards < currentCards.length) {
      // Need fewer cards — deactivate extras (only if in 'created' stage)
      const toRemove = currentCards.length - targetNumberOfCards;
      const removableCandidates = currentCards
        .filter((c) => c.currentStage === 'created')
        .slice(-toRemove); // Remove from the end

      if (removableCandidates.length < toRemove) {
        throw new AppError(
          400,
          `Cannot reduce to ${targetNumberOfCards} cards: ${toRemove - removableCandidates.length} cards are in-flight and cannot be deactivated`,
          'CARDS_IN_FLIGHT'
        );
      }

      const idsToDeactivate = removableCandidates.map((c) => c.id);
      await tx
        .update(kanbanCards)
        .set({ isActive: false, updatedAt: new Date() })
        .where(inArray(kanbanCards.id, idsToDeactivate));
      cardsDeactivated = idsToDeactivate.length;
    }

    return { cardsCreated, cardsDeactivated };
  });

  return {
    loopId,
    previousMode,
    newMode,
    previousNumberOfCards,
    newNumberOfCards: targetNumberOfCards,
    cardsCreated: result.cardsCreated,
    cardsDeactivated: result.cardsDeactivated,
  };
}

// ─── Get Loop Card Summary ───────────────────────────────────────────
// Returns a complete overview of all cards in a loop, including stage
// distribution and quantity accounting. Used by the queue UI.
export async function getLoopCardSummary(loopId: string, tenantId: string) {
  const loop = await db.query.kanbanLoops.findFirst({
    where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
  });

  if (!loop) {
    throw new AppError(404, 'Loop not found', 'LOOP_NOT_FOUND');
  }

  const cards = await db.query.kanbanCards.findMany({
    where: and(
      eq(kanbanCards.loopId, loopId),
      eq(kanbanCards.tenantId, tenantId),
      eq(kanbanCards.isActive, true),
    ),
    orderBy: kanbanCards.cardNumber,
  });

  // Stage distribution
  const stageCounts: Record<string, number> = {};
  for (const card of cards) {
    stageCounts[card.currentStage] = (stageCounts[card.currentStage] || 0) + 1;
  }
  const byStage = { ...stageCounts };

  // Counting metrics
  const triggeredCount = cards.filter((c) => c.currentStage === 'triggered').length;
  const inFlightCards = cards.filter((c) => COUNTING_STAGES.includes(c.currentStage as CardStage));
  const inFlightCount = inFlightCards.length;
  const inFlightQuantity = inFlightCount * loop.orderQuantity;
  const totalInferredQuantity = inFlightQuantity;

  return {
    loopId,
    cardMode: loop.cardMode,
    totalCards: cards.length,
    numberOfCards: loop.numberOfCards,
    stageCounts,
    byStage,
    triggeredCount,
    inFlightCount,
    inFlightQuantity,
    orderQuantityPerCard: loop.orderQuantity,
    totalInferredQuantity,
    cards: cards.map((c) => ({
      id: c.id,
      cardNumber: c.cardNumber,
      currentStage: c.currentStage,
      cardQuantity: loop.orderQuantity,
      quantityFulfilled: 0, // placeholder for future partial fulfillment
      completedCycles: c.completedCycles,
    })),
  };
}

// ─── Get Triggered Cards for Consolidation ───────────────────────────
// Returns all triggered cards in a loop, grouped for PO/TO consolidation.
// Used by the order queue to show what needs ordering.
export async function getTriggeredCardsForConsolidation(loopId: string, tenantId: string) {
  const loop = await db.query.kanbanLoops.findFirst({
    where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
  });

  if (!loop) {
    throw new AppError(404, 'Loop not found', 'LOOP_NOT_FOUND');
  }

  const triggeredCards = await db.query.kanbanCards.findMany({
    where: and(
      eq(kanbanCards.loopId, loopId),
      eq(kanbanCards.tenantId, tenantId),
      eq(kanbanCards.isActive, true),
      eq(kanbanCards.currentStage, 'triggered'),
    ),
    orderBy: kanbanCards.cardNumber,
  });

  const consolidatedQuantity = triggeredCards.length * loop.orderQuantity;

  return {
    loopId,
    loopType: loop.loopType,
    partId: loop.partId,
    facilityId: loop.facilityId,
    supplierId: loop.primarySupplierId,
    sourceFacilityId: loop.sourceFacilityId,
    cards: triggeredCards.map((c) => ({
      cardId: c.id,
      cardNumber: c.cardNumber,
      cardQuantity: loop.orderQuantity,
    })),
    consolidatedQuantity,
  };
}

// ─── Update Loop Order Quantity ──────────────────────────────────────
// Changes the orderQuantity for a loop and records the change in
// parameter history. This propagates to all cards via the loop reference.
export async function updateLoopOrderQuantity(
  loopId: string,
  tenantId: string,
  input: {
    newOrderQuantity: number;
    reason: string;
    userId?: string;
  }
) {
  const { newOrderQuantity, reason, userId } = input;

  const loop = await db.query.kanbanLoops.findFirst({
    where: and(eq(kanbanLoops.id, loopId), eq(kanbanLoops.tenantId, tenantId)),
  });

  if (!loop) {
    throw new AppError(404, 'Loop not found', 'LOOP_NOT_FOUND');
  }

  const previousOrderQuantity = loop.orderQuantity;

  await db.transaction(async (tx) => {
    // Update loop
    await tx
      .update(kanbanLoops)
      .set({
        orderQuantity: newOrderQuantity,
        updatedAt: new Date(),
      })
      .where(eq(kanbanLoops.id, loopId));

    // Record parameter change
    await tx.insert(kanbanParameterHistory).values({
      tenantId,
      loopId,
      changeType: 'manual',
      previousOrderQuantity,
      newOrderQuantity,
      reason,
      changedByUserId: userId,
    });
  });

  return {
    loopId,
    previousOrderQuantity,
    newOrderQuantity,
    reason,
    updatedAt: new Date().toISOString(),
  };
}
