/**
 * Cross-Location Inventory Service
 *
 * Provides facility-part matrix view and network-wide KPI summaries
 * for multi-facility inventory management.
 *
 * Key operations:
 *   - Matrix query: facilities (rows) × parts (columns) with qty details
 *   - Summary KPIs: in-transit value, transfer count, avg lead time, reorder alerts
 *
 * Performance target: <800ms for 20 facilities × 500 parts on representative data.
 */

import { db, schema } from '@arda/db';
import { eq, and, sql, inArray } from 'drizzle-orm';

const { inventoryLedger, facilities, parts } = schema;

// ─── Types ────────────────────────────────────────────────────────────

export interface CrossLocationMatrixInput {
  tenantId: string;
  /** Paginate by parts (columns). Default: 1 */
  page?: number;
  /** Parts per page. Default: 50, max 500 */
  pageSize?: number;
  /** Optional filter: specific part IDs */
  partIds?: string[];
  /** Optional filter: specific facility IDs */
  facilityIds?: string[];
}

export interface MatrixCell {
  facilityId: string;
  facilityName: string;
  facilityCode: string;
  partId: string;
  partNumber: string;
  partName: string;
  qtyOnHand: number;
  qtyReserved: number;
  qtyInTransit: number;
  /** Computed: qtyOnHand - qtyReserved */
  available: number;
  reorderPoint: number;
  /** True if available <= reorderPoint */
  belowReorder: boolean;
  /**
   * True if available is within 20% buffer above reorderPoint but NOT below it.
   * Exclusive of belowReorder: when belowReorder is true, nearReorder is false.
   * Range: reorderPoint < available <= reorderPoint * 1.2
   */
  nearReorder: boolean;
}

