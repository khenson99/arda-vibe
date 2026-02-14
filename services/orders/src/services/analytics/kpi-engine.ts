import { db, schema } from '@arda/db';
import { eq, and, sql, gte, lte, isNotNull } from 'drizzle-orm';
import { createLogger } from '@arda/config';

const log = createLogger('orders:kpi-engine');

// ─── Types ─────────────────────────────────────────────────────────────

export interface KpiDateRange {
  startDate: Date;
  endDate: Date;
}

export interface KpiFilters {
  tenantId: string;
  dateRange: KpiDateRange;
  previousDateRange: KpiDateRange;
  facilityIds?: string[];
}

export interface SparklinePoint {
  timestamp: string;
  value: number;
}

export interface KpiResult {
  kpiId: string;
  value: number;
  previousValue: number;
  delta: number;
  deltaPercent: number;
  threshold: number | null;
  unit: string;
  isNegativeGood: boolean;
  sparklineData: SparklinePoint[];
  lastUpdated: string;
}

export interface KpiTrendDataPoint {
  date: string;
  value: number;
  facilityId?: string;
  facilityName?: string;
}

export interface KpiTrendResult {
  kpiId: string;
  period: number;
  bucket: 'daily' | 'weekly';
  startDate: string;
  endDate: string;
  dataPoints: KpiTrendDataPoint[];
  facilities: Array<{ id: string; name: string }>;
}

export interface TrendFilters {
  tenantId: string;
  kpiId: string;
  startDate: Date;
  endDate: Date;
  bucket: 'daily' | 'weekly';
  facilityIds?: string[];
}

// ─── KPI Metadata ──────────────────────────────────────────────────────

const KPI_META: Record<
  string,
  { unit: string; isNegativeGood: boolean; threshold: number | null }
> = {
  fill_rate: { unit: '%', isNegativeGood: false, threshold: 95 },
  supplier_otd: { unit: '%', isNegativeGood: false, threshold: 90 },
  stockout_count: { unit: 'incidents', isNegativeGood: true, threshold: 5 },
  avg_cycle_time: { unit: 'hrs', isNegativeGood: true, threshold: 72 },
  order_accuracy: { unit: '%', isNegativeGood: false, threshold: 98 },
};

export const VALID_KPI_IDS = Object.keys(KPI_META);

// ─── Helpers ───────────────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function computeDelta(
  value: number,
  previousValue: number,
  isNegativeGood: boolean,
): { delta: number; deltaPercent: number } {
  const rawDelta = value - previousValue;
  const delta = isNegativeGood ? -rawDelta : rawDelta;
  const deltaPercent =
    previousValue !== 0
      ? round2((rawDelta / Math.abs(previousValue)) * 100)
      : value !== 0
        ? 100
        : 0;
  return { delta: round2(delta), deltaPercent };
}

/**
 * Generate 12-point sparkline by dividing the date range into 12 equal buckets.
 * Returns an array of { timestamp, value } for each bucket.
 */
function buildSparklineBuckets(
  startDate: Date,
  endDate: Date,
): { bucketStart: Date; bucketEnd: Date; timestamp: string }[] {
  const totalMs = endDate.getTime() - startDate.getTime();
  const bucketMs = totalMs / 12;
  const buckets: { bucketStart: Date; bucketEnd: Date; timestamp: string }[] = [];

  for (let i = 0; i < 12; i++) {
    const bucketStart = new Date(startDate.getTime() + i * bucketMs);
    const bucketEnd = new Date(startDate.getTime() + (i + 1) * bucketMs);
    buckets.push({
      bucketStart,
      bucketEnd,
      timestamp: bucketStart.toISOString(),
    });
  }

  return buckets;
}

// ─── Individual KPI Computations ───────────────────────────────────────

