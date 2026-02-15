/**
 * Transfer Queue Service
 *
 * Aggregates actionable transfer needs from three sources:
 *   1. Draft/Requested TOs (status = draft | requested)
 *   2. Kanban-triggered transfer requests (cards in 'triggered' stage)
 *   3. Inventory rows below reorder point
 *
 * Each queue item includes:
 *   - Priority score (computed from days-below-reorder-point, Kanban urgency, expedite flags)
 *   - Recommended source facilities (inline, fetched only for the paginated result set)
 */

import { db, schema } from '@arda/db';
import { eq, and, sql, inArray, or } from 'drizzle-orm';
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

export type TransferQueueStatus = 'draft' | 'requested' | 'triggered' | 'below_reorder';

export interface TransferQueueFilters {
  destinationFacilityId?: string;
  sourceFacilityId?: string;
  status?: TransferQueueStatus;
  partId?: string;
  minPriorityScore?: number;
  maxPriorityScore?: number;
}

export interface TransferQueueItem {
  id: string;
  type: 'draft_to' | 'kanban_trigger' | 'below_reorder';

  transferOrderId?: string;
  toNumber?: string;
  kanbanCardId?: string;
  partId: string;
  partNumber?: string;
  partName?: string;
  /** Number of distinct parts/lines on this queue item (> 1 for multi-line TOs). */
  lineCount?: number;

  sourceFacilityId?: string;
  sourceFacilityName?: string;
  destinationFacilityId: string;
  destinationFacilityName: string;

  quantityRequested: number;
  availableQty?: number;

  priorityScore: number;
  daysBelowReorder?: number;
  isExpedited: boolean;

  status: string;

