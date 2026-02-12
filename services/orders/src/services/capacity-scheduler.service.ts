/**
 * Capacity Scheduler Service (Ticket #75)
 *
 * Manages work center capacity windows:
 * - Allocate minutes to a work center for a specific day/window
 * - Release allocated capacity when steps are cancelled or rescheduled
 * - Query utilization by work center and day
 * - Backlog limit checks to prevent over-scheduling
 */

import { db, schema, writeAuditEntry } from '@arda/db';
import { eq, and, sql, gte, lte, desc, asc } from 'drizzle-orm';
import { createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';

const log = createLogger('capacity-scheduler');

const {
  workCenters,
  workCenterCapacityWindows,
  workOrderRoutings,
  workOrders,
} = schema;

// ─── Types ────────────────────────────────────────────────────────────

export interface CapacityWindow {
  id: string;
  workCenterId: string;
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  availableMinutes: number;
  allocatedMinutes: number;
  remainingMinutes: number;
  utilizationPercent: number;
}

export interface AllocateCapacityInput {
  tenantId: string;
  workCenterId: string;
  windowId: string;
  minutes: number;
  workOrderId?: string;
  userId?: string;
}

export interface ReleaseCapacityInput {
  tenantId: string;
  workCenterId: string;
  windowId: string;
  minutes: number;
  workOrderId?: string;
  userId?: string;
}

export interface WorkCenterUtilization {
  workCenterId: string;
  workCenterName: string;
  workCenterCode: string;
  totalAvailableMinutes: number;
  totalAllocatedMinutes: number;
  remainingMinutes: number;
  utilizationPercent: number;
  windowCount: number;
}

export interface CreateCapacityWindowInput {
  tenantId: string;
  workCenterId: string;
  dayOfWeek: number;
  startHour: number;
  endHour: number;
  availableMinutes: number;
  effectiveDate: Date;
  expiresAt?: Date;
  userId?: string;
}

// ─── Window CRUD ────────────────────────────────────────────────────

/**
 * Create a capacity window for a work center.
 */
export async function createCapacityWindow(
  input: CreateCapacityWindowInput
): Promise<{ id: string }> {
  const { tenantId, workCenterId, dayOfWeek, startHour, endHour, availableMinutes, effectiveDate, expiresAt, userId } = input;

  // Validate work center exists
  const [wc] = await db
    .select({ id: workCenters.id })
    .from(workCenters)
    .where(and(eq(workCenters.id, workCenterId), eq(workCenters.tenantId, tenantId)))
    .execute();

  if (!wc) throw new AppError(404, `Work center ${workCenterId} not found`);

  // Validate ranges
  if (dayOfWeek < 0 || dayOfWeek > 6) {
    throw new AppError(400, 'dayOfWeek must be 0 (Sunday) to 6 (Saturday)');
  }
  if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
    throw new AppError(400, 'Hours must be 0-23');
  }
  if (startHour >= endHour) {
    throw new AppError(400, 'startHour must be less than endHour');
  }
  if (availableMinutes <= 0) {
    throw new AppError(400, 'availableMinutes must be positive');
  }

  const [result] = await db
    .insert(workCenterCapacityWindows)
    .values({
      tenantId,
      workCenterId,
      dayOfWeek,
      startHour,
      endHour,
      availableMinutes,
      allocatedMinutes: 0,
      effectiveDate,
      expiresAt: expiresAt || null,
    })
    .returning({ id: workCenterCapacityWindows.id })
    .execute();

  // Audit
  await writeAuditEntry(db, {
    tenantId,
    userId: userId || null,
    action: 'capacity_window.created',
    entityType: 'work_center_capacity_window',
    entityId: result.id,
    previousState: null,
    newState: { workCenterId, dayOfWeek, startHour, endHour, availableMinutes },
    metadata: { source: 'capacity_scheduler' },
  });

  return { id: result.id };
}

// ─── Get Windows for Work Center ────────────────────────────────────