async function computeFillRate(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  facilityIds?: string[],
): Promise<number> {
  // Fill Rate = (receipts where ALL lines have quantityAccepted >= quantityExpected) / total receipts * 100
  // A receipt is "fully filled" when every receipt line accepted the expected quantity.
  const facilityJoin = facilityIds?.length
    ? sql` AND r.order_id IN (
        SELECT id FROM orders.purchase_orders WHERE facility_id = ANY(${facilityIds})
        UNION ALL
        SELECT id FROM orders.transfer_orders WHERE destination_facility_id = ANY(${facilityIds})
      )`
    : sql``;

  const result = await db.execute(sql`
    SELECT
      count(DISTINCT r.id)::int AS total_receipts,
      count(DISTINCT r.id) FILTER (
        WHERE r.id NOT IN (
          SELECT rl2.receipt_id
          FROM orders.receipt_lines rl2
          WHERE rl2.tenant_id = ${tenantId}
            AND rl2.quantity_accepted < rl2.quantity_expected
        )
      )::int AS full_receipts
    FROM orders.receipts r
    JOIN orders.receipt_lines rl ON rl.receipt_id = r.id
    WHERE r.tenant_id = ${tenantId}
      AND r.created_at >= ${startDate.toISOString()}::timestamptz
      AND r.created_at <= ${endDate.toISOString()}::timestamptz
      ${facilityJoin}
  `);

  const rows = result as unknown as Array<{ total_receipts: number; full_receipts: number }>;
  const row = rows[0];
  if (!row || row.total_receipts === 0) return 0;
  return round2((row.full_receipts / row.total_receipts) * 100);
}

async function computeSupplierOtd(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  facilityIds?: string[],
): Promise<number> {
  // Supplier OTD = (POs received on time) / (total received POs) * 100
  // On-time = actual_delivery_date <= expected_delivery_date
  const conditions = [
    eq(schema.purchaseOrders.tenantId, tenantId),
    eq(schema.purchaseOrders.status, 'received'),
    isNotNull(schema.purchaseOrders.expectedDeliveryDate),
    isNotNull(schema.purchaseOrders.actualDeliveryDate),
    gte(schema.purchaseOrders.actualDeliveryDate, startDate),
    lte(schema.purchaseOrders.actualDeliveryDate, endDate),
  ];

  if (facilityIds?.length) {
    conditions.push(
      sql`${schema.purchaseOrders.facilityId} = ANY(${facilityIds})` as ReturnType<typeof eq>,
    );
  }

  const result = await db
    .select({
      totalReceived: sql<number>`count(*)::int`,
      onTime: sql<number>`count(*) FILTER (WHERE ${schema.purchaseOrders.actualDeliveryDate} <= ${schema.purchaseOrders.expectedDeliveryDate})::int`,
    })
    .from(schema.purchaseOrders)
    .where(and(...conditions));

  const row = result[0];
  if (!row || row.totalReceived === 0) return 0;
  return round2((row.onTime / row.totalReceived) * 100);
}

async function computeStockoutCount(
  tenantId: string,
  _startDate: Date,
  _endDate: Date,
  facilityIds?: string[],
): Promise<number> {
  // Stockout count = number of distinct part+facility combos where qty_on_hand <= 0
  // This is a point-in-time snapshot from the inventory ledger.
  const conditions = [
    eq(schema.inventoryLedger.tenantId, tenantId),
    lte(schema.inventoryLedger.qtyOnHand, 0),
  ];

  if (facilityIds?.length) {
    conditions.push(
      sql`${schema.inventoryLedger.facilityId} = ANY(${facilityIds})` as ReturnType<typeof eq>,
    );
  }

  const result = await db
    .select({
      stockouts: sql<number>`count(*)::int`,
    })
    .from(schema.inventoryLedger)
    .where(and(...conditions));

  return result[0]?.stockouts ?? 0;
}

async function computeAvgCycleTime(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  facilityIds?: string[],
): Promise<number> {
  // Avg Cycle Time = average hours from actual_start_date to actual_end_date
  // for completed work orders in the date range.
  const conditions = [
    eq(schema.workOrders.tenantId, tenantId),
    eq(schema.workOrders.status, 'completed'),
    isNotNull(schema.workOrders.actualStartDate),
    isNotNull(schema.workOrders.actualEndDate),
    gte(schema.workOrders.actualEndDate, startDate),
    lte(schema.workOrders.actualEndDate, endDate),
  ];

  if (facilityIds?.length) {
    conditions.push(
      sql`${schema.workOrders.facilityId} = ANY(${facilityIds})` as ReturnType<typeof eq>,
    );
  }

  const result = await db
    .select({
      avgHours: sql<number>`avg(EXTRACT(EPOCH FROM (${schema.workOrders.actualEndDate} - ${schema.workOrders.actualStartDate})) / 3600)::float`,
    })
    .from(schema.workOrders)
    .where(and(...conditions));

  const avgHours = result[0]?.avgHours;
  return avgHours != null ? round2(avgHours) : 0;
}