  createdAt: string;
  requestedDate?: string;

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
 * - daysBelowReorder: normalized (0-1) based on how long below reorder (max 30 days)
 * - kanbanUrgency: 1 if Kanban-triggered, 0 otherwise
 * - expedite: 1 if expedited/requested status, 0 otherwise
 *
 * Returns score in range 0-100
 */
export function computePriorityScore(input: {
  daysBelowReorder: number;
  isKanbanTriggered: boolean;
  isExpedited: boolean;
}): number {
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

// ─── Internal candidate type (no recommendations yet) ────────────────

interface QueueCandidate {
  id: string;
  type: 'draft_to' | 'kanban_trigger' | 'below_reorder';
  transferOrderId?: string;
  toNumber?: string;
  kanbanCardId?: string;
  partId: string;
  lineCount?: number;
  sourceFacilityId?: string;
  sourceFacilityName?: string;
  destinationFacilityId: string;
  destinationFacilityName: string;
  quantityRequested: number;
  availableQty?: number;
  priorityScore: number;
  daysBelowReorder?: number;
  isExpedited: boolean;
  status: string;
  createdAt: string;
  requestedDate?: string;
  /** For below_reorder / kanban items, the minQty hint for recommendations */
  _recMinQty?: number;
}

// ─── Main Function ────────────────────────────────────────────────────

/**
 * Get transfer queue aggregating draft TOs, Kanban triggers, and below-reorder inventory.
 *
 * Performance strategy: build all candidate items first (without recommendations),
 * apply global sort + pagination, then fetch recommendations only for the paginated slice.
 */
export async function getTransferQueue(
  input: GetTransferQueueInput
): Promise<{ items: TransferQueueItem[]; total: number }> {
  const { tenantId, filters = {}, limit = 20, offset = 0 } = input;

  const candidates: QueueCandidate[] = [];

  // ─── 1. Draft/Requested Transfer Orders ───────────────────────────────

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

  // Batch-load destination facilities and TO lines
  const draftTOIds = draftTOs.map(to => to.id);
  const draftDestFacilityIds = [...new Set(draftTOs.map(to => to.destinationFacilityId))];

  const [destFacilitiesMap, allTOLines] = await Promise.all([
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

  for (const draftTO of draftTOs) {
    const lines = linesByTOId.get(draftTO.id) ?? [];
    if (lines.length === 0) continue;

    const totalQty = lines.reduce((sum, line) => sum + line.quantityRequested, 0);
    const partIds = [...new Set(lines.map(l => l.partId))];
    const firstPartId = partIds[0];

    if (filters.partId && !partIds.includes(filters.partId)) {
      continue;
    }

    const isExpedited = draftTO.status === 'requested' || Number(draftTO.priorityScore ?? 0) > 0;

    const priorityScore = computePriorityScore({
      daysBelowReorder: 0,
      isKanbanTriggered: false,
      isExpedited,
    });

    if (filters.minPriorityScore !== undefined && priorityScore < filters.minPriorityScore) {
      continue;
    }
    if (filters.maxPriorityScore !== undefined && priorityScore > filters.maxPriorityScore) {
      continue;
    }

    candidates.push({
      id: draftTO.id,
      type: 'draft_to',
      transferOrderId: draftTO.id,
      toNumber: draftTO.toNumber,
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

  // Batch-load source facility names
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

  for (const card of kanbanCards_triggered) {
    if (filters.partId && card.loop.partId !== filters.partId) {
      continue;
    }

    const sourceFacilityName = card.loop.sourceFacilityId
      ? (kanbanSourceFacMap.get(card.loop.sourceFacilityId) ?? 'Unknown')
      : 'Unknown';

    const daysSinceTrigger = Math.floor(
      (Date.now() - card.currentStageEnteredAt.getTime()) / (1000 * 60 * 60 * 24)
    );

    const priorityScore = computePriorityScore({
      daysBelowReorder: daysSinceTrigger,
      isKanbanTriggered: true,
      isExpedited: false,
    });

    if (filters.minPriorityScore !== undefined && priorityScore < filters.minPriorityScore) {
      continue;
    }
    if (filters.maxPriorityScore !== undefined && priorityScore > filters.maxPriorityScore) {
      continue;
    }

    candidates.push({
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
      _recMinQty: card.loop.orderQuantity,
    });
  }

  // ─── 3. Inventory Below Reorder Point ─────────────────────────────────

  const skipBelowReorder =
    !!filters.status && filters.status !== 'below_reorder';

  if (!skipBelowReorder) {
    const belowReorderConditions = [
      eq(inventoryLedger.tenantId, tenantId),
      sql`${inventoryLedger.qtyOnHand} < ${inventoryLedger.reorderPoint}`,
      sql`${inventoryLedger.reorderPoint} > 0`,
    ];

    if (filters.destinationFacilityId) {
      belowReorderConditions.push(eq(inventoryLedger.facilityId, filters.destinationFacilityId));
    }
    if (filters.partId) {
      belowReorderConditions.push(eq(inventoryLedger.partId, filters.partId));
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

    for (const row of belowReorderRows) {
      const available = row.qtyOnHand - row.qtyReserved;
      const deficit = row.reorderPoint - row.qtyOnHand;

      const daysSinceUpdate = Math.floor(
        (Date.now() - row.updatedAt.getTime()) / (1000 * 60 * 60 * 24)
      );
      const daysBelowReorder = Math.max(daysSinceUpdate, 1);

      const priorityScore = computePriorityScore({
        daysBelowReorder,
        isKanbanTriggered: false,
        isExpedited: false,
      });

      if (filters.minPriorityScore !== undefined && priorityScore < filters.minPriorityScore) {
        continue;
      }
      if (filters.maxPriorityScore !== undefined && priorityScore > filters.maxPriorityScore) {
        continue;
      }

      candidates.push({
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
        _recMinQty: row.reorderQty || deficit,
      });
    }
  }

  // ─── 3b. Filter below_reorder by sourceFacilityId if set ────────────
  // Below-reorder items have no intrinsic source facility, so we batch-load
  // recommendations and keep only those whose recommended sources include
  // the filtered facility.

  if (filters.sourceFacilityId) {
    const belowReorderCandidates = candidates.filter(c => c.type === 'below_reorder');

    if (belowReorderCandidates.length > 0) {
      const brRecRequests = belowReorderCandidates.map(c => ({
        destinationFacilityId: c.destinationFacilityId,
        partId: c.partId,
        minQty: c._recMinQty,
      }));

      const brRecsMap = await batchRecommendSources(tenantId, brRecRequests);

      const matchingIds = new Set<string>();
      for (const c of belowReorderCandidates) {
        const recKey = `${c.destinationFacilityId}::${c.partId}`;
        const recs = brRecsMap.get(recKey) ?? [];
        if (recs.some(r => r.facilityId === filters.sourceFacilityId)) {
          matchingIds.add(c.id);
        }
      }

      // Remove below_reorder candidates that don't match the source facility filter
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].type === 'below_reorder' && !matchingIds.has(candidates[i].id)) {
          candidates.splice(i, 1);
        }
      }
    }
  }

  // ─── 4. Sort by Priority (descending) + Stable Secondary Sort ─────────

  candidates.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const total = candidates.length;
  const paginatedCandidates = candidates.slice(offset, offset + limit);

  // ─── 5. Fetch recommendations only for the paginated slice ────────────

  const recRequests = paginatedCandidates.map(c => ({
    destinationFacilityId: c.destinationFacilityId,
    partId: c.partId,
    minQty: c._recMinQty,
  }));

  const recsMap = await batchRecommendSources(tenantId, recRequests);

  const items: TransferQueueItem[] = paginatedCandidates.map(c => {
    const recKey = `${c.destinationFacilityId}::${c.partId}`;
    const recommendedSources = recsMap.get(recKey) ?? [];

    const { _recMinQty, ...rest } = c;
    return { ...rest, recommendedSources };
  });

  return { items, total };
}