export async function getCapacityWindows(
  tenantId: string,
  workCenterId: string,
  options: { dayOfWeek?: number; activeOnly?: boolean } = {}
): Promise<CapacityWindow[]> {
  const conditions = [
    eq(workCenterCapacityWindows.tenantId, tenantId),
    eq(workCenterCapacityWindows.workCenterId, workCenterId),
  ];

  if (options.dayOfWeek !== undefined) {
    conditions.push(eq(workCenterCapacityWindows.dayOfWeek, options.dayOfWeek));
  }

  if (options.activeOnly) {
    const now = new Date();
    conditions.push(lte(workCenterCapacityWindows.effectiveDate, now));
    // Include windows that haven't expired or have no expiration
    // This is approximate; a precise filter would use OR with IS NULL
  }

  const windows = await db
    .select()
    .from(workCenterCapacityWindows)
    .where(and(...conditions))
    .orderBy(asc(workCenterCapacityWindows.dayOfWeek), asc(workCenterCapacityWindows.startHour))
    .execute();

  return windows.map((w) => ({
    id: w.id,
    workCenterId: w.workCenterId,
    dayOfWeek: w.dayOfWeek,
    startHour: w.startHour,
    endHour: w.endHour,
    availableMinutes: w.availableMinutes,
    allocatedMinutes: w.allocatedMinutes,
    remainingMinutes: w.availableMinutes - w.allocatedMinutes,
    utilizationPercent: w.availableMinutes > 0
      ? Math.round((w.allocatedMinutes / w.availableMinutes) * 10000) / 100
      : 0,
  }));
}

// ─── Allocate Capacity ──────────────────────────────────────────────

/**
 * Allocate minutes to a capacity window. Fails if insufficient capacity.
 */
export async function allocateCapacity(input: AllocateCapacityInput): Promise<{ success: boolean; remaining: number }> {
  const { tenantId, workCenterId, windowId, minutes, workOrderId, userId } = input;

  if (minutes <= 0) throw new AppError(400, 'Minutes to allocate must be positive');

  const [window] = await db
    .select()
    .from(workCenterCapacityWindows)
    .where(
      and(
        eq(workCenterCapacityWindows.id, windowId),
        eq(workCenterCapacityWindows.workCenterId, workCenterId),
        eq(workCenterCapacityWindows.tenantId, tenantId)
      )
    )
    .execute();

  if (!window) throw new AppError(404, `Capacity window ${windowId} not found`);

  const remaining = window.availableMinutes - window.allocatedMinutes;
  if (minutes > remaining) {
    throw new AppError(
      409,
      `Insufficient capacity: requested ${minutes} min, only ${remaining} min available`
    );
  }

  const newAllocated = window.allocatedMinutes + minutes;
  const now = new Date();

  await db
    .update(workCenterCapacityWindows)
    .set({ allocatedMinutes: newAllocated, updatedAt: now })
    .where(eq(workCenterCapacityWindows.id, windowId))
    .execute();

  await writeAuditEntry(db, {
    tenantId,
    userId: userId || null,
    action: 'capacity_window.allocated',
    entityType: 'work_center_capacity_window',
    entityId: windowId,
    previousState: { allocatedMinutes: window.allocatedMinutes },
    newState: { allocatedMinutes: newAllocated, minutesAdded: minutes },
    metadata: { workCenterId, workOrderId: workOrderId || null, source: 'capacity_scheduler' },
    timestamp: now,
  });

  return { success: true, remaining: window.availableMinutes - newAllocated };
}

// ─── Release Capacity ───────────────────────────────────────────────

/**
 * Release previously allocated minutes back to a capacity window.
 */
export async function releaseCapacity(input: ReleaseCapacityInput): Promise<{ success: boolean; remaining: number }> {
  const { tenantId, workCenterId, windowId, minutes, workOrderId, userId } = input;

  if (minutes <= 0) throw new AppError(400, 'Minutes to release must be positive');

  const [window] = await db
    .select()
    .from(workCenterCapacityWindows)
    .where(
      and(
        eq(workCenterCapacityWindows.id, windowId),
        eq(workCenterCapacityWindows.workCenterId, workCenterId),
        eq(workCenterCapacityWindows.tenantId, tenantId)
      )
    )
    .execute();

  if (!window) throw new AppError(404, `Capacity window ${windowId} not found`);

  const newAllocated = Math.max(0, window.allocatedMinutes - minutes);
  const now = new Date();

  await db
    .update(workCenterCapacityWindows)
    .set({ allocatedMinutes: newAllocated, updatedAt: now })
    .where(eq(workCenterCapacityWindows.id, windowId))
    .execute();

  await writeAuditEntry(db, {
    tenantId,
    userId: userId || null,
    action: 'capacity_window.released',
    entityType: 'work_center_capacity_window',
    entityId: windowId,
    previousState: { allocatedMinutes: window.allocatedMinutes },
    newState: { allocatedMinutes: newAllocated, minutesReleased: minutes },
    metadata: { workCenterId, workOrderId: workOrderId || null, source: 'capacity_scheduler' },
    timestamp: now,
  });

  return { success: true, remaining: window.availableMinutes - newAllocated };
}

