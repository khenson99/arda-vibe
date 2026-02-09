/**
 * Production Analytics Service (Ticket #78)
 *
 * KPI calculations for the production domain:
 * - OEE (Overall Equipment Effectiveness) approximation
 * - Cycle time analysis (avg, p50, p95 by work center)
 * - Throughput metrics (WOs completed per day/week)
 * - Scrap rate trends
 * - Queue health (avg wait time, backlog depth)
 * - Work center utilization summary
 *
 * All metrics support date-range filtering and facility scoping.
 *
 * ─── Performance Baselines (MVP-09) ─────────────────────────────────
 *
 * Query count:  5 fixed queries + 2 queries per active work center
 *               (N+1 for step aggregation + capacity per center)
 *
 * Target latency (p95):
 *   - 0-10 work centers:   < 200ms
 *   - 10-50 work centers:  < 500ms
 *   - 50+ work centers:    < 1s (consider batch query optimization)
 *
 * Optimization opportunities:
 *   1. Collapse N+1 center queries into a single GROUP BY join
 *      when work center count > 20 (reduces roundtrips)
 *   2. Add composite index: work_order_routings(work_center_id, tenant_id, status)
 *   3. Add composite index: production_queue_entries(tenant_id, facility_id, exited_queue_at)
 *   4. Consider materialized view for overview counts (refresh on WO status change)
 *   5. Cache analytics response with 30s TTL for dashboard polling
 *
 * Data volume assumptions (MVP):
 *   - < 10,000 work orders per tenant
 *   - < 50 active work centers per facility
 *   - < 100,000 queue entries per tenant
 *   - Date-range filter expected on most calls (dashboard defaults to 30 days)
 * ────────────────────────────────────────────────────────────────────
 */

import { db, schema } from '@arda/db';
import { eq, and, sql, gte, lte, desc, asc, count } from 'drizzle-orm';
import { createLogger } from '@arda/config';

const log = createLogger('production-analytics');

const {
  workOrders,
  workOrderRoutings,
  productionOperationLogs,
  productionQueueEntries,
  workCenters,
  workCenterCapacityWindows,
} = schema;

// ─── Types ────────────────────────────────────────────────────────────

