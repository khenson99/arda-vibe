import { db, schema } from '@arda/db';
import { eq, and, desc, sql } from 'drizzle-orm';
import { createLogger } from '@arda/config';

const log = createLogger('orders:restock-eta');

const {
  kanbanLoops,
  kanbanCards,
  leadTimeHistory,
  supplierParts,
  inventoryLedger,
  salesOrders,
  salesOrderLines,
} = schema;

// ─── Constants ──────────────────────────────────────────────────────
const WMA_ALPHA = 0.3;
const WMA_HISTORY_LIMIT = 10;
const DEFAULT_LEAD_TIME_DAYS = 14;

// ─── Types ──────────────────────────────────────────────────────────
export interface RestockEtaResult {
  partId: string;
  facilityId: string;
  /** Estimated days until restock, or null if already stocked */
  etaDays: number | null;
  /** ISO date string when stock is expected */
  etaDate: string | null;
  /** Which data source determined the lead time */
  leadTimeSource: 'history_wma' | 'loop_stated' | 'supplier_part' | 'default';
  /** The base lead time in days before stage adjustment */
  baseLeadTimeDays: number;
  /** Current active card stage, or null if no active replenishment */
  activeCardStage: string | null;
  /** Available on-hand quantity at this facility */
  qtyOnHand: number;
  /** Reserved quantity */
  qtyReserved: number;
  /** In-transit quantity */
  qtyInTransit: number;
  /** Net available = onHand - reserved */
  netAvailable: number;
}

export interface SalesOrderLineEta {
  lineId: string;
  partId: string;
  lineNumber: number;
  quantityOrdered: number;
  quantityAllocated: number;
  quantityShipped: number;
  /** Shortfall = max(0, ordered - allocated) */
  shortfall: number;
  eta: RestockEtaResult | null;
}

// ─── Weighted Moving Average ────────────────────────────────────────
// Exponential weighted moving average with alpha=0.3.
// Most recent record has the highest weight.
export function computeWeightedMovingAverage(
  leadTimes: number[],
  alpha: number = WMA_ALPHA,
): number | null {
  if (leadTimes.length === 0) return null;
  if (leadTimes.length === 1) return leadTimes[0];

  // leadTimes[0] = most recent, leadTimes[n-1] = oldest
  // WMA: start with oldest, blend toward newest
  let wma = leadTimes[leadTimes.length - 1];
  for (let i = leadTimes.length - 2; i >= 0; i--) {
    wma = alpha * leadTimes[i] + (1 - alpha) * wma;
  }
  return Math.round(wma * 100) / 100; // 2 decimal places
}

// ─── Lead Time Estimation ───────────────────────────────────────────
// Returns estimated lead time in days and its source.
// Fallback order: history WMA → loop stated → supplier part → default 14 days.
async function estimateLeadTime(
  tenantId: string,
  facilityId: string,
  partId: string,
): Promise<{ leadTimeDays: number; source: RestockEtaResult['leadTimeSource'] }> {
  // 1) Try lead-time history (last 10 records, newest first)
  const history = await db
    .select({ leadTimeDays: leadTimeHistory.leadTimeDays })
    .from(leadTimeHistory)
    .where(
      and(
        eq(leadTimeHistory.tenantId, tenantId),
        eq(leadTimeHistory.partId, partId),
        eq(leadTimeHistory.destinationFacilityId, facilityId),
      ),
    )
    .orderBy(desc(leadTimeHistory.receivedAt))
    .limit(WMA_HISTORY_LIMIT);

  if (history.length > 0) {
    const values = history.map((h) => Number(h.leadTimeDays));
    const wma = computeWeightedMovingAverage(values);
    if (wma !== null && wma > 0) {
      return { leadTimeDays: wma, source: 'history_wma' };
    }
  }

  // 2) Try kanban loop statedLeadTimeDays
  const loop = await db
    .select({ statedLeadTimeDays: kanbanLoops.statedLeadTimeDays })
    .from(kanbanLoops)
    .where(
      and(
        eq(kanbanLoops.tenantId, tenantId),
        eq(kanbanLoops.partId, partId),
        eq(kanbanLoops.facilityId, facilityId),
        eq(kanbanLoops.isActive, true),
      ),
    )
    .limit(1);

  if (loop.length > 0 && loop[0].statedLeadTimeDays !== null) {
    return { leadTimeDays: loop[0].statedLeadTimeDays, source: 'loop_stated' };
  }

  // 3) Try supplier part lead time (primary supplier first, then any)
  const spResult = await db
    .select({ leadTimeDays: supplierParts.leadTimeDays })
    .from(supplierParts)
    .where(
      and(
        eq(supplierParts.partId, partId),
        eq(supplierParts.isActive, true),
      ),
    )
    .orderBy(desc(supplierParts.isPrimary))
    .limit(1);

  if (spResult.length > 0 && spResult[0].leadTimeDays !== null) {
    return { leadTimeDays: spResult[0].leadTimeDays, source: 'supplier_part' };
  }

  // 4) Default
  return { leadTimeDays: DEFAULT_LEAD_TIME_DAYS, source: 'default' };
}