async function computeOrderAccuracy(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  facilityIds?: string[],
): Promise<number> {
  // Order Accuracy = (receipt lines with zero defects) / (total receipt lines) * 100
  // A line is accurate when quantityDamaged = 0 AND quantityRejected = 0
  const facilityJoin = facilityIds?.length
    ? sql` AND r.order_id IN (
        SELECT id FROM orders.purchase_orders WHERE facility_id = ANY(${facilityIds})
        UNION ALL
        SELECT id FROM orders.transfer_orders WHERE destination_facility_id = ANY(${facilityIds})
      )`
    : sql``;

  const result = await db.execute(sql`
    SELECT
      count(*)::int AS total_lines,
      count(*) FILTER (
        WHERE rl.quantity_damaged = 0 AND rl.quantity_rejected = 0
      )::int AS accurate_lines
    FROM orders.receipt_lines rl
    JOIN orders.receipts r ON r.id = rl.receipt_id
    WHERE rl.tenant_id = ${tenantId}
      AND r.created_at >= ${startDate.toISOString()}::timestamptz
      AND r.created_at <= ${endDate.toISOString()}::timestamptz
      ${facilityJoin}
  `);

  const rows = result as unknown as Array<{ total_lines: number; accurate_lines: number }>;
  const row = rows[0];
  if (!row || row.total_lines === 0) return 0;
  return round2((row.accurate_lines / row.total_lines) * 100);
}

// ─── Sparkline Computation ─────────────────────────────────────────────

type KpiComputeFn = (
  tenantId: string,
  startDate: Date,
  endDate: Date,
  facilityIds?: string[],
) => Promise<number>;

const KPI_COMPUTE_FNS: Record<string, KpiComputeFn> = {
  fill_rate: computeFillRate,
  supplier_otd: computeSupplierOtd,
  stockout_count: computeStockoutCount,
  avg_cycle_time: computeAvgCycleTime,
  order_accuracy: computeOrderAccuracy,
};

async function buildSparkline(
  kpiId: string,
  tenantId: string,
  startDate: Date,
  endDate: Date,
  facilityIds?: string[],
): Promise<SparklinePoint[]> {
  const computeFn = KPI_COMPUTE_FNS[kpiId];
  if (!computeFn) return [];

  const buckets = buildSparklineBuckets(startDate, endDate);

  // Run all 12 bucket queries concurrently
  const points = await Promise.all(
    buckets.map(async (bucket) => {
      const value = await computeFn(tenantId, bucket.bucketStart, bucket.bucketEnd, facilityIds);
      return { timestamp: bucket.timestamp, value };
    }),
  );

  return points;
}

// ─── Main Engine ───────────────────────────────────────────────────────

export async function computeAllKpis(filters: KpiFilters): Promise<KpiResult[]> {
  const { tenantId, dateRange, previousDateRange, facilityIds } = filters;
  const now = new Date().toISOString();
  const startTime = Date.now();

  const kpiIds = Object.keys(KPI_META);

  // Execute all 5 KPI computations concurrently:
  // current value, previous value, and sparkline for each
  const results = await Promise.all(
    kpiIds.map(async (kpiId) => {
      const computeFn = KPI_COMPUTE_FNS[kpiId];
      const meta = KPI_META[kpiId];

      const [value, previousValue, sparklineData] = await Promise.all([
        computeFn(tenantId, dateRange.startDate, dateRange.endDate, facilityIds),
        computeFn(tenantId, previousDateRange.startDate, previousDateRange.endDate, facilityIds),
        buildSparkline(kpiId, tenantId, dateRange.startDate, dateRange.endDate, facilityIds),
      ]);

      const { delta, deltaPercent } = computeDelta(value, previousValue, meta.isNegativeGood);

      return {
        kpiId,
        value,
        previousValue,
        delta,
        deltaPercent,
        threshold: meta.threshold,
        unit: meta.unit,
        isNegativeGood: meta.isNegativeGood,
        sparklineData,
        lastUpdated: now,
      };
    }),
  );

  const durationMs = Date.now() - startTime;
  log.info(
    { tenantId, durationMs, kpiCount: results.length },
    'KPI computation complete',
  );

  return results;
}

