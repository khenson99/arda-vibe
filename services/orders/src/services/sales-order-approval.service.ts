/**
 * Sales Order Approval Service
 *
 * Handles the operational side effects of approving or cancelling a sales order:
 * - Inventory reservation (qtyReserved) per line
 * - Demand signal recording
 * - Kanban trigger evaluation
 * - Cancellation release flow (reverse reservations + cancel demand signals)
 */

import { randomUUID } from 'node:crypto';
import { db, schema, writeAuditEntry } from '@arda/db';
import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  getEventBus,
  type EventMeta,
  type SalesOrderApprovedEvent,
  type SalesOrderCancelledEvent,
  type DemandSignalCreatedEvent,
  type OrderStatusChangedEvent,
} from '@arda/events';
import { createLogger } from '@arda/config';
import type { AuditContext } from '@arda/auth-utils';

import { adjustQuantity, upsertInventory } from './inventory-ledger.service.js';

const log = createLogger('sales-order-approval');

const {
  salesOrders,
  salesOrderLines,
  demandSignals,
  inventoryLedger,
  kanbanLoops,
  kanbanCards,
} = schema;

// ─── Types ────────────────────────────────────────────────────────────

interface LineReservationResult {
  lineId: string;
  partId: string;
  quantityOrdered: number;
  quantityReserved: number;
  shortfall: number;
}

export interface ApprovalResult {
  orderId: string;
  orderNumber: string;
  previousStatus: string;
  newStatus: string;
  reservations: LineReservationResult[];
  demandSignalsCreated: number;
  kanbanCardsTriggered: number;
}

export interface CancellationResult {
  orderId: string;
  orderNumber: string;
  previousStatus: string;
  inventoryReleased: number;
  demandSignalsCancelled: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildEventMeta(correlationId?: string): EventMeta {
  return {
    id: randomUUID(),
    schemaVersion: 1,
    source: 'orders.sales-order-approval',
    correlationId,
    timestamp: new Date().toISOString(),
  };
}

// ─── Approve Sales Order ──────────────────────────────────────────────

/**
 * Approve a confirmed sales order:
 * 1. Transition confirmed → processing
 * 2. Reserve inventory per line (increment qtyReserved)
 * 3. Record demand signals per line
 * 4. Evaluate kanban triggers for affected parts
 */
export async function approveSalesOrder(
  orderId: string,
  tenantId: string,
  userId: string,
  facilityId: string,
  auditContext: AuditContext,
): Promise<ApprovalResult> {
  // Phase 1: DB transaction — status change + demand signals + line allocation
  const txResult = await db.transaction(async (tx) => {
    // Fetch order with lines
    const [order] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, orderId), eq(salesOrders.tenantId, tenantId)))
      .for('update');

    if (!order) {
      throw Object.assign(new Error('Sales order not found'), { statusCode: 404 });
    }
    if (order.status !== 'confirmed') {
      throw Object.assign(
        new Error(`Cannot approve order in "${order.status}" status — must be "confirmed"`),
        { statusCode: 409 },
      );
    }

    const lines = await tx
      .select()
      .from(salesOrderLines)
      .where(and(
        eq(salesOrderLines.salesOrderId, orderId),
        eq(salesOrderLines.tenantId, tenantId),
      ));

    if (lines.length === 0) {
      throw Object.assign(new Error('Sales order has no lines'), { statusCode: 409 });
    }