// ─── Active Card Stage ──────────────────────────────────────────────
// Find the most recently-entered active card for this part+facility.
// Active stages for ETA: triggered, ordered, in_transit.
async function findActiveCard(
  tenantId: string,
  facilityId: string,
  partId: string,
): Promise<{ stage: string; stageEnteredAt: Date } | null> {
  // Join kanbanCards → kanbanLoops to filter by partId + facilityId
  const result = await db
    .select({
      stage: kanbanCards.currentStage,
      stageEnteredAt: kanbanCards.currentStageEnteredAt,
    })
    .from(kanbanCards)
    .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
    .where(
      and(
        eq(kanbanCards.tenantId, tenantId),
        eq(kanbanLoops.partId, partId),
        eq(kanbanLoops.facilityId, facilityId),
        eq(kanbanCards.isActive, true),
        sql`${kanbanCards.currentStage} IN ('triggered', 'ordered', 'in_transit')`,
      ),
    )
    .orderBy(desc(kanbanCards.currentStageEnteredAt))
    .limit(1);

  if (result.length === 0) return null;

  return {
    stage: result[0].stage,
    stageEnteredAt: result[0].stageEnteredAt,
  };
}

// ─── Inventory Position ─────────────────────────────────────────────
async function getInventoryPosition(
  tenantId: string,
  facilityId: string,
  partId: string,
): Promise<{ qtyOnHand: number; qtyReserved: number; qtyInTransit: number }> {
  const result = await db
    .select({
      qtyOnHand: inventoryLedger.qtyOnHand,
      qtyReserved: inventoryLedger.qtyReserved,
      qtyInTransit: inventoryLedger.qtyInTransit,
    })
    .from(inventoryLedger)
    .where(
      and(
        eq(inventoryLedger.tenantId, tenantId),
        eq(inventoryLedger.facilityId, facilityId),
        eq(inventoryLedger.partId, partId),
      ),
    )
    .limit(1);

  if (result.length === 0) {
    return { qtyOnHand: 0, qtyReserved: 0, qtyInTransit: 0 };
  }

  return result[0];
}