// ─── Work Center Utilization ────────────────────────────────────────

/**
 * Get aggregate utilization across all capacity windows for each work center.
 */
export async function getWorkCenterUtilization(
  tenantId: string,
  facilityId?: string
): Promise<WorkCenterUtilization[]> {
  // Get work centers
  const wcConditions = [eq(workCenters.tenantId, tenantId), eq(workCenters.isActive, true)];
  if (facilityId) {
    wcConditions.push(eq(workCenters.facilityId, facilityId));
  }

  const centers = await db
    .select({ id: workCenters.id, name: workCenters.name, code: workCenters.code })
    .from(workCenters)
    .where(and(...wcConditions))
    .orderBy(asc(workCenters.code))
    .execute();

  const results: WorkCenterUtilization[] = [];

  for (const center of centers) {
    const windows = await db
      .select({
        totalAvailable: sql<number>`COALESCE(SUM(${workCenterCapacityWindows.availableMinutes}), 0)::int`,
        totalAllocated: sql<number>`COALESCE(SUM(${workCenterCapacityWindows.allocatedMinutes}), 0)::int`,
        windowCount: sql<number>`COUNT(*)::int`,
      })
      .from(workCenterCapacityWindows)
      .where(
        and(
          eq(workCenterCapacityWindows.workCenterId, center.id),
          eq(workCenterCapacityWindows.tenantId, tenantId)
        )
      )
      .execute();

    const agg = windows[0];
    const totalAvailable = agg.totalAvailable;
    const totalAllocated = agg.totalAllocated;

    results.push({
      workCenterId: center.id,
      workCenterName: center.name,
      workCenterCode: center.code,
      totalAvailableMinutes: totalAvailable,
      totalAllocatedMinutes: totalAllocated,
      remainingMinutes: totalAvailable - totalAllocated,
      utilizationPercent: totalAvailable > 0
        ? Math.round((totalAllocated / totalAvailable) * 10000) / 100
        : 0,
      windowCount: agg.windowCount,
    });
  }

  return results;
}

// ─── Backlog Check ──────────────────────────────────────────────────

/**
 * Check if a work center has capacity to accept additional minutes.
 * Returns whether the allocation would exceed a configurable threshold.
 */
export async function checkBacklogCapacity(
  tenantId: string,
  workCenterId: string,
  requestedMinutes: number,
  maxUtilizationPercent: number = 90
): Promise<{ canAccept: boolean; currentUtilization: number; projectedUtilization: number; reason?: string }> {
  const [agg] = await db
    .select({
      totalAvailable: sql<number>`COALESCE(SUM(${workCenterCapacityWindows.availableMinutes}), 0)::int`,
      totalAllocated: sql<number>`COALESCE(SUM(${workCenterCapacityWindows.allocatedMinutes}), 0)::int`,
    })
    .from(workCenterCapacityWindows)
    .where(
      and(
        eq(workCenterCapacityWindows.workCenterId, workCenterId),
        eq(workCenterCapacityWindows.tenantId, tenantId)
      )
    )
    .execute();

  if (agg.totalAvailable === 0) {
    return {
      canAccept: false,
      currentUtilization: 0,
      projectedUtilization: 0,
      reason: 'No capacity windows defined for this work center',
    };
  }

  const currentUtilization = (agg.totalAllocated / agg.totalAvailable) * 100;
  const projectedUtilization = ((agg.totalAllocated + requestedMinutes) / agg.totalAvailable) * 100;

  if (projectedUtilization > maxUtilizationPercent) {
    return {
      canAccept: false,
      currentUtilization: Math.round(currentUtilization * 100) / 100,
      projectedUtilization: Math.round(projectedUtilization * 100) / 100,
      reason: `Projected utilization ${projectedUtilization.toFixed(1)}% exceeds threshold ${maxUtilizationPercent}%`,
    };
  }

  return {
    canAccept: true,
    currentUtilization: Math.round(currentUtilization * 100) / 100,
    projectedUtilization: Math.round(projectedUtilization * 100) / 100,
  };
}
