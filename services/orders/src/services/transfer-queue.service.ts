/**
 * Transfer Queue Service
 *
 * Aggregates actionable transfer needs from three sources:
 *   1. Draft TOs (status = draft)
 *   2. Kanban-triggered transfer requests (cards in 'triggered' stage)
 *   3. Inventory rows below reorder point
 *
 * Each queue item includes:
 *   - Priority score (computed from days-below-reorder-point, Kanban urgency, expedite flags)
 *   - Recommended source facilities (inline)
 */

import { db, schema } from '@arda/db';
import { eq, and, lt, sql, inArray, or } from 'drizzle-orm';
import { createLogger } from '@arda/config';
import { recommendSources, type RecommendSourcesInput } from './source-recommendation.service.js';
import type { SourceRecommendation } from '@arda/shared-types';

const log = createLogger('transfer-queue');

const {
  transferOrders,
  transferOrderLines,
  inventoryLedger,
  facilities,
  kanbanCards,
  kanbanLoops,
} = schema;

// ─── Types ────────────────────────────────────────────────────────────

export interface TransferQueueFilters {
  destinationFacilityId?: string;
  sourceFacilityId?: string;
  status?: string;
  partId?: string;
  minPriorityScore?: number;
  maxPriorityScore?: number;
}

export interface TransferQueueItem {
  // Core identification
  id: string;
  type: 'draft_to' | 'kanban_trigger' | 'below_reorder';

  // Transfer details
  transferOrderId?: string;
  toNumber?: string;
  kanbanCardId?: string;
  partId: string;
  partNumber?: string;
  partName?: string;

  // Facilities
  sourceFacilityId?: string;
  sourceFacilityName?: string;
  destinationFacilityId: string;
  destinationFacilityName: string;

  // Quantities
  quantityRequested: number;
  availableQty?: number;

  // Priority
  priorityScore: number;
  daysBelowReorder?: number;
  isExpedited: boolean;

  // Status
  status: string;

  // Timestamps
  createdAt: string;
  requestedDate?: string;

  // Inline recommendations
  recommendedSources: SourceRecommendation[];
}

export interface GetTransferQueueInput {
  tenantId: string;
  filters?: TransferQueueFilters;
  limit?: number;
  offset?: number;
}

// ─── Priority Scoring Weights ────────────────────────────────────────

const WEIGHT_DAYS_BELOW = 0.5;
const WEIGHT_KANBAN_URGENCY = 0.3;
const WEIGHT_EXPEDITE = 0.2;

/**
 * Compute priority score for a queue item.
 * - daysBelowReorder: normalized (0-1) based on how long below reorder
 * - kanbanUrgency: 1 if Kanban-triggered, 0 otherwise
 * - expedite: 1 if expedited/requested status, 0 otherwise
 *
 * Returns score in range 0-100
 */
function computePriorityScore(input: {
  daysBelowReorder: number;
  isKanbanTriggered: boolean;
  isExpedited: boolean;
}): number {
  // Normalize days below reorder: assume max 30 days for scale
  const maxDays = 30;
  const daysScore = Math.min(input.daysBelowReorder / maxDays, 1);

  const kanbanScore = input.isKanbanTriggered ? 1 : 0;
  const expediteScore = input.isExpedited ? 1 : 0;

  const raw =
    WEIGHT_DAYS_BELOW * daysScore +
    WEIGHT_KANBAN_URGENCY * kanbanScore +
    WEIGHT_EXPEDITE * expediteScore;

  return Math.round(raw * 100 * 100) / 100; // 0-100 scale
}

// ─── Main Function ────────────────────────────────────────────────────

/**
 * Get transfer queue aggregating draft TOs, Kanban triggers, and below-reorder inventory.
 */
