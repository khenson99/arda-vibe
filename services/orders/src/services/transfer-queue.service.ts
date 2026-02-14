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
  /** Number of distinct parts/lines on this queue item (> 1 for multi-line TOs). */
  lineCount?: number;

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

// ─── Batch Source Recommendations ─────────────────────────────────────

/**
 * Batch-load source recommendations for a list of (destinationFacilityId, partId)
 * pairs, returning a Map keyed by "destFacilityId::partId".
 */
async function batchRecommendSources(
  tenantId: string,
  requests: Array<{ destinationFacilityId: string; partId: string; minQty?: number }>,
  limit = 3,
): Promise<Map<string, SourceRecommendation[]>> {
  const results = new Map<string, SourceRecommendation[]>();
  if (requests.length === 0) return results;

  // De-duplicate by key so we don't fetch the same pair twice
  const uniqueRequests = new Map<string, RecommendSourcesInput>();
  for (const req of requests) {
    const key = `${req.destinationFacilityId}::${req.partId}`;
    if (!uniqueRequests.has(key)) {
      uniqueRequests.set(key, {
        tenantId,
        destinationFacilityId: req.destinationFacilityId,
        partId: req.partId,
        minQty: req.minQty,
        limit,
      });
    }
  }

  // Fire all unique requests in parallel
  const entries = Array.from(uniqueRequests.entries());
  const settled = await Promise.allSettled(
    entries.map(([, input]) => recommendSources(input)),
  );

  for (let i = 0; i < entries.length; i++) {
    const [key] = entries[i];
    const result = settled[i];
    if (result.status === 'fulfilled') {
      results.set(key, result.value);
    } else {
      log.warn({ error: result.reason, key }, 'Failed to batch-load source recommendation');
      results.set(key, []);
    }
  }

  return results;
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
    or(
      eq(transferOrders.status, 'draft'),
      eq(transferOrders.status, 'requested')
    )!,
  ];

  if (filters.destinationFacilityId) {
    draftConditions.push(eq(transferOrders.destinationFacilityId, filters.destinationFacilityId));
  }
  if (filters.sourceFacilityId) {
    draftConditions.push(eq(transferOrders.sourceFacilityId, filters.sourceFacilityId));
  }
  if (filters.status && filters.status !== 'draft' && filters.status !== 'requested') {
    // Skip draft/requested TOs if filtering for a different status
    draftConditions.push(sql`false`);
  }

  const draftTOs = await db
    .select({
      id: transferOrders.id,
      toNumber: transferOrders.toNumber,
      sourceFacilityId: transferOrders.sourceFacilityId,
      destinationFacilityId: transferOrders.destinationFacilityId,
      status: transferOrders.status,
      priorityScore: transferOrders.priorityScore,
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
    .where(and(...draftConditions));
    // No per-source limit — pagination applied at final sort/slice

  // Batch-load destination facilities and TO lines to eliminate N+1 queries
  const draftTOIds = draftTOs.map(to => to.id);
  const draftDestFacilityIds = [...new Set(draftTOs.map(to => to.destinationFacilityId))];

  const [destFacilitiesMap, allTOLines] = await Promise.all([
    // Batch-load destination facilities
    draftDestFacilityIds.length > 0
      ? db
          .select({ id: facilities.id, name: facilities.name })
          .from(facilities)
          .where(
            and(
              inArray(facilities.id, draftDestFacilityIds),
              eq(facilities.tenantId, tenantId)
            )
          )
          .then(rows => new Map(rows.map(r => [r.id, r.name])))
      : Promise.resolve(new Map<string, string>()),
    // Batch-load all TO lines
    draftTOIds.length > 0
      ? db
          .select({
            transferOrderId: transferOrderLines.transferOrderId,
            partId: transferOrderLines.partId,
            quantityRequested: transferOrderLines.quantityRequested,
          })
          .from(transferOrderLines)
          .where(
            and(
              inArray(transferOrderLines.transferOrderId, draftTOIds),
              eq(transferOrderLines.tenantId, tenantId)
            )
          )
      : Promise.resolve([]),
  ]);

  // Group TO lines by transfer order ID
  const linesByTOId = new Map<string, typeof allTOLines>();
  for (const line of allTOLines) {
    const existing = linesByTOId.get(line.transferOrderId) ?? [];
    existing.push(line);
    linesByTOId.set(line.transferOrderId, existing);
  }

  // Pre-compute filtered draft TOs with their line data for batch recommendation
  const draftTOsWithLines: Array<{
    draftTO: (typeof draftTOs)[number];
    lines: typeof allTOLines;
    partIds: string[];
    firstPartId: string;
    totalQty: number;
    isExpedited: boolean;
  }> = [];

  for (const draftTO of draftTOs) {
    const lines = linesByTOId.get(draftTO.id) ?? [];
    if (lines.length === 0) continue;

    const totalQty = lines.reduce((sum, line) => sum + line.quantityRequested, 0);
    const partIds = [...new Set(lines.map(l => l.partId))];
    const firstPartId = partIds[0];

    // Apply partId filter
    if (filters.partId && !partIds.includes(filters.partId)) {
      continue;
    }

    // Fix #1: Determine expedited status from the TO's priorityScore field
    // rather than comparing status to 'requested' (which is about workflow state,
    // not urgency). A non-zero priorityScore indicates the TO was flagged as expedited.
    const isExpedited = Number(draftTO.priorityScore ?? 0) > 0;

    draftTOsWithLines.push({ draftTO, lines, partIds, firstPartId, totalQty, isExpedited });
  }

  // Fix #3: Batch-load source recommendations for all draft TOs at once
  const draftRecommendationRequests = draftTOsWithLines.map(({ draftTO, firstPartId }) => ({
    destinationFacilityId: draftTO.destinationFacilityId,
    partId: firstPartId,
  }));
  const draftRecsMap = await batchRecommendSources(tenantId, draftRecommendationRequests);

  for (const { draftTO, partIds, firstPartId, totalQty, isExpedited } of draftTOsWithLines) {
    // Compute priority score (drafts have low urgency unless expedited)
    const priorityScore = computePriorityScore({
      daysBelowReorder: 0,
      isKanbanTriggered: false,
      isExpedited,
    });

    // Apply priority filter
    if (filters.minPriorityScore !== undefined && priorityScore < filters.minPriorityScore) {
      continue;
    }
    if (filters.maxPriorityScore !== undefined && priorityScore > filters.maxPriorityScore) {
      continue;
    }

    // Look up pre-fetched recommendations
    const recKey = `${draftTO.destinationFacilityId}::${firstPartId}`;
    const recommendedSources = draftRecsMap.get(recKey) ?? [];

    items.push({
      id: draftTO.id,
      type: 'draft_to',
      transferOrderId: draftTO.id,
      toNumber: draftTO.toNumber,
      // Fix #2: Always use a valid UUID for partId; expose lineCount for multi-line TOs
      partId: firstPartId,
      lineCount: partIds.length > 1 ? partIds.length : undefined,
      sourceFacilityId: draftTO.sourceFacilityId,
      sourceFacilityName: draftTO.sourceFacility?.name ?? 'Unknown',
      destinationFacilityId: draftTO.destinationFacilityId,
      destinationFacilityName: destFacilitiesMap.get(draftTO.destinationFacilityId) ?? 'Unknown',
      quantityRequested: totalQty,
      priorityScore,
      isExpedited,
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
    .where(and(...kanbanConditions));
    // No per-source limit — pagination applied at final sort/slice

  // Batch-load source facility names for Kanban cards
  const kanbanSourceFacilityIds = [
    ...new Set(
      kanbanCards_triggered
        .map(c => c.loop.sourceFacilityId)
        .filter((id): id is string => !!id)
    )
  ];
  const kanbanSourceFacMap = kanbanSourceFacilityIds.length > 0
    ? await db
        .select({ id: facilities.id, name: facilities.name })
        .from(facilities)
        .where(
          and(
            inArray(facilities.id, kanbanSourceFacilityIds),
            eq(facilities.tenantId, tenantId)
          )
        )
        .then(rows => new Map(rows.map(r => [r.id, r.name])))
    : new Map<string, string>();

  // Pre-filter Kanban cards and batch-load recommendations
  const filteredKanbanCards = kanbanCards_triggered.filter(card => {
    if (filters.partId && card.loop.partId !== filters.partId) {
      return false;
    }
    return true;
  });

  // Fix #3: Batch-load source recommendations for all Kanban cards at once
  const kanbanRecommendationRequests = filteredKanbanCards.map(card => ({
    destinationFacilityId: card.loop.facilityId,
    partId: card.loop.partId,
    minQty: card.loop.orderQuantity,
  }));
  const kanbanRecsMap = await batchRecommendSources(tenantId, kanbanRecommendationRequests);

  for (const card of filteredKanbanCards) {
    const sourceFacilityName = card.loop.sourceFacilityId
      ? (kanbanSourceFacMap.get(card.loop.sourceFacilityId) ?? 'Unknown')
      : 'Unknown';

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

    // Look up pre-fetched recommendations
    const recKey = `${card.loop.facilityId}::${card.loop.partId}`;
    const recommendedSources = kanbanRecsMap.get(recKey) ?? [];

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
    .where(and(...belowReorderConditions));
    // No per-source limit — pagination applied at final sort/slice

  // Fix #3: Batch-load source recommendations for all below-reorder rows at once
  const belowReorderRecommendationRequests = belowReorderRows.map(row => ({
    destinationFacilityId: row.facilityId,
    partId: row.partId,
    minQty: row.reorderQty || (row.reorderPoint - row.qtyOnHand),
  }));
  const belowReorderRecsMap = await batchRecommendSources(tenantId, belowReorderRecommendationRequests);

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

    // Look up pre-fetched recommendations
    const recKey = `${row.facilityId}::${row.partId}`;
    const recommendedSources = belowReorderRecsMap.get(recKey) ?? [];

    // Fix #4: Apply sourceFacilityId filter to below_reorder items.
    // Since below_reorder rows don't have a source facility, filter by checking
    // whether the requested source facility appears in the recommended sources.
    if (filters.sourceFacilityId) {
      const matchesSource = recommendedSources.some(
        rec => rec.facilityId === filters.sourceFacilityId
      );
      if (!matchesSource) continue;
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
