import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { createLogger } from '@arda/config';
import { VALID_KPI_IDS, KpiNotFoundError } from './kpi-engine.js';

const log = createLogger('orders:kpi-drilldown');

// ─── Types ─────────────────────────────────────────────────────────────

export interface DrilldownFilters {
  tenantId: string;
  kpiId: string;
  startDate: Date;
  endDate: Date;
  facilityIds?: string[];
  page: number;
  limit: number;
  sort: string;
  sortDir: 'asc' | 'desc';
}

export interface DrilldownResult {
  kpiId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  limit: number;
}

// ─── Column Definitions (stable keys for frontend rendering) ──────────

const DRILLDOWN_COLUMNS: Record<string, string[]> = {
  fill_rate: [
    'receiptNumber', 'orderType', 'orderId', 'totalLines', 'fullLines',
    'fillRatePercent', 'facilityName', 'createdAt',
  ],
  supplier_otd: [
    'poNumber', 'supplierName', 'expectedDeliveryDate', 'actualDeliveryDate',
    'isOnTime', 'varianceDays', 'facilityName',
  ],
  stockout_count: [
    'partNumber', 'partName', 'facilityName', 'qtyOnHand', 'reorderPoint',
    'daysAtZero',
  ],
  avg_cycle_time: [
    'woNumber', 'partName', 'facilityName', 'actualStartDate', 'actualEndDate',
    'cycleTimeHours',
  ],
  order_accuracy: [
    'receiptNumber', 'partNumber', 'partName', 'quantityExpected', 'quantityAccepted',
    'quantityDamaged', 'quantityRejected', 'isAccurate', 'createdAt',
  ],
};

// ─── Sort Column Mapping (camelCase → SQL column expressions) ──────────

const SORT_COLUMNS: Record<string, Record<string, string>> = {
  fill_rate: {
    receiptNumber: 'r.receipt_number',
    orderType: 'r.order_type',
    orderId: 'r.order_id',
    totalLines: 'total_lines',
    fullLines: 'full_lines',
    fillRatePercent: 'fill_rate_percent',
    facilityName: '"facilityName"',
    createdAt: 'r.created_at',
  },
  supplier_otd: {
    poNumber: 'po.po_number',
    supplierName: 's.name',
    expectedDeliveryDate: 'po.expected_delivery_date',
    actualDeliveryDate: 'po.actual_delivery_date',
    isOnTime: 'is_on_time',
    varianceDays: 'variance_days',
    facilityName: 'f.name',
  },
  stockout_count: {
    partNumber: 'p.part_number',
    partName: 'p.name',
    facilityName: 'f.name',
    qtyOnHand: 'il.qty_on_hand',
    reorderPoint: 'il.reorder_point',
    daysAtZero: 'days_at_zero',
  },
  avg_cycle_time: {
    woNumber: 'wo.wo_number',
    partName: 'p.name',
    facilityName: 'f.name',
    actualStartDate: 'wo.actual_start_date',
    actualEndDate: 'wo.actual_end_date',
    cycleTimeHours: 'cycle_time_hours',
  },
  order_accuracy: {
    receiptNumber: 'r.receipt_number',
    partNumber: 'p.part_number',
    partName: 'p.name',
    quantityExpected: 'rl.quantity_expected',
    quantityAccepted: 'rl.quantity_accepted',
    quantityDamaged: 'rl.quantity_damaged',
    quantityRejected: 'rl.quantity_rejected',
    isAccurate: 'is_accurate',
    createdAt: 'r.created_at',
  },
};

// ─── Default Sort Columns ─────────────────────────────────────────────

const DEFAULT_SORT: Record<string, { column: string; dir: 'asc' | 'desc' }> = {
  fill_rate: { column: 'createdAt', dir: 'desc' },
  supplier_otd: { column: 'actualDeliveryDate', dir: 'desc' },
  stockout_count: { column: 'qtyOnHand', dir: 'asc' },
  avg_cycle_time: { column: 'cycleTimeHours', dir: 'desc' },
  order_accuracy: { column: 'createdAt', dir: 'desc' },
};

// ─── Helpers ──────────────────────────────────────────────────────────

function resolveSortColumn(kpiId: string, sort: string): string {
  const mapping = SORT_COLUMNS[kpiId];
  return mapping?.[sort] ?? Object.values(mapping)[0];
}

// ─── Fill Rate Drilldown ──────────────────────────────────────────────