export async function getTransferQueue(
  input: GetTransferQueueInput
): Promise<{ items: TransferQueueItem[]; total: number }> {
  const { tenantId, filters = {}, limit = 20, offset = 0 } = input;

  const items: TransferQueueItem[] = [];

  // ─── 1. Draft Transfer Orders ────────────────────────────────────────

  const draftConditions = [
    eq(transferOrders.tenantId, tenantId),
    eq(transferOrders.status, 'draft'),
  ];

  if (filters.destinationFacilityId) {
    draftConditions.push(eq(transferOrders.destinationFacilityId, filters.destinationFacilityId));
  }
  if (filters.sourceFacilityId) {
    draftConditions.push(eq(transferOrders.sourceFacilityId, filters.sourceFacilityId));
  }
  if (filters.status && filters.status !== 'draft') {
    // Skip draft TOs if filtering for a different status
    draftConditions.push(sql`false`);
  }

  const draftTOs = await db
    .select({
      id: transferOrders.id,
      toNumber: transferOrders.toNumber,
      sourceFacilityId: transferOrders.sourceFacilityId,
      destinationFacilityId: transferOrders.destinationFacilityId,
      status: transferOrders.status,
      createdAt: transferOrders.createdAt,
      requestedDate: transferOrders.requestedDate,
      sourceFacility: facilities,
    })
    .from(transferOrders)
    .leftJoin(
      facilities,
      and(
        eq(transferOrders.sourceFacilityId, facilities.id),
        eq(facilities.tenantId, tenantId)
      )
    )
    .where(and(...draftConditions))
    .limit(50); // Pre-filter, will sort and slice later

  for (const draftTO of draftTOs) {
    // Get destination facility
    const [destFacility] = await db
      .select({ name: facilities.name })
      .from(facilities)
      .where(
        and(
          eq(facilities.id, draftTO.destinationFacilityId),
          eq(facilities.tenantId, tenantId)
        )
      )
      .limit(1);

    // Get lines to compute total quantity and get partId
    const lines = await db
      .select({
        partId: transferOrderLines.partId,
        quantityRequested: transferOrderLines.quantityRequested,
      })
      .from(transferOrderLines)
      .where(
        and(
          eq(transferOrderLines.transferOrderId, draftTO.id),
          eq(transferOrderLines.tenantId, tenantId)
        )
      );

    if (lines.length === 0) continue;

    const totalQty = lines.reduce((sum, line) => sum + line.quantityRequested, 0);
    const firstPartId = lines[0].partId;

    // Apply partId filter
    if (filters.partId && !lines.some(line => line.partId === filters.partId)) {
      continue;
    }

    // Compute priority score (drafts have low urgency unless expedited)
    const priorityScore = computePriorityScore({
      daysBelowReorder: 0,
      isKanbanTriggered: false,
      isExpedited: draftTO.status === 'requested',
    });

    // Apply priority filter
    if (filters.minPriorityScore !== undefined && priorityScore < filters.minPriorityScore) {
      continue;
    }
    if (filters.maxPriorityScore !== undefined && priorityScore > filters.maxPriorityScore) {
      continue;
    }

    // Get recommended sources (for first part as proxy)
    let recommendedSources: SourceRecommendation[] = [];
    try {
      recommendedSources = await recommendSources({
        tenantId,
        destinationFacilityId: draftTO.destinationFacilityId,
        partId: firstPartId,
        limit: 3,
      });
    } catch (err) {
      log.warn({ error: err, toId: draftTO.id }, 'Failed to get source recommendations for draft TO');
    }

    items.push({
      id: draftTO.id,
      type: 'draft_to',
      transferOrderId: draftTO.id,
      toNumber: draftTO.toNumber,
      partId: firstPartId,
      sourceFacilityId: draftTO.sourceFacilityId,
      sourceFacilityName: draftTO.sourceFacility?.name ?? 'Unknown',
      destinationFacilityId: draftTO.destinationFacilityId,
      destinationFacilityName: destFacility?.name ?? 'Unknown',
      quantityRequested: totalQty,
      priorityScore,
      isExpedited: draftTO.status === 'requested',
      status: draftTO.status,
      createdAt: draftTO.createdAt.toISOString(),
      requestedDate: draftTO.requestedDate?.toISOString(),
      recommendedSources,
    });
  }

  // ─── 2. Kanban-Triggered Transfer Requests ────────────────────────────

  const kanbanConditions = [
    eq(kanbanCards.tenantId, tenantId),
    eq(kanbanCards.currentStage, 'triggered'),
    eq(kanbanCards.isActive, true),
    eq(kanbanLoops.loopType, 'transfer'),
  ];

  if (filters.destinationFacilityId) {
    kanbanConditions.push(eq(kanbanLoops.facilityId, filters.destinationFacilityId));
  }
  if (filters.sourceFacilityId) {
    kanbanConditions.push(eq(kanbanLoops.sourceFacilityId, filters.sourceFacilityId));
  }
  if (filters.status && filters.status !== 'triggered') {
    kanbanConditions.push(sql`false`);
  }

  const kanbanCards_triggered = await db
    .select({
      cardId: kanbanCards.id,
      loopId: kanbanCards.loopId,
      currentStageEnteredAt: kanbanCards.currentStageEnteredAt,
      loop: kanbanLoops,
      destFacility: facilities,
    })
    .from(kanbanCards)
    .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
    .leftJoin(
      facilities,
      and(
        eq(kanbanLoops.facilityId, facilities.id),
        eq(facilities.tenantId, tenantId)
      )
    )
    .where(and(...kanbanConditions))
    .limit(50);

  for (const card of kanbanCards_triggered) {
    // Apply partId filter
    if (filters.partId && card.loop.partId !== filters.partId) {
      continue;
    }

    // Get source facility name
    let sourceFacilityName = 'Unknown';
    if (card.loop.sourceFacilityId) {
      const [sourceFac] = await db
        .select({ name: facilities.name })
        .from(facilities)
        .where(
          and(
            eq(facilities.id, card.loop.sourceFacilityId),
            eq(facilities.tenantId, tenantId)
          )
        )
        .limit(1);

      if (sourceFac) sourceFacilityName = sourceFac.name;
    }

    // Compute days since triggered (proxy for urgency)
    const daysSinceTrigger = Math.floor(
      (Date.now() - card.currentStageEnteredAt.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Compute priority score
    const priorityScore = computePriorityScore({
      daysBelowReorder: daysSinceTrigger,
      isKanbanTriggered: true,
      isExpedited: false,
    });

    // Apply priority filter
    if (filters.minPriorityScore !== undefined && priorityScore < filters.minPriorityScore) {
      continue;
    }
    if (filters.maxPriorityScore !== undefined && priorityScore > filters.maxPriorityScore) {
      continue;
    }

    // Get recommended sources
    let recommendedSources: SourceRecommendation[] = [];
    try {
      recommendedSources = await recommendSources({
        tenantId,
        destinationFacilityId: card.loop.facilityId,
        partId: card.loop.partId,
        minQty: card.loop.orderQuantity,
        limit: 3,
      });
    } catch (err) {
      log.warn({ error: err, cardId: card.cardId }, 'Failed to get source recommendations for Kanban card');
    }

    items.push({
      id: card.cardId,
      type: 'kanban_trigger',
      kanbanCardId: card.cardId,
      partId: card.loop.partId,
      sourceFacilityId: card.loop.sourceFacilityId ?? undefined,
      sourceFacilityName,
      destinationFacilityId: card.loop.facilityId,
      destinationFacilityName: card.destFacility?.name ?? 'Unknown',
      quantityRequested: card.loop.orderQuantity,
      priorityScore,
      daysBelowReorder: daysSinceTrigger,
      isExpedited: false,
      status: 'triggered',
      createdAt: card.currentStageEnteredAt.toISOString(),
      recommendedSources,
    });
  }

  // ─── 3. Inventory Below Reorder Point ─────────────────────────────────

  const belowReorderConditions = [
    eq(inventoryLedger.tenantId, tenantId),
    sql`${inventoryLedger.qtyOnHand} < ${inventoryLedger.reorderPoint}`,
    sql`${inventoryLedger.reorderPoint} > 0`, // Only where reorder point is set
  ];

  if (filters.destinationFacilityId) {
    belowReorderConditions.push(eq(inventoryLedger.facilityId, filters.destinationFacilityId));
  }
  if (filters.partId) {
    belowReorderConditions.push(eq(inventoryLedger.partId, filters.partId));
  }
  if (filters.status && filters.status !== 'below_reorder') {
    belowReorderConditions.push(sql`false`);
  }

  const belowReorderRows = await db
    .select({
      id: inventoryLedger.id,
      partId: inventoryLedger.partId,
      facilityId: inventoryLedger.facilityId,
      qtyOnHand: inventoryLedger.qtyOnHand,
      qtyReserved: inventoryLedger.qtyReserved,
      reorderPoint: inventoryLedger.reorderPoint,
      reorderQty: inventoryLedger.reorderQty,
      updatedAt: inventoryLedger.updatedAt,
      facility: facilities,
    })
    .from(inventoryLedger)
    .leftJoin(
      facilities,
      and(
        eq(inventoryLedger.facilityId, facilities.id),
        eq(facilities.tenantId, tenantId)
      )
    )
    .where(and(...belowReorderConditions))
    .limit(50);

  for (const row of belowReorderRows) {
    const available = row.qtyOnHand - row.qtyReserved;
    const deficit = row.reorderPoint - row.qtyOnHand;

    // Estimate days below reorder (assume updated daily, rough heuristic)
    const daysSinceUpdate = Math.floor(
      (Date.now() - row.updatedAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    const daysBelowReorder = Math.max(daysSinceUpdate, 1);

    // Compute priority score
    const priorityScore = computePriorityScore({
      daysBelowReorder,
      isKanbanTriggered: false,
      isExpedited: false,
    });

    // Apply priority filter
    if (filters.minPriorityScore !== undefined && priorityScore < filters.minPriorityScore) {
      continue;
    }
    if (filters.maxPriorityScore !== undefined && priorityScore > filters.maxPriorityScore) {
      continue;
    }

    // Get recommended sources
    let recommendedSources: SourceRecommendation[] = [];
    try {
      recommendedSources = await recommendSources({
        tenantId,
        destinationFacilityId: row.facilityId,
        partId: row.partId,
        minQty: row.reorderQty || deficit,
        limit: 3,
      });
    } catch (err) {
      log.warn({ error: err, ledgerId: row.id }, 'Failed to get source recommendations for below-reorder inventory');
    }

    items.push({
      id: row.id,
      type: 'below_reorder',
      partId: row.partId,
      destinationFacilityId: row.facilityId,
      destinationFacilityName: row.facility?.name ?? 'Unknown',
      quantityRequested: row.reorderQty || deficit,
      availableQty: available,
      priorityScore,
      daysBelowReorder,
      isExpedited: false,
      status: 'below_reorder',
      createdAt: row.updatedAt.toISOString(),
      recommendedSources,
    });
  }

  // ─── 4. Sort by Priority (descending) + Secondary Sort ────────────────

  items.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    // Secondary sort by created date (oldest first)
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const total = items.length;
  const paginatedItems = items.slice(offset, offset + limit);

  return { items: paginatedItems, total };
}
