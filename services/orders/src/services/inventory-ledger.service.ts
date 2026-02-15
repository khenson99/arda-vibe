/**
 * Inventory Ledger Service
 *
 * CRUD operations and transaction-safe quantity adjustments for the
 * per-facility inventory ledger.  All mutations run inside a database
 * transaction and publish an InventoryUpdatedEvent through the event bus.
 *
 * Quantity fields:
 *   qtyOnHand   – physical stock available at the facility
 *   qtyReserved – stock allocated to outbound orders / picks
 *   qtyInTransit – stock shipped but not yet received
 */

import { randomUUID } from 'node:crypto';
import { db, schema, writeAuditEntry } from '@arda/db';
import { eq, and, sql } from 'drizzle-orm';
import {
  getEventBus,
  type AuditCreatedEvent,
  type EventMeta,
  type InventoryUpdatedEvent,
  type KpiRefreshedEvent,
  type UserActivityEvent,
} from '@arda/events';
import { createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import type { InventoryAdjustmentType, InventoryField } from '@arda/shared-types';

const log = createLogger('inventory-ledger');

const { inventoryLedger } = schema;

// ─── Types ────────────────────────────────────────────────────────────

export interface GetInventoryInput {
  tenantId: string;
  facilityId: string;
  partId: string;
}

export interface ListInventoryInput {
  tenantId: string;
  facilityId: string;
  page?: number;
  pageSize?: number;
}

export interface UpsertInventoryInput {
  tenantId: string;
  facilityId: string;
  partId: string;
  qtyOnHand?: number;
  qtyReserved?: number;
  qtyInTransit?: number;
  reorderPoint?: number;
  reorderQty?: number;
}

export interface AdjustQuantityInput {
  tenantId: string;
  facilityId: string;
  partId: string;
  field: InventoryField;
  adjustmentType: InventoryAdjustmentType;
  quantity: number;
  /** Optional source for audit trail (e.g. 'cycle_count', 'transfer_receipt'). */
  source?: string;
  userId?: string;
  correlationId?: string;
  route?: string;
}

export interface AdjustQuantityResult {
  previousValue: number;
  newValue: number;
  field: InventoryField;
  adjustmentType: InventoryAdjustmentType;
  quantity: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface InventoryMutationEmission {
  tenantId: string;
  facilityId: string;
  partId: string;
  field: InventoryField;
  adjustmentType: InventoryAdjustmentType;
  quantity: number;
  source?: string;
  previousValue: number;
  newValue: number;
  userId?: string;
  correlationId?: string;
  route?: string;
  auditId: string;
  auditAction: string;
  entityId: string;
}

function buildEventMeta(correlationId?: string): EventMeta {
  return {
    id: randomUUID(),
    schemaVersion: 1,
    source: 'orders.inventory-ledger',
    correlationId,
    timestamp: new Date().toISOString(),
  };
}

function getAffectedMetrics(field: InventoryField): string[] {
  switch (field) {
    case 'qtyOnHand':
      return ['stockout_count', 'fill_rate'];
    case 'qtyReserved':
      return ['fill_rate'];
    case 'qtyInTransit':
      return ['supplier_otd'];
    default:
      return ['stockout_count'];
  }
}

function buildKpiEvent(input: InventoryMutationEmission, timestamp: string): KpiRefreshedEvent {
  const affectedMetrics = getAffectedMetrics(input.field);
  const deltaPercent = input.previousValue === 0
    ? undefined
    : ((input.newValue - input.previousValue) / Math.abs(input.previousValue)) * 100;

  return {
    type: 'kpi.refreshed',
    tenantId: input.tenantId,
    kpiKey: affectedMetrics[0] ?? 'stockout_count',
    affectedMetrics,
    window: '30d',
    facilityId: input.facilityId,
    value: input.newValue,
    previousValue: input.previousValue,
    deltaPercent,
    refreshedAt: timestamp,
    timestamp,
  };
}

async function publishInventoryMutationEvents(input: InventoryMutationEmission): Promise<void> {
  const eventBus = getEventBus();
  const now = new Date().toISOString();

  const inventoryEvent: InventoryUpdatedEvent = {
    type: 'inventory:updated',
    tenantId: input.tenantId,
    facilityId: input.facilityId,
    partId: input.partId,
    field: input.field,
    adjustmentType: input.adjustmentType,
    quantity: input.quantity,
    previousValue: input.previousValue,
    newValue: input.newValue,
    ...(input.adjustmentType === 'set' && {
      variance: input.newValue - input.previousValue,
    }),
    source: input.source,
    timestamp: now,
  };

  const auditEvent: AuditCreatedEvent = {
    type: 'audit.created',
    tenantId: input.tenantId,
    auditId: input.auditId,
    action: input.auditAction,
    entityType: 'inventory_ledger',
    entityId: input.entityId,
    actorUserId: input.userId ?? null,
    method: input.userId ? 'api' : 'system',
    timestamp: now,
  };

  await eventBus.publish(inventoryEvent, buildEventMeta(input.correlationId));
  await eventBus.publish(buildKpiEvent(input, now), buildEventMeta(input.correlationId));
  await eventBus.publish(auditEvent, buildEventMeta(input.correlationId));

  if (!input.userId) return;

  const userActivityEvent: UserActivityEvent = {
    type: 'user.activity',
    tenantId: input.tenantId,
    userId: input.userId,
    activityType: 'mutation',
    route: input.route,
    resourceType: 'inventory_ledger',
    resourceId: input.partId,
    correlationId: input.correlationId,
    timestamp: now,
  };

  await eventBus.publish(userActivityEvent, buildEventMeta(input.correlationId));
}

// ─── Read Operations ──────────────────────────────────────────────────

/**
 * Get a single inventory ledger row for a tenant + facility + part.
 * Returns null if no row exists yet.
 */
export async function getInventory(input: GetInventoryInput) {
  const { tenantId, facilityId, partId } = input;

  const rows = await db
    .select()
    .from(inventoryLedger)
    .where(
      and(
        eq(inventoryLedger.tenantId, tenantId),
        eq(inventoryLedger.facilityId, facilityId),
        eq(inventoryLedger.partId, partId)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * List all inventory rows for a facility (paginated).
 */
export async function listInventoryByFacility(input: ListInventoryInput) {
  const { tenantId, facilityId, page = 1, pageSize = 50 } = input;
  const offset = (page - 1) * pageSize;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(inventoryLedger)
      .where(
        and(
          eq(inventoryLedger.tenantId, tenantId),
          eq(inventoryLedger.facilityId, facilityId)
        )
      )
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(inventoryLedger)
      .where(
        and(
          eq(inventoryLedger.tenantId, tenantId),
          eq(inventoryLedger.facilityId, facilityId)
        )
      ),
  ]);

  const total = countResult[0]?.count ?? 0;

  return {
    data: rows,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

// ─── Write Operations ─────────────────────────────────────────────────

/**
 * Create or update an inventory ledger row (upsert).
 * Uses INSERT … ON CONFLICT to avoid race conditions.
 */
export async function upsertInventory(input: UpsertInventoryInput) {
  const { tenantId, facilityId, partId, ...fields } = input;

  const result = await db
    .insert(inventoryLedger)
    .values({
      tenantId,
      facilityId,
      partId,
      qtyOnHand: fields.qtyOnHand ?? 0,
      qtyReserved: fields.qtyReserved ?? 0,
      qtyInTransit: fields.qtyInTransit ?? 0,
      reorderPoint: fields.reorderPoint ?? 0,
      reorderQty: fields.reorderQty ?? 0,
    })
    .onConflictDoUpdate({
      target: [inventoryLedger.tenantId, inventoryLedger.facilityId, inventoryLedger.partId],
      set: {
        ...(fields.qtyOnHand !== undefined && { qtyOnHand: fields.qtyOnHand }),
        ...(fields.qtyReserved !== undefined && { qtyReserved: fields.qtyReserved }),
        ...(fields.qtyInTransit !== undefined && { qtyInTransit: fields.qtyInTransit }),
        ...(fields.reorderPoint !== undefined && { reorderPoint: fields.reorderPoint }),
        ...(fields.reorderQty !== undefined && { reorderQty: fields.reorderQty }),
        updatedAt: new Date(),
      },
    })
    .returning();

  return result[0];
}

/**
 * Transaction-safe quantity adjustment.
 *
 * Supports three modes:
 *   - set:       overwrite the field value
 *   - increment: add quantity to the current value
 *   - decrement: subtract quantity from the current value (floors at 0)
 *
 * Publishes an InventoryUpdatedEvent on success.
 */
export async function adjustQuantity(input: AdjustQuantityInput): Promise<AdjustQuantityResult> {
  const { tenantId, facilityId, partId, field, adjustmentType, quantity, source } = input;

  if (quantity < 0) {
    throw new AppError(400, 'Quantity must be non-negative');
  }

  const result = await db.transaction(async (tx) => {
    // Lock the row for update to prevent concurrent modifications
    const rows = await tx
      .select()
      .from(inventoryLedger)
      .where(
        and(
          eq(inventoryLedger.tenantId, tenantId),
          eq(inventoryLedger.facilityId, facilityId),
          eq(inventoryLedger.partId, partId)
        )
      )
      .for('update')
      .limit(1);

    if (rows.length === 0) {
      throw new AppError(404, `No inventory record found for facility=${facilityId}, part=${partId}`);
    }

    const row = rows[0];
    const previousValue = row[field];

    let newValue: number;
    switch (adjustmentType) {
      case 'set':
        newValue = quantity;
        break;
      case 'increment':
        newValue = previousValue + quantity;
        break;
      case 'decrement':
        newValue = Math.max(0, previousValue - quantity);
        break;
      default:
        throw new AppError(400, `Unknown adjustment type: ${adjustmentType}`);
    }

    // Update the specific field
    await tx
      .update(inventoryLedger)
      .set({
        [field]: newValue,
        updatedAt: new Date(),
      })
      .where(eq(inventoryLedger.id, row.id));

    // Audit the adjustment in the same transaction
    const auditEntry = await writeAuditEntry(tx, {
      tenantId,
      userId: input.userId ?? null,
      action: 'inventory.adjusted',
      entityType: 'inventory_ledger',
      entityId: row.id,
      previousState: { [field]: previousValue },
      newState: { [field]: newValue },
      metadata: {
        facilityId,
        partId,
        adjustmentType,
        quantity,
        source: source ?? 'manual',
        ...(!input.userId ? { systemActor: 'inventory_ledger' } : {}),
      },
    });

    return { previousValue, newValue, auditId: auditEntry.id, entityId: row.id };
  });

  // Publish event outside the transaction so a publish failure
  // doesn't roll back the DB change.
  try {
    await publishInventoryMutationEvents({
      tenantId,
      facilityId,
      partId,
      field,
      adjustmentType,
      quantity,
      source,
      previousValue: result.previousValue,
      newValue: result.newValue,
      userId: input.userId,
      correlationId: input.correlationId,
      route: input.route,
      auditId: result.auditId,
      auditAction: 'inventory.adjusted',
      entityId: result.entityId,
    });
  } catch (err) {
    log.warn({ err, facilityId, partId, field }, 'Failed to publish inventory mutation events');
  }

  return {
    previousValue: result.previousValue,
    newValue: result.newValue,
    field,
    adjustmentType,
    quantity,
  };
}

/**
 * Batch adjust multiple fields in a single transaction.
 * Useful for transfer receipt (decrement in-transit + increment on-hand simultaneously).
 */
export async function batchAdjust(
  adjustments: AdjustQuantityInput[]
): Promise<AdjustQuantityResult[]> {
  if (adjustments.length === 0) return [];

  // Group by tenant + facility + part to run all adjustments in one TX
  const results: AdjustQuantityResult[] = [];
  const emissions: InventoryMutationEmission[] = [];

  await db.transaction(async (tx) => {
    for (const adj of adjustments) {
      const { tenantId, facilityId, partId, field, adjustmentType, quantity } = adj;

      if (quantity < 0) {
        throw new AppError(400, 'Quantity must be non-negative');
      }

      const rows = await tx
        .select()
        .from(inventoryLedger)
        .where(
          and(
            eq(inventoryLedger.tenantId, tenantId),
            eq(inventoryLedger.facilityId, facilityId),
            eq(inventoryLedger.partId, partId)
          )
        )
        .for('update')
        .limit(1);

      if (rows.length === 0) {
        throw new AppError(404, `No inventory record found for facility=${facilityId}, part=${partId}`);
      }

      const row = rows[0];
      const previousValue = row[field];

      let newValue: number;
      switch (adjustmentType) {
        case 'set':
          newValue = quantity;
          break;
        case 'increment':
          newValue = previousValue + quantity;
          break;
        case 'decrement':
          newValue = Math.max(0, previousValue - quantity);
          break;
        default:
          throw new AppError(400, `Unknown adjustment type: ${adjustmentType}`);
      }

      await tx
        .update(inventoryLedger)
        .set({
          [field]: newValue,
          updatedAt: new Date(),
        })
        .where(eq(inventoryLedger.id, row.id));

      // Audit each adjustment in the same transaction
      const auditEntry = await writeAuditEntry(tx, {
        tenantId,
        userId: adj.userId ?? null,
        action: 'inventory.ledger_updated',
        entityType: 'inventory_ledger',
        entityId: row.id,
        previousState: { [field]: previousValue },
        newState: { [field]: newValue },
        metadata: {
          facilityId,
          partId,
          adjustmentType,
          quantity,
          source: adj.source ?? 'batch',
          batchSize: adjustments.length,
          ...(!adj.userId ? { systemActor: 'inventory_ledger' } : {}),
        },
      });

      results.push({ previousValue, newValue, field, adjustmentType, quantity });
      emissions.push({
        tenantId,
        facilityId,
        partId,
        field,
        adjustmentType,
        quantity,
        source: adj.source,
        previousValue,
        newValue,
        userId: adj.userId,
        correlationId: adj.correlationId,
        route: adj.route,
        auditId: auditEntry.id,
        auditAction: 'inventory.ledger_updated',
        entityId: row.id,
      });
    }
  });

  // Publish events outside the transaction
  try {
    await Promise.all(emissions.map((emission) => publishInventoryMutationEvents(emission)));
  } catch (err) {
    log.warn({ err }, 'Failed to publish batch inventory mutation events');
  }

  return results;
}