async function drilldownFillRate(filters: DrilldownFilters): Promise<DrilldownResult> {
  const { tenantId, startDate, endDate, facilityIds, page, limit, sort, sortDir } = filters;
  const offset = (page - 1) * limit;

  const facilityFilter = facilityIds?.length
    ? sql` AND r.order_id IN (
        SELECT id FROM orders.purchase_orders WHERE tenant_id = ${tenantId} AND facility_id = ANY(${facilityIds})
        UNION ALL
        SELECT id FROM orders.transfer_orders WHERE tenant_id = ${tenantId} AND destination_facility_id = ANY(${facilityIds})
      )`
    : sql``;

  const sortCol = resolveSortColumn('fill_rate', sort);
  const orderClause = sql.raw(`${sortCol} ${sortDir}`);

  // Count query
  const countResult = await db.execute(sql`
    SELECT count(DISTINCT r.id)::int AS total
    FROM orders.receipts r
    WHERE r.tenant_id = ${tenantId}
      AND r.created_at >= ${startDate.toISOString()}::timestamptz
      AND r.created_at < ${endDate.toISOString()}::timestamptz
      ${facilityFilter}
  `);
  const totalRows = (countResult as unknown as Array<{ total: number }>)[0]?.total ?? 0;

  // Data query
  const result = await db.execute(sql`
    SELECT
      r.receipt_number AS "receiptNumber",
      r.order_type AS "orderType",
      r.order_id::text AS "orderId",
      count(rl.id)::int AS "totalLines",
      count(rl.id) FILTER (
        WHERE rl.id NOT IN (
          SELECT rl2.id FROM orders.receipt_lines rl2
          WHERE rl2.tenant_id = ${tenantId}
            AND rl2.receipt_id = r.id
            AND rl2.quantity_accepted < rl2.quantity_expected
        )
      )::int AS "fullLines",
      CASE WHEN count(rl.id) > 0
        THEN round(
          count(rl.id) FILTER (
            WHERE rl.id NOT IN (
              SELECT rl2.id FROM orders.receipt_lines rl2
              WHERE rl2.tenant_id = ${tenantId}
                AND rl2.receipt_id = r.id
                AND rl2.quantity_accepted < rl2.quantity_expected
            )
          )::numeric / count(rl.id) * 100, 2
        )::float
        ELSE 0
      END AS "fillRatePercent",
      COALESCE(f_po.name, f_to.name, '') AS "facilityName",
      r.created_at AS "createdAt"
    FROM orders.receipts r
    JOIN orders.receipt_lines rl ON rl.receipt_id = r.id AND rl.tenant_id = ${tenantId}
    LEFT JOIN orders.purchase_orders po ON po.id = r.order_id AND r.order_type = 'purchase_order' AND po.tenant_id = ${tenantId}
    LEFT JOIN locations.facilities f_po ON f_po.id = po.facility_id AND f_po.tenant_id = ${tenantId}
    LEFT JOIN orders.transfer_orders tro ON tro.id = r.order_id AND r.order_type = 'transfer_order' AND tro.tenant_id = ${tenantId}
    LEFT JOIN locations.facilities f_to ON f_to.id = tro.destination_facility_id AND f_to.tenant_id = ${tenantId}
    WHERE r.tenant_id = ${tenantId}
      AND r.created_at >= ${startDate.toISOString()}::timestamptz
      AND r.created_at < ${endDate.toISOString()}::timestamptz
      ${facilityFilter}
    GROUP BY r.id, r.receipt_number, r.order_type, r.order_id, r.created_at, f_po.name, f_to.name
    ORDER BY ${orderClause}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    kpiId: 'fill_rate',
    columns: DRILLDOWN_COLUMNS.fill_rate,
    rows: result as unknown as Record<string, unknown>[],
    totalRows,
    page,
    limit,
  };
}

// ─── Supplier OTD Drilldown ───────────────────────────────────────────

async function drilldownSupplierOtd(filters: DrilldownFilters): Promise<DrilldownResult> {
  const { tenantId, startDate, endDate, facilityIds, page, limit, sort, sortDir } = filters;
  const offset = (page - 1) * limit;

  const facilityFilter = facilityIds?.length
    ? sql` AND po.facility_id = ANY(${facilityIds})`
    : sql``;

  const sortCol = resolveSortColumn('supplier_otd', sort);
  const orderClause = sql.raw(`${sortCol} ${sortDir}`);

  const countResult = await db.execute(sql`
    SELECT count(*)::int AS total
    FROM orders.purchase_orders po
    WHERE po.tenant_id = ${tenantId}
      AND po.status = 'received'
      AND po.expected_delivery_date IS NOT NULL
      AND po.actual_delivery_date IS NOT NULL
      AND po.actual_delivery_date >= ${startDate.toISOString()}::timestamptz
      AND po.actual_delivery_date < ${endDate.toISOString()}::timestamptz
      ${facilityFilter}
  `);
  const totalRows = (countResult as unknown as Array<{ total: number }>)[0]?.total ?? 0;

  const result = await db.execute(sql`
    SELECT
      po.po_number AS "poNumber",
      s.name AS "supplierName",
      po.expected_delivery_date AS "expectedDeliveryDate",
      po.actual_delivery_date AS "actualDeliveryDate",
      (po.actual_delivery_date <= po.expected_delivery_date) AS "isOnTime",
      EXTRACT(EPOCH FROM (po.actual_delivery_date - po.expected_delivery_date)) / 86400 AS "varianceDays",
      f.name AS "facilityName"
    FROM orders.purchase_orders po
    JOIN catalog.suppliers s ON s.id = po.supplier_id AND s.tenant_id = ${tenantId}
    LEFT JOIN locations.facilities f ON f.id = po.facility_id AND f.tenant_id = ${tenantId}
    WHERE po.tenant_id = ${tenantId}
      AND po.status = 'received'
      AND po.expected_delivery_date IS NOT NULL
      AND po.actual_delivery_date IS NOT NULL
      AND po.actual_delivery_date >= ${startDate.toISOString()}::timestamptz
      AND po.actual_delivery_date < ${endDate.toISOString()}::timestamptz
      ${facilityFilter}
    ORDER BY ${orderClause}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    kpiId: 'supplier_otd',
    columns: DRILLDOWN_COLUMNS.supplier_otd,
    rows: result as unknown as Record<string, unknown>[],
    totalRows,
    page,
    limit,
  };
}