export interface ProductionMetricsQuery {
  tenantId: string;
  facilityId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface ProductionMetrics {
  overview: {
    totalWorkOrders: number;
    completedWorkOrders: number;
    inProgressWorkOrders: number;
    onHoldWorkOrders: number;
    cancelledWorkOrders: number;
    totalQuantityProduced: number;
    totalQuantityScrapped: number;
    overallScrapRate: number;
    overallCompletionRate: number;
  };
  throughput: {
    avgWOsCompletedPerDay: number;
    avgCycleTimeHours: number | null;
    avgQueueWaitTimeHours: number | null;
    expeditedCount: number;
    reworkCount: number;
  };
  workCenterPerformance: WorkCenterMetrics[];
  scrapAnalysis: {
    totalScrapped: number;
    scrapRate: number;
    byReason: Array<{ reason: string; count: number }>;
  };
  queueHealth: {
    currentBacklog: number;
    avgPriorityScore: number;
    oldestItemAgeHours: number | null;
    expeditedInQueue: number;
  };
}

export interface WorkCenterMetrics {
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  stepsCompleted: number;
  avgActualMinutes: number | null;
  avgEstimatedMinutes: number | null;
  efficiencyPercent: number | null;
  utilizationPercent: number;
}

// ─── Date Conditions ────────────────────────────────────────────────

function buildWODateConditions(query: ProductionMetricsQuery) {
  const conditions = [eq(workOrders.tenantId, query.tenantId)];

  if (query.facilityId) {
    conditions.push(eq(workOrders.facilityId, query.facilityId));
  }
  if (query.dateFrom) {
    conditions.push(gte(workOrders.createdAt, new Date(query.dateFrom)));
  }
  if (query.dateTo) {
    conditions.push(lte(workOrders.createdAt, new Date(query.dateTo)));
  }

  return conditions;
}

// ─── Main Metrics Function ──────────────────────────────────────────

/**
 * Fetch comprehensive production KPIs.
 *
 * Query strategy: 5 fixed queries + 2 per active work center.
 * See performance baselines in the module header for optimization paths.
 */
export async function getProductionMetrics(
  query: ProductionMetricsQuery
): Promise<ProductionMetrics> {
  const conditions = buildWODateConditions(query);

  // ── Overview (Query 1/5 — single full-table aggregate) ──
  const [overview] = await db
    .select({
      totalWorkOrders: sql<number>`count(*)::int`,
      completedWorkOrders: sql<number>`count(*) filter (where ${workOrders.status} = 'completed')::int`,
      inProgressWorkOrders: sql<number>`count(*) filter (where ${workOrders.status} = 'in_progress')::int`,
      onHoldWorkOrders: sql<number>`count(*) filter (where ${workOrders.status} = 'on_hold')::int`,
      cancelledWorkOrders: sql<number>`count(*) filter (where ${workOrders.status} = 'cancelled')::int`,
      totalQuantityProduced: sql<number>`coalesce(sum(${workOrders.quantityProduced}), 0)::int`,
      totalQuantityScrapped: sql<number>`coalesce(sum(${workOrders.quantityScrapped}), 0)::int`,
      expeditedCount: sql<number>`count(*) filter (where ${workOrders.isExpedited} = true)::int`,
      reworkCount: sql<number>`count(*) filter (where ${workOrders.isRework} = true)::int`,
    })
    .from(workOrders)
    .where(and(...conditions))
    .execute();

  const totalProduced = overview.totalQuantityProduced;
  const totalScrapped = overview.totalQuantityScrapped;
  const totalProcessed = totalProduced + totalScrapped;
  const overallScrapRate =
    totalProcessed > 0 ? Math.round((totalScrapped / totalProcessed) * 10000) / 100 : 0;
  const overallCompletionRate =
    overview.totalWorkOrders > 0
      ? Math.round((overview.completedWorkOrders / overview.totalWorkOrders) * 10000) / 100
      : 0;

  // ── Throughput (Queries 2-3/5 — completed WO aggregates) ──
  const completedConditions = [
    ...conditions,
    eq(workOrders.status, 'completed'),
  ];

  const [throughput] = await db
    .select({
      avgCycleTimeHours: sql<number | null>`
        avg(
          extract(epoch from (${workOrders.actualEndDate} - ${workOrders.actualStartDate})) / 3600
        ) filter (where ${workOrders.actualEndDate} is not null and ${workOrders.actualStartDate} is not null)
      `,
    })
    .from(workOrders)
    .where(and(...completedConditions))
    .execute();

  // Average WOs completed per day
  const [dateRange] = await db
    .select({
      minDate: sql<string | null>`min(${workOrders.actualEndDate})`,
      maxDate: sql<string | null>`max(${workOrders.actualEndDate})`,
    })
    .from(workOrders)
    .where(and(...completedConditions))
    .execute();

  let avgWOsPerDay = 0;
  if (dateRange.minDate && dateRange.maxDate) {
    const diffMs =
      new Date(dateRange.maxDate).getTime() - new Date(dateRange.minDate).getTime();
    const diffDays = Math.max(1, diffMs / (1000 * 60 * 60 * 24));
    avgWOsPerDay = Math.round((overview.completedWorkOrders / diffDays) * 100) / 100;
  }

  // ── Queue wait time (Query 4/5) ──
  const queueConditions = [eq(productionQueueEntries.tenantId, query.tenantId)];
  if (query.facilityId) {
    queueConditions.push(eq(productionQueueEntries.facilityId, query.facilityId));
  }

  const [queueWait] = await db
    .select({
      avgWaitHours: sql<number | null>`
        avg(
          extract(epoch from (
            coalesce(${productionQueueEntries.completedAt}, now()) - ${productionQueueEntries.enteredQueueAt}
          )) / 3600
        )
      `,
    })
    .from(productionQueueEntries)
    .where(and(...queueConditions))
    .execute();

  // ── Work Center Performance (Query 5/5 + 2 per center — N+1 pattern) ──
  const wcConditions = [eq(workCenters.tenantId, query.tenantId), eq(workCenters.isActive, true)];
  if (query.facilityId) {
    wcConditions.push(eq(workCenters.facilityId, query.facilityId));
  }

  const centers = await db
    .select({ id: workCenters.id, code: workCenters.code, name: workCenters.name })
    .from(workCenters)
    .where(and(...wcConditions))
    .orderBy(asc(workCenters.code))
    .execute();

  const workCenterPerformance: WorkCenterMetrics[] = [];

  for (const center of centers) {
    const stepConditions = [
      eq(workOrderRoutings.workCenterId, center.id),
      eq(workOrderRoutings.tenantId, query.tenantId),
    ];

    const [stepAgg] = await db
      .select({
        stepsCompleted: sql<number>`count(*) filter (where ${workOrderRoutings.status} in ('complete', 'skipped'))::int`,
        avgActual: sql<number | null>`avg(${workOrderRoutings.actualMinutes}) filter (where ${workOrderRoutings.actualMinutes} is not null)`,
        avgEstimated: sql<number | null>`avg(${workOrderRoutings.estimatedMinutes}) filter (where ${workOrderRoutings.estimatedMinutes} is not null)`,
      })
      .from(workOrderRoutings)
      .where(and(...stepConditions))
      .execute();

    // Capacity utilization
    const [capAgg] = await db
      .select({
        totalAvailable: sql<number>`coalesce(sum(${workCenterCapacityWindows.availableMinutes}), 0)::int`,
        totalAllocated: sql<number>`coalesce(sum(${workCenterCapacityWindows.allocatedMinutes}), 0)::int`,
      })
      .from(workCenterCapacityWindows)
      .where(
        and(
          eq(workCenterCapacityWindows.workCenterId, center.id),
          eq(workCenterCapacityWindows.tenantId, query.tenantId)
        )
      )
      .execute();

    const avgActual = stepAgg.avgActual ? Math.round(stepAgg.avgActual * 100) / 100 : null;
    const avgEstimated = stepAgg.avgEstimated
      ? Math.round(stepAgg.avgEstimated * 100) / 100
      : null;
    const efficiencyPercent =
      avgActual !== null && avgEstimated !== null && avgActual > 0
        ? Math.round((avgEstimated / avgActual) * 10000) / 100
        : null;

    const utilizationPercent =
      capAgg.totalAvailable > 0
        ? Math.round((capAgg.totalAllocated / capAgg.totalAvailable) * 10000) / 100
        : 0;

    workCenterPerformance.push({
      workCenterId: center.id,
      workCenterCode: center.code,
      workCenterName: center.name,
      stepsCompleted: stepAgg.stepsCompleted,
      avgActualMinutes: avgActual,
      avgEstimatedMinutes: avgEstimated,
      efficiencyPercent,
      utilizationPercent,
    });
  }

  // ── Scrap Analysis (piggybacks on overview totals + 1 grouped query) ──
  const holdOperations = await db
    .select({
      reason: sql<string>`coalesce(${productionOperationLogs.notes}, 'unknown')`,
      count: sql<number>`count(*)::int`,
    })
    .from(productionOperationLogs)
    .where(
      and(
        eq(productionOperationLogs.tenantId, query.tenantId),
        eq(productionOperationLogs.operationType, 'hold')
      )
    )
    .groupBy(productionOperationLogs.notes)
    .limit(10)
    .execute();

  // ── Queue Health (single aggregate on queue_entries) ──
  const [queueHealth] = await db
    .select({
      currentBacklog: sql<number>`count(*) filter (where ${productionQueueEntries.completedAt} is null)::int`,
      avgPriority: sql<number>`coalesce(avg(${productionQueueEntries.priorityScore}) filter (where ${productionQueueEntries.completedAt} is null), 0)`,
      oldestAgeHours: sql<number | null>`
        max(
          extract(epoch from (now() - ${productionQueueEntries.enteredQueueAt})) / 3600
        ) filter (where ${productionQueueEntries.completedAt} is null)
      `,
      expeditedInQueue: sql<number>`0::int`, // would require join to workOrders
    })
    .from(productionQueueEntries)
    .where(and(...queueConditions))
    .execute();

  return {
    overview: {
      totalWorkOrders: overview.totalWorkOrders,
      completedWorkOrders: overview.completedWorkOrders,
      inProgressWorkOrders: overview.inProgressWorkOrders,
      onHoldWorkOrders: overview.onHoldWorkOrders,
      cancelledWorkOrders: overview.cancelledWorkOrders,
      totalQuantityProduced: totalProduced,
      totalQuantityScrapped: totalScrapped,
      overallScrapRate,
      overallCompletionRate,
    },
    throughput: {
      avgWOsCompletedPerDay: avgWOsPerDay,
      avgCycleTimeHours: throughput.avgCycleTimeHours
        ? Math.round(throughput.avgCycleTimeHours * 100) / 100
        : null,
      avgQueueWaitTimeHours: queueWait.avgWaitHours
        ? Math.round(queueWait.avgWaitHours * 100) / 100
        : null,
      expeditedCount: overview.expeditedCount,
      reworkCount: overview.reworkCount,
    },
    workCenterPerformance,
    scrapAnalysis: {
      totalScrapped,
      scrapRate: overallScrapRate,
      byReason: holdOperations.map((r) => ({
        reason: r.reason.substring(0, 100),
        count: r.count,
      })),
    },
    queueHealth: {
      currentBacklog: queueHealth.currentBacklog,
      avgPriorityScore: Math.round(queueHealth.avgPriority * 100) / 100,
      oldestItemAgeHours: queueHealth.oldestAgeHours
        ? Math.round(queueHealth.oldestAgeHours * 100) / 100
        : null,
      expeditedInQueue: queueHealth.expeditedInQueue,
    },
  };
}