    // Transition to processing
    const [updated] = await tx
      .update(salesOrders)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(salesOrders.id, orderId))
      .returning();

    // Reserve inventory per line
    const reservations: LineReservationResult[] = [];

    for (const line of lines) {
      // Ensure inventory ledger row exists
      await upsertInventoryInTx(tx, tenantId, order.facilityId, line.partId);

      // Check available inventory
      const [ledgerRow] = await tx
        .select()
        .from(inventoryLedger)
        .where(and(
          eq(inventoryLedger.tenantId, tenantId),
          eq(inventoryLedger.facilityId, order.facilityId),
          eq(inventoryLedger.partId, line.partId),
        ))
        .for('update');

      const available = ledgerRow ? (ledgerRow.qtyOnHand - ledgerRow.qtyReserved) : 0;
      const needed = line.quantityOrdered - line.quantityAllocated;
      const reservable = Math.min(Math.max(0, available), needed);

      if (reservable > 0) {
        // Increment qtyReserved on the ledger
        await tx
          .update(inventoryLedger)
          .set({
            qtyReserved: sql`${inventoryLedger.qtyReserved} + ${reservable}`,
            updatedAt: new Date(),
          })
          .where(eq(inventoryLedger.id, ledgerRow!.id));

        // Update quantityAllocated on the line
        await tx
          .update(salesOrderLines)
          .set({
            quantityAllocated: line.quantityAllocated + reservable,
            updatedAt: new Date(),
          })
          .where(eq(salesOrderLines.id, line.id));
      }

      reservations.push({
        lineId: line.id,
        partId: line.partId,
        quantityOrdered: line.quantityOrdered,
        quantityReserved: reservable,
        shortfall: needed - reservable,
      });

      // Record demand signal (append-only)
      await tx.insert(demandSignals).values({
        tenantId,
        partId: line.partId,
        facilityId: order.facilityId,
        signalType: 'sales_order',
        quantityDemanded: line.quantityOrdered,
        quantityFulfilled: reservable,
        salesOrderId: orderId,
        salesOrderLineId: line.id,
        demandDate: new Date(),
        metadata: {
          soNumber: order.soNumber,
          lineNumber: line.lineNumber,
          unitPrice: line.unitPrice,
        },
      });
    }

    // Write audit entry
    await writeAuditEntry(tx, {
      tenantId,
      userId: auditContext.userId,
      action: 'sales_order.approved',
      entityType: 'sales_order',
      entityId: orderId,
      previousState: { status: 'confirmed' },
      newState: {
        status: 'processing',
        reservations: reservations.map((r) => ({
          partId: r.partId,
          reserved: r.quantityReserved,
          shortfall: r.shortfall,
        })),
      },
      metadata: {
        source: 'sales-order-approval.approve',
        soNumber: order.soNumber,
        lineCount: lines.length,
        totalReserved: reservations.reduce((sum, r) => sum + r.quantityReserved, 0),
        totalShortfall: reservations.reduce((sum, r) => sum + r.shortfall, 0),
      },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    // Record stockout_inquiry signals for shortfall lines
    for (const r of reservations) {
      if (r.shortfall > 0) {
        await tx.insert(demandSignals).values({
          tenantId,
          partId: r.partId,
          facilityId: order.facilityId,
          signalType: 'reorder_point',
          quantityDemanded: r.shortfall,
          quantityFulfilled: 0,
          salesOrderId: orderId,
          salesOrderLineId: r.lineId,
          demandDate: new Date(),
          metadata: {
            type: 'stockout_inquiry',
            soNumber: order.soNumber,
            reason: 'insufficient_inventory',
          },
        });
      }
    }

    return {
      order: updated,
      reservations,
      demandSignalsCreated: lines.length + reservations.filter((r) => r.shortfall > 0).length,
    };
  });

  // Phase 2: Kanban trigger evaluation (outside main transaction for isolation)
  let kanbanCardsTriggered = 0;
  const uniqueParts = [...new Set(txResult.reservations.map((r) => r.partId))];

  for (const partId of uniqueParts) {
    try {
      const triggered = await evaluateKanbanTrigger(tenantId, facilityId, partId);
      if (triggered) kanbanCardsTriggered++;
    } catch (err) {
      log.warn({ err, partId, facilityId }, 'Kanban trigger evaluation failed — non-blocking');
    }
  }

  // Phase 3: Publish events (non-blocking — failures don't affect the approval)
  try {
    const eventBus = getEventBus();
    const now = new Date().toISOString();

    const statusEvent: OrderStatusChangedEvent = {
      type: 'order.status_changed',
      tenantId,
      orderType: 'sales_order',
      orderId,
      orderNumber: txResult.order.soNumber,
      fromStatus: 'confirmed',
      toStatus: 'processing',
      timestamp: now,
    };
    await eventBus.publish(statusEvent, buildEventMeta());

    const approvedEvent: SalesOrderApprovedEvent = {
      type: 'sales_order.approved',
      tenantId,
      orderId,
      orderNumber: txResult.order.soNumber,
      customerId: txResult.order.customerId,
      facilityId: txResult.order.facilityId,
      lineCount: txResult.reservations.length,
      totalAmount: txResult.order.totalAmount ?? '0',
      reservationSummary: {
        totalRequested: txResult.reservations.reduce((s, r) => s + r.quantityOrdered, 0),
        totalReserved: txResult.reservations.reduce((s, r) => s + r.quantityReserved, 0),
        shortfallLines: txResult.reservations.filter((r) => r.shortfall > 0).length,
      },
      timestamp: now,
    };
    await eventBus.publish(approvedEvent, buildEventMeta());
  } catch (err) {
    log.warn({ err, orderId }, 'Failed to publish approval events — non-blocking');
  }

  return {
    orderId,
    orderNumber: txResult.order.soNumber,
    previousStatus: 'confirmed',
    newStatus: 'processing',
    reservations: txResult.reservations,
    demandSignalsCreated: txResult.demandSignalsCreated,
    kanbanCardsTriggered,
  };
}