// ─── Stockout Count Drilldown ─────────────────────────────────────────

async function drilldownStockoutCount(filters: DrilldownFilters): Promise<DrilldownResult> {
  const { tenantId, facilityIds, page, limit, sort, sortDir } = filters;
  const offset = (page - 1) * limit;

  const facilityFilter = facilityIds?.length
    ? sql` AND il.facility_id = ANY(${facilityIds})`
    : sql``;

  const sortCol = resolveSortColumn('stockout_count', sort);
  const orderClause = sql.raw(`${sortCol} ${sortDir}`);

  const countResult = await db.execute(sql`
    SELECT count(*)::int AS total
    FROM locations.inventory_ledger il
    WHERE il.tenant_id = ${tenantId}
      AND il.qty_on_hand <= 0
      ${facilityFilter}
  `);
  const totalRows = (countResult as unknown as Array<{ total: number }>)[0]?.total ?? 0;

  // daysAtZero: number of days since updated_at (last stock change) when qty <= 0
  const result = await db.execute(sql`
    SELECT
      p.part_number AS "partNumber",
      p.name AS "partName",
      f.name AS "facilityName",
      il.qty_on_hand AS "qtyOnHand",
      il.reorder_point AS "reorderPoint",
      EXTRACT(EPOCH FROM (now() - il.updated_at)) / 86400 AS "daysAtZero"
    FROM locations.inventory_ledger il
    JOIN catalog.parts p ON p.id = il.part_id AND p.tenant_id = ${tenantId}
    JOIN locations.facilities f ON f.id = il.facility_id AND f.tenant_id = ${tenantId}
    WHERE il.tenant_id = ${tenantId}
      AND il.qty_on_hand <= 0
      ${facilityFilter}
    ORDER BY ${orderClause}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    kpiId: 'stockout_count',
    columns: DRILLDOWN_COLUMNS.stockout_count,
    rows: result as unknown as Record<string, unknown>[],
    totalRows,
    page,
    limit,
  };
}

// ─── Avg Cycle Time Drilldown ─────────────────────────────────────────

async function drilldownAvgCycleTime(filters: DrilldownFilters): Promise<DrilldownResult> {
  const { tenantId, startDate, endDate, facilityIds, page, limit, sort, sortDir } = filters;
  const offset = (page - 1) * limit;

  const facilityFilter = facilityIds?.length
    ? sql` AND wo.facility_id = ANY(${facilityIds})`
    : sql``;

  const sortCol = resolveSortColumn('avg_cycle_time', sort);
  const orderClause = sql.raw(`${sortCol} ${sortDir}`);

  const countResult = await db.execute(sql`
    SELECT count(*)::int AS total
    FROM orders.work_orders wo
    WHERE wo.tenant_id = ${tenantId}
      AND wo.status = 'completed'
      AND wo.actual_start_date IS NOT NULL
      AND wo.actual_end_date IS NOT NULL
      AND wo.actual_end_date >= ${startDate.toISOString()}::timestamptz
      AND wo.actual_end_date < ${endDate.toISOString()}::timestamptz
      ${facilityFilter}
  `);
  const totalRows = (countResult as unknown as Array<{ total: number }>)[0]?.total ?? 0;

  const result = await db.execute(sql`
    SELECT
      wo.wo_number AS "woNumber",
      p.name AS "partName",
      f.name AS "facilityName",
      wo.actual_start_date AS "actualStartDate",
      wo.actual_end_date AS "actualEndDate",
      round(EXTRACT(EPOCH FROM (wo.actual_end_date - wo.actual_start_date))::numeric / 3600, 2)::float AS "cycleTimeHours"
    FROM orders.work_orders wo
    JOIN catalog.parts p ON p.id = wo.part_id AND p.tenant_id = ${tenantId}
    LEFT JOIN locations.facilities f ON f.id = wo.facility_id AND f.tenant_id = ${tenantId}
    WHERE wo.tenant_id = ${tenantId}
      AND wo.status = 'completed'
      AND wo.actual_start_date IS NOT NULL
      AND wo.actual_end_date IS NOT NULL
      AND wo.actual_end_date >= ${startDate.toISOString()}::timestamptz
      AND wo.actual_end_date < ${endDate.toISOString()}::timestamptz
      ${facilityFilter}
    ORDER BY ${orderClause}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    kpiId: 'avg_cycle_time',
    columns: DRILLDOWN_COLUMNS.avg_cycle_time,
    rows: result as unknown as Record<string, unknown>[],
    totalRows,
    page,
    limit,
  };
}

