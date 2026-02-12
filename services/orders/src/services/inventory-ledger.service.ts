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

import { db, schema, writeAuditEntry } from '@arda/db';
import { eq, and, sql } from 'drizzle-orm';
import { getEventBus, type InventoryUpdatedEvent } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import type { InventoryAdjustmentType, InventoryField } from '@arda/shared-types';

const log = createLogger('inventory-ledger');

const { inventoryLedger, facilities } = schema;

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
}

export interface AdjustQuantityResult {
  previousValue: number;
  newValue: number;
  field: InventoryField;
  adjustmentType: InventoryAdjustmentType;
  quantity: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Map a camelCase InventoryField name to the Drizzle column reference.
 */
function fieldColumn(field: InventoryField) {
  switch (field) {
    case 'qtyOnHand':
      return inventoryLedger.qtyOnHand;
    case 'qtyReserved':
      return inventoryLedger.qtyReserved;
    case 'qtyInTransit':
      return inventoryLedger.qtyInTransit;
    default:
      throw new AppError(400, `Unknown inventory field: ${field}`);
  }
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
    const col = fieldColumn(field);
    await tx
      .update(inventoryLedger)
      .set({
        [field]: newValue,
        updatedAt: new Date(),
      })
      .where(eq(inventoryLedger.id, row.id));

    // Audit the adjustment in the same transaction
    await writeAuditEntry(tx, {
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

    return { previousValue, newValue };
  });

  // Publish event outside the transaction so a publish failure
  // doesn't roll back the DB change.
  try {
    const event: InventoryUpdatedEvent = {
      type: 'inventory:updated',
      tenantId,
      facilityId,
      partId,
      field,
      adjustmentType,
      quantity,
      previousValue: result.previousValue,
      newValue: result.newValue,
      ...(adjustmentType === 'set' && {
        variance: result.newValue - result.previousValue,
      }),
      source,
      timestamp: new Date().toISOString(),
    };
    const eventBus = getEventBus();
    await eventBus.publish(event);
  } catch (err) {
    log.warn({ err, facilityId, partId, field }, 'Failed to publish inventory update event');
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
      await writeAuditEntry(tx, {
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
    }
  });

  // Publish events outside the transaction
  try {
    const eventBus = getEventBus();
    await Promise.all(
      adjustments.map((adj, i) => {
        const r = results[i];
        const event: InventoryUpdatedEvent = {
          type: 'inventory:updated',
          tenantId: adj.tenantId,
          facilityId: adj.facilityId,
          partId: adj.partId,
          field: adj.field,
          adjustmentType: adj.adjustmentType,
          quantity: adj.quantity,
          previousValue: r.previousValue,
          newValue: r.newValue,
          source: adj.source,
          timestamp: new Date().toISOString(),
        };
        return eventBus.publish(event);
      })
    );
  } catch (err) {
    log.warn({ err }, 'Failed to publish batch inventory update events');
  }

  return results;
}