// ─── Cancel Sales Order ───────────────────────────────────────────────

/**
 * Cancel a sales order and release reserved inventory:
 * 1. Transition to cancelled
 * 2. Release inventory reservations (decrement qtyReserved)
 * 3. Record cancellation demand signals
 */
export async function cancelSalesOrder(
  orderId: string,
  tenantId: string,
  userId: string,
  cancelReason: string | undefined,
  auditContext: AuditContext,
): Promise<CancellationResult> {
  const txResult = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, orderId), eq(salesOrders.tenantId, tenantId)))
      .for('update');

    if (!order) {
      throw Object.assign(new Error('Sales order not found'), { statusCode: 404 });
    }

    const terminalStatuses = ['cancelled', 'closed'];
    if (terminalStatuses.includes(order.status)) {
      throw Object.assign(
        new Error(`Cannot cancel order in "${order.status}" status`),
        { statusCode: 409 },
      );
    }

    const previousStatus = order.status;

    // Transition to cancelled
    await tx
      .update(salesOrders)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: cancelReason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(salesOrders.id, orderId));

    // Release reserved inventory for lines with allocations
    const lines = await tx
      .select()
      .from(salesOrderLines)
      .where(and(
        eq(salesOrderLines.salesOrderId, orderId),
        eq(salesOrderLines.tenantId, tenantId),
      ));

    let totalReleased = 0;

    for (const line of lines) {
      if (line.quantityAllocated > 0) {
        // Decrement qtyReserved on inventory ledger
        const [ledgerRow] = await tx
          .select()
          .from(inventoryLedger)
          .where(and(
            eq(inventoryLedger.tenantId, tenantId),
            eq(inventoryLedger.facilityId, order.facilityId),
            eq(inventoryLedger.partId, line.partId),
          ))
          .for('update');

        if (ledgerRow) {
          const releaseQty = Math.min(line.quantityAllocated, ledgerRow.qtyReserved);
          if (releaseQty > 0) {
            await tx
              .update(inventoryLedger)
              .set({
                qtyReserved: sql`${inventoryLedger.qtyReserved} - ${releaseQty}`,
                updatedAt: new Date(),
              })
              .where(eq(inventoryLedger.id, ledgerRow.id));
            totalReleased += releaseQty;
          }
        }

        // Reset allocation on line
        await tx
          .update(salesOrderLines)
          .set({ quantityAllocated: 0, updatedAt: new Date() })
          .where(eq(salesOrderLines.id, line.id));
      }
    }

    // Record cancellation demand signals (reversal entries)
    let demandSignalsCancelled = 0;
    for (const line of lines) {
      if (line.quantityOrdered > 0) {
        await tx.insert(demandSignals).values({
          tenantId,
          partId: line.partId,
          facilityId: order.facilityId,
          signalType: 'sales_order',
          quantityDemanded: -line.quantityOrdered,
          quantityFulfilled: 0,
          salesOrderId: orderId,
          salesOrderLineId: line.id,
          demandDate: new Date(),
          metadata: {
            type: 'cancellation',
            soNumber: order.soNumber,
            lineNumber: line.lineNumber,
            previousStatus,
            cancelReason: cancelReason ?? null,
          },
        });
        demandSignalsCancelled++;
      }
    }

    // Audit entry
    await writeAuditEntry(tx, {
      tenantId,
      userId: auditContext.userId,
      action: 'sales_order.cancelled',
      entityType: 'sales_order',
      entityId: orderId,
      previousState: { status: previousStatus },
      newState: { status: 'cancelled', cancelReason },
      metadata: {
        source: 'sales-order-approval.cancel',
        soNumber: order.soNumber,
        inventoryReleased: totalReleased,
        demandSignalsCancelled,
      },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    return {
      orderNumber: order.soNumber,
      previousStatus,
      totalReleased,
      demandSignalsCancelled,
    };
  });

  // Publish events outside transaction
  try {
    const eventBus = getEventBus();
    const now = new Date().toISOString();

    const statusEvent: OrderStatusChangedEvent = {
      type: 'order.status_changed',
      tenantId,
      orderType: 'sales_order',
      orderId,
      orderNumber: txResult.orderNumber,
      fromStatus: txResult.previousStatus,
      toStatus: 'cancelled',
      timestamp: now,
    };
    await eventBus.publish(statusEvent, buildEventMeta());

    const cancelledEvent: SalesOrderCancelledEvent = {
      type: 'sales_order.cancelled',
      tenantId,
      orderId,
      orderNumber: txResult.orderNumber,
      previousStatus: txResult.previousStatus,
      cancelReason,
      inventoryReleased: txResult.totalReleased,
      demandSignalsCancelled: txResult.demandSignalsCancelled,
      timestamp: now,
    };
    await eventBus.publish(cancelledEvent, buildEventMeta());
  } catch (err) {
    log.warn({ err, orderId }, 'Failed to publish cancellation events — non-blocking');
  }

  return {
    orderId,
    orderNumber: txResult.orderNumber,
    previousStatus: txResult.previousStatus,
    inventoryReleased: txResult.totalReleased,
    demandSignalsCancelled: txResult.demandSignalsCancelled,
  };
}