// ─── ETA Calculation ────────────────────────────────────────────────
// Core algorithm:
// 1. Get base lead time from fallback chain
// 2. Find active card and compute days elapsed in current stage
// 3. ETA = baseLeadTime - daysElapsed (clamped to >= 0)
//    - triggered: full baseLeadTime (hasn't started ordering yet)
//    - ordered: baseLeadTime - daysInOrderedStage
//    - in_transit: max(1, baseLeadTime - daysInTransitStage)
//    - no active card: full baseLeadTime (nothing in flight)
export async function calculateRestockEta(
  tenantId: string,
  facilityId: string,
  partId: string,
): Promise<RestockEtaResult> {
  // Sequential to ensure deterministic query ordering and avoid
  // potential contention on DB connections under high concurrency.
  const leadTimeEstimate = await estimateLeadTime(tenantId, facilityId, partId);
  const activeCard = await findActiveCard(tenantId, facilityId, partId);
  const inventory = await getInventoryPosition(tenantId, facilityId, partId);

  const { leadTimeDays: baseLeadTimeDays, source: leadTimeSource } = leadTimeEstimate;
  const { qtyOnHand, qtyReserved, qtyInTransit } = inventory;
  const netAvailable = qtyOnHand - qtyReserved;

  let etaDays: number | null;
  let activeCardStage: string | null = null;

  if (activeCard) {
    activeCardStage = activeCard.stage;
    const now = new Date();
    const daysElapsed =
      (now.getTime() - activeCard.stageEnteredAt.getTime()) / (1000 * 60 * 60 * 24);

    switch (activeCard.stage) {
      case 'triggered':
        // Not yet ordered — full lead time ahead
        etaDays = baseLeadTimeDays;
        break;
      case 'ordered':
        // Order placed, subtract time spent in ordered stage
        etaDays = Math.max(0, baseLeadTimeDays - daysElapsed);
        break;
      case 'in_transit':
        // In transit, subtract transit time elapsed (minimum 1 day if still moving)
        etaDays = Math.max(0, baseLeadTimeDays - daysElapsed);
        break;
      default:
        etaDays = baseLeadTimeDays;
    }
  } else {
    // No active replenishment — ETA is the full lead time from now
    etaDays = baseLeadTimeDays;
  }

  // Round to 1 decimal place
  etaDays = Math.round(etaDays * 10) / 10;

  // Compute ETA date
  const etaDate = new Date();
  etaDate.setTime(etaDate.getTime() + etaDays * 24 * 60 * 60 * 1000);

  return {
    partId,
    facilityId,
    etaDays,
    etaDate: etaDate.toISOString(),
    leadTimeSource,
    baseLeadTimeDays,
    activeCardStage,
    qtyOnHand,
    qtyReserved,
    qtyInTransit,
    netAvailable,
  };
}

// ─── Batch ETA ──────────────────────────────────────────────────────
export async function calculateBatchRestockEta(
  tenantId: string,
  items: Array<{ partId: string; facilityId: string }>,
): Promise<RestockEtaResult[]> {
  // Run all ETA calculations in parallel
  return Promise.all(
    items.map((item) =>
      calculateRestockEta(tenantId, item.facilityId, item.partId),
    ),
  );
}

// ─── Sales Order Line ETAs ──────────────────────────────────────────
export async function calculateSalesOrderLineEtas(
  tenantId: string,
  orderId: string,
): Promise<{ orderId: string; facilityId: string; lines: SalesOrderLineEta[] }> {
  // Get the order to determine facilityId
  const order = await db.query.salesOrders.findFirst({
    where: and(
      eq(salesOrders.id, orderId),
      eq(salesOrders.tenantId, tenantId),
    ),
  });

  if (!order) {
    throw new Error('Sales order not found');
  }

  // Get all lines for this order
  const lines = await db
    .select()
    .from(salesOrderLines)
    .where(
      and(
        eq(salesOrderLines.salesOrderId, orderId),
        eq(salesOrderLines.tenantId, tenantId),
      ),
    )
    .orderBy(salesOrderLines.lineNumber);

  // Calculate ETA for each line's part at the order's facility
  const lineEtas: SalesOrderLineEta[] = await Promise.all(
    lines.map(async (line) => {
      const shortfall = Math.max(0, line.quantityOrdered - line.quantityAllocated);
      let eta: RestockEtaResult | null = null;

      // Only compute ETA if there's a shortfall
      if (shortfall > 0) {
        try {
          eta = await calculateRestockEta(tenantId, order.facilityId, line.partId);
        } catch (err) {
          log.warn({ partId: line.partId, err }, 'Failed to compute ETA for line');
        }
      }

      return {
        lineId: line.id,
        partId: line.partId,
        lineNumber: line.lineNumber,
        quantityOrdered: line.quantityOrdered,
        quantityAllocated: line.quantityAllocated,
        quantityShipped: line.quantityShipped,
        shortfall,
        eta,
      };
    }),
  );

  return {
    orderId,
    facilityId: order.facilityId,
    lines: lineEtas,
  };
}
