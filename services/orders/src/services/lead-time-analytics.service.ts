/**
 * Lead Time Analytics Service (Ticket #154)
 *
 * Provides aggregate statistics and trend analysis for transfer order lead times.
 * Used by queue scoring/prioritization and dashboard/reporting.
 *
 * Endpoints:
 * - Aggregate stats: avg, median, p90, min, max, transfer count
 * - Time-series trends: suitable for charting lead time evolution
 *
 * ─── Performance Requirements (NFR) ─────────────────────────────────
 *
 * Target latency (p95): < 1s for 10,000 history rows
 *
 * Optimization strategy:
 *   1. Use indexed columns (tenant_id, source/dest facility, part_id)
 *   2. Percentile calculations use PERCENTILE_CONT for statistical accuracy
 *   3. Date-range filters expected on most calls (default 90 days)
 *   4. Consider adding composite index for route-specific queries:
 *      (tenant_id, source_facility_id, destination_facility_id, received_at)
 *
 * Data volume assumptions (MVP):
 *   - < 50,000 lead time history records per tenant
 *   - Date-range filter applied on most queries
 * ────────────────────────────────────────────────────────────────────
 */

import { db, schema } from '@arda/db';
import { eq, and, sql, gte, lte } from 'drizzle-orm';
import { createLogger } from '@arda/config';

const log = createLogger('lead-time-analytics');

const { leadTimeHistory } = schema;

// ─── Types ────────────────────────────────────────────────────────────

export interface LeadTimeAggregateQuery {
  tenantId: string;
  sourceFacilityId?: string;
  destinationFacilityId?: string;
  partId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface LeadTimeAggregateStats {
  avgLeadTimeDays: number;
  medianLeadTimeDays: number;
  p90LeadTimeDays: number;
  minLeadTimeDays: number;
  maxLeadTimeDays: number;
  transferCount: number;
}

export interface LeadTimeTrendQuery {
  tenantId: string;
  sourceFacilityId?: string;
  destinationFacilityId?: string;
  partId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Grouping granularity: day, week, month. Defaults to week. */
  granularity?: 'day' | 'week' | 'month';
}

export interface LeadTimeTrendDataPoint {
  period: string;
  avgLeadTimeDays: number;
  minLeadTimeDays: number;
  maxLeadTimeDays: number;
  transferCount: number;
}

// ─── Filter Builder ──────────────────────────────────────────────────

function buildLeadTimeConditions(query: LeadTimeAggregateQuery) {
  const conditions = [eq(leadTimeHistory.tenantId, query.tenantId)];

  if (query.sourceFacilityId) {
    conditions.push(eq(leadTimeHistory.sourceFacilityId, query.sourceFacilityId));
  }
  if (query.destinationFacilityId) {
    conditions.push(eq(leadTimeHistory.destinationFacilityId, query.destinationFacilityId));
  }
  if (query.partId) {
    conditions.push(eq(leadTimeHistory.partId, query.partId));
  }
  if (query.dateFrom) {
    conditions.push(gte(leadTimeHistory.receivedAt, new Date(query.dateFrom)));
  }
  if (query.dateTo) {
    conditions.push(lte(leadTimeHistory.receivedAt, new Date(query.dateTo)));
  }

  return conditions;
}

// ─── Aggregate Statistics ────────────────────────────────────────────

/**
 * Calculate aggregate lead time statistics.
 *
 * Statistical notes:
 * - Median: PERCENTILE_CONT(0.5) provides continuous interpolation
 * - P90: PERCENTILE_CONT(0.9) for the 90th percentile
 * - All percentiles use WITHIN GROUP (ORDER BY) for correct ordering
 * - Results are rounded to 2 decimal places for consistency
 */
export async function getLeadTimeAggregateStats(
  query: LeadTimeAggregateQuery
): Promise<LeadTimeAggregateStats> {
  const conditions = buildLeadTimeConditions(query);

  const [result] = await db
    .select({
      avgLeadTimeDays: sql<number>`
        COALESCE(
          ROUND(AVG(${leadTimeHistory.leadTimeDays})::numeric, 2),
          0
        )
      `,
      medianLeadTimeDays: sql<number>`
        COALESCE(
          ROUND(
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${leadTimeHistory.leadTimeDays})::numeric,
            2
          ),
          0
        )
      `,
      p90LeadTimeDays: sql<number>`
        COALESCE(
          ROUND(
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${leadTimeHistory.leadTimeDays})::numeric,
            2
          ),
          0
        )
      `,
      minLeadTimeDays: sql<number>`
        COALESCE(
          ROUND(MIN(${leadTimeHistory.leadTimeDays})::numeric, 2),
          0
        )
      `,
      maxLeadTimeDays: sql<number>`
        COALESCE(
          ROUND(MAX(${leadTimeHistory.leadTimeDays})::numeric, 2),
          0
        )
      `,
      transferCount: sql<number>`COUNT(*)::int`,
    })
    .from(leadTimeHistory)
    .where(and(...conditions))
    .execute();

  return {
    avgLeadTimeDays: Number(result.avgLeadTimeDays),
    medianLeadTimeDays: Number(result.medianLeadTimeDays),
    p90LeadTimeDays: Number(result.p90LeadTimeDays),
    minLeadTimeDays: Number(result.minLeadTimeDays),
    maxLeadTimeDays: Number(result.maxLeadTimeDays),
    transferCount: result.transferCount,
  };
}

// ─── Trend Time Series ───────────────────────────────────────────────

/**
 * Generate time-series trend data for charting.
 *
 * Groups by the specified granularity (day, week, month) and returns
 * aggregates per period. Suitable for line/bar charts showing lead time
 * evolution over time.
 *
 * Date truncation uses PostgreSQL's date_trunc function:
 * - 'day': YYYY-MM-DD
 * - 'week': Monday of the week (ISO week)
 * - 'month': First day of the month
 */
export async function getLeadTimeTrend(
  query: LeadTimeTrendQuery
): Promise<LeadTimeTrendDataPoint[]> {
  const { granularity = 'week', ...baseQuery } = query;
  const conditions = buildLeadTimeConditions(baseQuery);

  // Map granularity to date_trunc argument
  const truncArg = granularity === 'day' ? 'day' : granularity === 'month' ? 'month' : 'week';

  const results = await db
    .select({
      period: sql<string>`
        TO_CHAR(DATE_TRUNC(${truncArg}, ${leadTimeHistory.receivedAt}), 'YYYY-MM-DD')
      `,
      avgLeadTimeDays: sql<number>`
        ROUND(AVG(${leadTimeHistory.leadTimeDays})::numeric, 2)
      `,
      minLeadTimeDays: sql<number>`
        ROUND(MIN(${leadTimeHistory.leadTimeDays})::numeric, 2)
      `,
      maxLeadTimeDays: sql<number>`
        ROUND(MAX(${leadTimeHistory.leadTimeDays})::numeric, 2)
      `,
      transferCount: sql<number>`COUNT(*)::int`,
    })
    .from(leadTimeHistory)
    .where(and(...conditions))
    .groupBy(sql`DATE_TRUNC(${truncArg}, ${leadTimeHistory.receivedAt})`)
    .orderBy(sql`DATE_TRUNC(${truncArg}, ${leadTimeHistory.receivedAt}) ASC`)
    .execute();

  return results.map((row) => ({
    period: row.period,
    avgLeadTimeDays: Number(row.avgLeadTimeDays),
    minLeadTimeDays: Number(row.minLeadTimeDays),
    maxLeadTimeDays: Number(row.maxLeadTimeDays),
    transferCount: row.transferCount,
  }));
}