// ─── Trend Computation ──────────────────────────────────────────────

/**
 * Build date buckets for trend data. Each bucket is a contiguous time range.
 * Daily: one bucket per day. Weekly: one bucket per 7 days.
 */
function buildTrendBuckets(
  startDate: Date,
  endDate: Date,
  bucket: 'daily' | 'weekly',
): { bucketStart: Date; bucketEnd: Date; date: string }[] {
  const buckets: { bucketStart: Date; bucketEnd: Date; date: string }[] = [];
  const stepMs = bucket === 'daily' ? 86_400_000 : 7 * 86_400_000;

  let current = new Date(startDate);
  while (current < endDate) {
    const bucketEnd = new Date(Math.min(current.getTime() + stepMs, endDate.getTime()));
    buckets.push({
      bucketStart: new Date(current),
      bucketEnd,
      date: current.toISOString().slice(0, 10), // YYYY-MM-DD
    });
    current = bucketEnd;
  }

  return buckets;
}

/**
 * Look up facility names for the given IDs.
 */
async function lookupFacilities(
  tenantId: string,
  facilityIds: string[],
): Promise<Array<{ id: string; name: string }>> {
  if (!facilityIds.length) return [];

  const result = await db.execute(sql`
    SELECT id, name
    FROM locations.facilities
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${facilityIds})
    ORDER BY name
  `);

  return (result as unknown as Array<{ id: string; name: string }>);
}

/**
 * Compute a time-series trend for a single KPI over a date range.
 * Supports facility overlays: when facilityIds are provided, each data point
 * is computed per-facility, allowing frontend to render multi-line overlays.
 */
export async function computeKpiTrend(filters: TrendFilters): Promise<KpiTrendResult> {
  const { tenantId, kpiId, startDate, endDate, bucket, facilityIds } = filters;
  const startTime = Date.now();

  const computeFn = KPI_COMPUTE_FNS[kpiId];
  if (!computeFn) {
    throw new KpiNotFoundError(kpiId);
  }

  const buckets = buildTrendBuckets(startDate, endDate, bucket);
  const hasFacilityOverlay = facilityIds && facilityIds.length > 1;

  let dataPoints: KpiTrendDataPoint[];
  let facilities: Array<{ id: string; name: string }> = [];

  if (hasFacilityOverlay) {
    // Compute per-facility overlays: one series per facility
    facilities = await lookupFacilities(tenantId, facilityIds);
    const facilityMap = new Map(facilities.map((f) => [f.id, f.name]));

    dataPoints = (
      await Promise.all(
        facilityIds.map(async (facId) => {
          const points = await Promise.all(
            buckets.map(async (b) => {
              const value = await computeFn(tenantId, b.bucketStart, b.bucketEnd, [facId]);
              return {
                date: b.date,
                value,
                facilityId: facId,
                facilityName: facilityMap.get(facId) ?? facId,
              };
            }),
          );
          return points;
        }),
      )
    ).flat();
  } else {
    // Single aggregate series (optionally filtered to one facility)
    dataPoints = await Promise.all(
      buckets.map(async (b) => {
        const value = await computeFn(tenantId, b.bucketStart, b.bucketEnd, facilityIds);
        return { date: b.date, value };
      }),
    );

    if (facilityIds?.length === 1) {
      facilities = await lookupFacilities(tenantId, facilityIds);
    }
  }

  const durationMs = Date.now() - startTime;
  const periodDays = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
  log.info(
    { tenantId, kpiId, periodDays, bucket, pointCount: dataPoints.length, durationMs },
    'KPI trend computation complete',
  );

  return {
    kpiId,
    period: periodDays,
    bucket,
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
    dataPoints,
    facilities,
  };
}

// ─── Error Types ────────────────────────────────────────────────────

export class KpiNotFoundError extends Error {
  public readonly code = 'KPI_NOT_FOUND';
  constructor(kpiId: string) {
    super(`Unknown KPI: '${kpiId}'. Valid KPIs: ${VALID_KPI_IDS.join(', ')}`);
    this.name = 'KpiNotFoundError';
  }
}
