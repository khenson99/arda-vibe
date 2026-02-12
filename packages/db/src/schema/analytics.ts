import {
  pgSchema,
  uuid,
  varchar,
  timestamp,
  numeric,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const analyticsSchema = pgSchema('analytics');

// ─── KPI Snapshots ───────────────────────────────────────────────────
// Time-series snapshots of key performance indicators.
// Supports both facility-specific and all-facility aggregations.
export const kpiSnapshots = analyticsSchema.table(
  'kpi_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    facilityId: uuid('facility_id'), // NULL = all-facility aggregate
    kpiName: varchar('kpi_name', { length: 100 }).notNull(), // 'inventory_turns', 'fill_rate', 'stockout_frequency', 'cycle_time', 'supplier_otd'
    value: numeric('value', { precision: 12, scale: 4 }).notNull(),
    unit: varchar('unit', { length: 50 }), // 'ratio', 'percentage', 'days', 'count', etc.
    timeGranularity: varchar('time_granularity', { length: 20 }).notNull(), // 'hour', 'day', 'week', 'month'
    snapshotStart: timestamp('snapshot_start', { withTimezone: true }).notNull(), // start of the time window
    snapshotEnd: timestamp('snapshot_end', { withTimezone: true }).notNull(), // end of the time window
    metadata: jsonb('metadata').$type<KPISnapshotMetadata>().default({}), // calculation details, sample size, etc.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('kpi_snapshots_tenant_idx').on(table.tenantId),
    index('kpi_snapshots_facility_idx').on(table.facilityId),
    index('kpi_snapshots_kpi_idx').on(table.tenantId, table.kpiName),
    index('kpi_snapshots_time_idx').on(table.snapshotStart, table.snapshotEnd),
    index('kpi_snapshots_composite_idx').on(
      table.tenantId,
      table.facilityId,
      table.kpiName,
      table.timeGranularity,
      table.snapshotStart
    ),
  ]
);

export interface KPISnapshotMetadata {
  sampleSize?: number; // number of data points used
  calculationMethod?: string; // description of how the KPI was calculated
  aggregationType?: 'sum' | 'avg' | 'median' | 'max' | 'min' | 'count';
  confidence?: number; // 0-100, if applicable
  drilldownAvailable?: boolean;
  notes?: string;
  [key: string]: unknown; // allow for KPI-specific metadata
}