// ─── Order Accuracy Drilldown ─────────────────────────────────────────

async function drilldownOrderAccuracy(filters: DrilldownFilters): Promise<DrilldownResult> {
  const { tenantId, startDate, endDate, facilityIds, page, limit, sort, sortDir } = filters;
  const offset = (page - 1) * limit;

  const facilityFilter = facilityIds?.length
    ? sql` AND r.order_id IN (
        SELECT id FROM orders.purchase_orders WHERE tenant_id = ${tenantId} AND facility_id = ANY(${facilityIds})
        UNION ALL
        SELECT id FROM orders.transfer_orders WHERE tenant_id = ${tenantId} AND destination_facility_id = ANY(${facilityIds})
      )`
    : sql``;

  const sortCol = resolveSortColumn('order_accuracy', sort);
  const orderClause = sql.raw(`${sortCol} ${sortDir}`);

  const countResult = await db.execute(sql`
    SELECT count(*)::int AS total
    FROM orders.receipt_lines rl
    JOIN orders.receipts r ON r.id = rl.receipt_id
    WHERE rl.tenant_id = ${tenantId}
      AND r.created_at >= ${startDate.toISOString()}::timestamptz
      AND r.created_at < ${endDate.toISOString()}::timestamptz
      ${facilityFilter}
  `);
  const totalRows = (countResult as unknown as Array<{ total: number }>)[0]?.total ?? 0;

  const result = await db.execute(sql`
    SELECT
      r.receipt_number AS "receiptNumber",
      p.part_number AS "partNumber",
      p.name AS "partName",
      rl.quantity_expected AS "quantityExpected",
      rl.quantity_accepted AS "quantityAccepted",
      rl.quantity_damaged AS "quantityDamaged",
      rl.quantity_rejected AS "quantityRejected",
      (rl.quantity_damaged = 0 AND rl.quantity_rejected = 0) AS "isAccurate",
      r.created_at AS "createdAt"
    FROM orders.receipt_lines rl
    JOIN orders.receipts r ON r.id = rl.receipt_id
    JOIN catalog.parts p ON p.id = rl.part_id AND p.tenant_id = ${tenantId}
    WHERE rl.tenant_id = ${tenantId}
      AND r.created_at >= ${startDate.toISOString()}::timestamptz
      AND r.created_at < ${endDate.toISOString()}::timestamptz
      ${facilityFilter}
    ORDER BY ${orderClause}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    kpiId: 'order_accuracy',
    columns: DRILLDOWN_COLUMNS.order_accuracy,
    rows: result as unknown as Record<string, unknown>[],
    totalRows,
    page,
    limit,
  };
}

// ─── Drilldown Dispatch ───────────────────────────────────────────────

const KPI_DRILLDOWN_FNS: Record<string, (filters: DrilldownFilters) => Promise<DrilldownResult>> = {
  fill_rate: drilldownFillRate,
  supplier_otd: drilldownSupplierOtd,
  stockout_count: drilldownStockoutCount,
  avg_cycle_time: drilldownAvgCycleTime,
  order_accuracy: drilldownOrderAccuracy,
};

export async function computeKpiDrilldown(filters: DrilldownFilters): Promise<DrilldownResult> {
  const { kpiId } = filters;
  const startTime = Date.now();

  const drilldownFn = KPI_DRILLDOWN_FNS[kpiId];
  if (!drilldownFn) {
    throw new KpiNotFoundError(kpiId);
  }

  const result = await drilldownFn(filters);

  const durationMs = Date.now() - startTime;
  log.info(
    { tenantId: filters.tenantId, kpiId, totalRows: result.totalRows, page: filters.page, durationMs },
    'KPI drilldown computation complete',
  );

  return result;
}

export { DRILLDOWN_COLUMNS };