// ─── Kanban Trigger Evaluation ────────────────────────────────────────

/**
 * Evaluate whether a kanban card should be triggered for a given part at a facility.
 * Conditions:
 *   1. An active kanban loop exists for (facility, part)
 *   2. Available inventory (qtyOnHand - qtyReserved) <= minQuantity (reorder point)
 *   3. No existing triggered or ordered cards in the loop
 *
 * Returns true if a card was triggered.
 */
async function evaluateKanbanTrigger(
  tenantId: string,
  facilityId: string,
  partId: string,
): Promise<boolean> {
  // Find active kanban loops for this part+facility
  const loops = await db
    .select()
    .from(kanbanLoops)
    .where(and(
      eq(kanbanLoops.tenantId, tenantId),
      eq(kanbanLoops.facilityId, facilityId),
      eq(kanbanLoops.partId, partId),
      eq(kanbanLoops.isActive, true),
    ));

  if (loops.length === 0) return false;

  // Check inventory level
  const [ledgerRow] = await db
    .select()
    .from(inventoryLedger)
    .where(and(
      eq(inventoryLedger.tenantId, tenantId),
      eq(inventoryLedger.facilityId, facilityId),
      eq(inventoryLedger.partId, partId),
    ));

  if (!ledgerRow) return false;

  const available = ledgerRow.qtyOnHand - ledgerRow.qtyReserved;

  let triggered = false;

  for (const loop of loops) {
    // Check if available <= reorder point
    if (available > loop.minQuantity) continue;

    // Check if there are already active (triggered/ordered) cards
    const activeCards = await db
      .select({ id: kanbanCards.id })
      .from(kanbanCards)
      .where(and(
        eq(kanbanCards.loopId, loop.id),
        eq(kanbanCards.tenantId, tenantId),
        eq(kanbanCards.isActive, true),
        inArray(kanbanCards.currentStage, ['triggered', 'ordered']),
      ))
      .limit(1);

    if (activeCards.length > 0) continue;

    // Find a restocked or created card to trigger
    const [eligibleCard] = await db
      .select()
      .from(kanbanCards)
      .where(and(
        eq(kanbanCards.loopId, loop.id),
        eq(kanbanCards.tenantId, tenantId),
        eq(kanbanCards.isActive, true),
        inArray(kanbanCards.currentStage, ['restocked', 'created']),
      ))
      .limit(1);

    if (!eligibleCard) continue;

    // Trigger the card
    await db
      .update(kanbanCards)
      .set({
        currentStage: 'triggered',
        currentStageEnteredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(kanbanCards.id, eligibleCard.id));

    log.info({
      loopId: loop.id,
      cardId: eligibleCard.id,
      partId,
      facilityId,
      available,
      minQuantity: loop.minQuantity,
    }, 'Kanban card triggered by sales order approval');

    triggered = true;
  }

  return triggered;
}

// ─── Upsert inventory in transaction context ─────────────────────────

async function upsertInventoryInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  facilityId: string,
  partId: string,
): Promise<void> {
  await tx
    .insert(inventoryLedger)
    .values({
      tenantId,
      facilityId,
      partId,
      qtyOnHand: 0,
      qtyReserved: 0,
      qtyInTransit: 0,
      reorderPoint: 0,
      reorderQty: 0,
    })
    .onConflictDoNothing({
      target: [inventoryLedger.tenantId, inventoryLedger.facilityId, inventoryLedger.partId],
    });
}