export interface CrossLocationMatrixResult {
  data: MatrixCell[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface CrossLocationSummaryInput {
  tenantId: string;
  /** Optional: filter by facility IDs */
  facilityIds?: string[];
}

export interface CrossLocationSummary {
  /** Total value of qtyInTransit across network (sum of qtyInTransit * unitCost) */
  totalInTransitValue: number;
  /** Count of inventory ledger rows with qtyInTransit > 0 */
  pendingTransferCount: number;
  /** Average lead time in days (mocked for MVP - requires order history) */
  averageNetworkLeadTimeDays: number;
  /** Count of facility-part combinations where available <= reorderPoint */
  facilitiesBelowReorderPoint: number;
  /** Count of facility-part combinations where available <= reorderPoint * 1.2 */
  facilitiesNearReorderPoint: number;
}

// ─── Cross-Location Matrix ────────────────────────────────────────────

/**
 * Returns a facility-part matrix with computed availability and reorder flags.
 *
 * Pagination strategy: paginate by parts (columns), return all facilities (rows)
 * for each page of parts. This allows UI to display complete facility coverage
 * for the selected part range.
 *
 * Filters:
 *   - partIds: restrict to specific parts
 *   - facilityIds: restrict to specific facilities
 *
 * Performance notes:
 *   - Uses inv_ledger_tenant_idx and inv_ledger_part_idx indexes
 *   - LEFT JOINs facilities and parts for denormalization
 *   - Computed fields: available = qtyOnHand - qtyReserved
 */
export async function getCrossLocationMatrix(
  input: CrossLocationMatrixInput
): Promise<CrossLocationMatrixResult> {
  const { tenantId, page = 1, pageSize = 50, partIds, facilityIds } = input;
  const limit = Math.min(pageSize, 500);
  const offset = (page - 1) * limit;

  // Step 1: Get paginated list of active parts (with optional filter)
  const partsConditions = [eq(parts.tenantId, tenantId), eq(parts.isActive, true)];
  if (partIds && partIds.length > 0) {
    partsConditions.push(inArray(parts.id, partIds));
  }

  const paginatedParts = await db
    .select({ id: parts.id })
    .from(parts)
    .where(and(...partsConditions))
    .orderBy(parts.partNumber)
    .limit(limit)
    .offset(offset);

  const partIdsForPage = paginatedParts.map((p) => p.id);

  if (partIdsForPage.length === 0) {
    return {
      data: [],
      pagination: {
        page,
        pageSize: limit,
        total: 0,
        totalPages: 0,
      },
    };
  }

  // Step 2: Query inventory ledger for the selected parts × active facilities
  const matrixConditions = [
    eq(inventoryLedger.tenantId, tenantId),
    eq(facilities.isActive, true),
    inArray(inventoryLedger.partId, partIdsForPage),
  ];
  if (facilityIds && facilityIds.length > 0) {
    matrixConditions.push(inArray(inventoryLedger.facilityId, facilityIds));
  }

  const rows = await db
    .select({
      facilityId: inventoryLedger.facilityId,
      facilityName: facilities.name,
      facilityCode: facilities.code,
      partId: inventoryLedger.partId,
      partNumber: parts.partNumber,
      partName: parts.name,
      qtyOnHand: inventoryLedger.qtyOnHand,
      qtyReserved: inventoryLedger.qtyReserved,
      qtyInTransit: inventoryLedger.qtyInTransit,
      reorderPoint: inventoryLedger.reorderPoint,
    })
    .from(inventoryLedger)
    .innerJoin(facilities, eq(inventoryLedger.facilityId, facilities.id))
    .innerJoin(parts, eq(inventoryLedger.partId, parts.id))
    .where(and(...matrixConditions))
    .orderBy(facilities.code, parts.partNumber);

  // Step 3: Compute derived fields
  const data: MatrixCell[] = rows.map((row) => {
    const available = row.qtyOnHand - row.qtyReserved;
    const belowReorder = available <= row.reorderPoint;
    // Exclusive: near-reorder means within 20% buffer but NOT below reorder point
    const nearReorder = !belowReorder && available <= row.reorderPoint * 1.2;

    return {
      facilityId: row.facilityId,
      facilityName: row.facilityName,
      facilityCode: row.facilityCode,
      partId: row.partId,
      partNumber: row.partNumber,
      partName: row.partName,
      qtyOnHand: row.qtyOnHand,
      qtyReserved: row.qtyReserved,
      qtyInTransit: row.qtyInTransit,
      available,
      reorderPoint: row.reorderPoint,
      belowReorder,
      nearReorder,
    };
  });

  // Step 4: Get total part count for pagination
  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(parts)
    .where(and(...partsConditions));

  const total = countResult[0]?.count ?? 0;

  return {
    data,
    pagination: {
      page,
      pageSize: limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

// ─── Cross-Location Summary ───────────────────────────────────────────

/**
 * Returns network-wide KPI summaries for cross-location inventory management.
 *
 * Metrics:
 *   - totalInTransitValue: sum of (qtyInTransit * unitCost)
 *   - pendingTransferCount: count of rows with qtyInTransit > 0
 *   - averageNetworkLeadTimeDays: mocked at 3.5 days (requires order history)
 *   - facilitiesBelowReorderPoint: count where available <= reorderPoint
 *   - facilitiesNearReorderPoint: count where reorderPoint < available <= reorderPoint * 1.2 (exclusive of belowReorder)
 *
 * Performance: Single query with aggregations over inventory_ledger + parts join.
 */
export async function getCrossLocationSummary(
  input: CrossLocationSummaryInput
): Promise<CrossLocationSummary> {
  const { tenantId, facilityIds } = input;

  // Build conditions array with optional facility filter
  const conditions = [
    eq(inventoryLedger.tenantId, tenantId),
    eq(facilities.isActive, true),
  ];
  if (facilityIds && facilityIds.length > 0) {
    conditions.push(inArray(inventoryLedger.facilityId, facilityIds));
  }

  // Single aggregation query for all KPIs
  const result = await db
    .select({
      totalInTransitValue: sql<number>`
        COALESCE(
          SUM(${inventoryLedger.qtyInTransit}::numeric * COALESCE(${parts.unitCost}, 0)),
          0
        )::numeric
      `,
      pendingTransferCount: sql<number>`
        COUNT(CASE WHEN ${inventoryLedger.qtyInTransit} > 0 THEN 1 END)::int
      `,
      facilitiesBelowReorderPoint: sql<number>`
        COUNT(
          CASE WHEN (${inventoryLedger.qtyOnHand} - ${inventoryLedger.qtyReserved}) <= ${inventoryLedger.reorderPoint}
          THEN 1 END
        )::int
      `,
      facilitiesNearReorderPoint: sql<number>`
        COUNT(
          CASE WHEN (${inventoryLedger.qtyOnHand} - ${inventoryLedger.qtyReserved}) > ${inventoryLedger.reorderPoint}
            AND (${inventoryLedger.qtyOnHand} - ${inventoryLedger.qtyReserved}) <= (${inventoryLedger.reorderPoint} * 1.2)
          THEN 1 END
        )::int
      `,
    })
    .from(inventoryLedger)
    .innerJoin(facilities, eq(inventoryLedger.facilityId, facilities.id))
    .innerJoin(parts, eq(inventoryLedger.partId, parts.id))
    .where(and(...conditions));

  const row = result[0];

  // MVP: mock average lead time at 3.5 days
  // TODO(MVP-10/T13): compute from actual transfer order history when available
  const averageNetworkLeadTimeDays = 3.5;

  return {
    totalInTransitValue: parseFloat(row.totalInTransitValue?.toString() ?? '0'),
    pendingTransferCount: row.pendingTransferCount,
    averageNetworkLeadTimeDays,
    facilitiesBelowReorderPoint: row.facilitiesBelowReorderPoint,
    facilitiesNearReorderPoint: row.facilitiesNearReorderPoint,
  };
}
