import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import { getEventBus, publishKpiRefreshed } from '@arda/events';
import { getCorrelationId } from '@arda/observability';
import { config, createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import { adjustQuantity, upsertInventory } from './inventory-ledger.service.js';

const log = createLogger('receiving-service');

const {
  receipts,
  receiptLines,
  receivingExceptions,
  purchaseOrders,
  purchaseOrderLines,
  transferOrders,
  transferOrderLines,
  workOrders,
  kanbanCards,
  cardStageTransitions,
  inventoryLedger,
} = schema;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Types ──────────────────────────────────────────────────────────

export interface ReceiptLineInput {
  orderLineId: string;
  partId: string;
  quantityExpected: number;
  quantityAccepted: number;
  quantityDamaged: number;
  quantityRejected: number;
  notes?: string;
}

export interface ProcessReceiptInput {
  tenantId: string;
  orderId: string;
  orderType: 'purchase_order' | 'transfer_order' | 'work_order';
  receivedByUserId?: string;
  lines: ReceiptLineInput[];
  notes?: string;
}

export interface ResolveExceptionInput {
  tenantId: string;
  exceptionId: string;
  resolutionType: 'follow_up_po' | 'replacement_card' | 'return_to_supplier' | 'credit' | 'accept_as_is';
  resolutionNotes?: string;
  resolvedByUserId?: string;
}

// ─── Receipt Number Generation ──────────────────────────────────────

async function getNextReceiptNumber(tenantId: string, tx: DbTransaction): Promise<string> {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const pattern = `RCV-${dateStr}-%`;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId + 'RCV' + dateStr}))`
  );

  const result = await tx
    .select({ receiptNumber: receipts.receiptNumber })
    .from(receipts)
    .where(and(eq(receipts.tenantId, tenantId), sql`${receipts.receiptNumber} like ${pattern}`))
    .orderBy(desc(receipts.receiptNumber))
    .limit(1);

  let maxNumber = 0;
  if (result.length > 0) {
    const last = result[0].receiptNumber.split('-').pop();
    maxNumber = parseInt(last || '0', 10);
  }

  const nextSeq = String(maxNumber + 1).padStart(4, '0');
  return `RCV-${dateStr}-${nextSeq}`;
}

// ─── Exception Detection ────────────────────────────────────────────

interface DetectedExceptions {
  type: 'short_shipment' | 'damaged' | 'quality_reject' | 'wrong_item' | 'overage';
  severity: 'low' | 'medium' | 'high' | 'critical';
  quantityAffected: number;
  description: string;
  receiptLineId?: string;
}

function detectExceptions(line: ReceiptLineInput): DetectedExceptions[] {
  const exceptions: DetectedExceptions[] = [];

  // Short shipment: received less than expected (considering accepted + damaged + rejected)
  const totalReceived = line.quantityAccepted + line.quantityDamaged + line.quantityRejected;
  const shortfall = line.quantityExpected - totalReceived;
  if (shortfall > 0) {
    const shortPct = shortfall / line.quantityExpected;
    exceptions.push({
      type: 'short_shipment',
      severity: shortPct >= 0.5 ? 'high' : shortPct >= 0.2 ? 'medium' : 'low',
      quantityAffected: shortfall,
      description: `Short shipment: expected ${line.quantityExpected}, received ${totalReceived} (${shortfall} short)`,
    });
  }

  // Damaged goods
  if (line.quantityDamaged > 0) {
    const damagePct = line.quantityDamaged / line.quantityExpected;
    exceptions.push({
      type: 'damaged',
      severity: damagePct >= 0.3 ? 'high' : damagePct >= 0.1 ? 'medium' : 'low',
      quantityAffected: line.quantityDamaged,
      description: `Damaged goods: ${line.quantityDamaged} of ${line.quantityExpected} units damaged`,
    });
  }

  // Quality reject
  if (line.quantityRejected > 0) {
    const rejectPct = line.quantityRejected / line.quantityExpected;
    exceptions.push({
      type: 'quality_reject',
      severity: rejectPct >= 0.3 ? 'critical' : rejectPct >= 0.1 ? 'high' : 'medium',
      quantityAffected: line.quantityRejected,
      description: `Quality rejection: ${line.quantityRejected} of ${line.quantityExpected} units rejected`,
    });
  }

  // Overage: received more than expected
  const overage = totalReceived - line.quantityExpected;
  if (overage > 0) {
    exceptions.push({
      type: 'overage',
      severity: 'low',
      quantityAffected: overage,
      description: `Overage: received ${totalReceived}, expected ${line.quantityExpected} (${overage} extra)`,
    });
  }

  return exceptions;
}

// ─── Determine Receipt Status ───────────────────────────────────────

function determineReceiptStatus(
  lines: ReceiptLineInput[],
  exceptionsCount: number
): 'complete' | 'partial' | 'exception' {
  if (exceptionsCount > 0) return 'exception';

  const hasAllAccepted = lines.every(
    (l) => l.quantityAccepted === l.quantityExpected
  );
  return hasAllAccepted ? 'complete' : 'partial';
}

// ─── Update Order Status After Receiving ────────────────────────────

async function updateOrderAfterReceiving(
  tx: DbTransaction,
  input: ProcessReceiptInput,
  _receiptStatus: string
) {
  if (input.orderType === 'purchase_order') {
    // Update PO line received quantities
    for (const line of input.lines) {
      await tx
        .update(purchaseOrderLines)
        .set({
          quantityReceived: sql`${purchaseOrderLines.quantityReceived} + ${line.quantityAccepted}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(purchaseOrderLines.id, line.orderLineId),
            eq(purchaseOrderLines.tenantId, input.tenantId)
          )
        );
    }

    // Check if all PO lines are fully received
    const poLines = await tx
      .select({
        ordered: purchaseOrderLines.quantityOrdered,
        received: purchaseOrderLines.quantityReceived,
      })
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.purchaseOrderId, input.orderId),
          eq(purchaseOrderLines.tenantId, input.tenantId)
        )
      );

    const allReceived = poLines.every((l) => l.received >= l.ordered);
    const newStatus = allReceived ? 'received' : 'partially_received';

    await tx
      .update(purchaseOrders)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(
        and(
          eq(purchaseOrders.id, input.orderId),
          eq(purchaseOrders.tenantId, input.tenantId)
        )
      );
  } else if (input.orderType === 'transfer_order') {
    for (const line of input.lines) {
      await tx
        .update(transferOrderLines)
        .set({
          quantityReceived: sql`${transferOrderLines.quantityReceived} + ${line.quantityAccepted}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transferOrderLines.id, line.orderLineId),
            eq(transferOrderLines.tenantId, input.tenantId)
          )
        );
    }

    const toLines = await tx
      .select({
        requested: transferOrderLines.quantityRequested,
        received: transferOrderLines.quantityReceived,
      })
      .from(transferOrderLines)
      .where(
        and(
          eq(transferOrderLines.transferOrderId, input.orderId),
          eq(transferOrderLines.tenantId, input.tenantId)
        )
      );

    const allReceived = toLines.every((l) => l.received >= l.requested);
    const newStatus = allReceived ? 'received' : 'in_transit';

    await tx
      .update(transferOrders)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(
        and(
          eq(transferOrders.id, input.orderId),
          eq(transferOrders.tenantId, input.tenantId)
        )
      );
  } else if (input.orderType === 'work_order') {
    // Work orders track produced quantities differently
    const totalAccepted = input.lines.reduce((sum, l) => sum + l.quantityAccepted, 0);
    const totalRejected = input.lines.reduce((sum, l) => sum + l.quantityRejected, 0);

    await tx
      .update(workOrders)
      .set({
        quantityProduced: sql`${workOrders.quantityProduced} + ${totalAccepted}`,
        quantityRejected: sql`${workOrders.quantityRejected} + ${totalRejected}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workOrders.id, input.orderId),
          eq(workOrders.tenantId, input.tenantId)
        )
      );
  }
}

// ─── Update Inventory After Receiving ─────────────────────────────────

async function updateInventoryAfterReceiving(
  input: ProcessReceiptInput,
  receiptId: string
): Promise<void> {
  // Determine the facility for inventory adjustments
  let facilityId: string | null = null;

  if (input.orderType === 'purchase_order') {
    const [po] = await db
      .select({ facilityId: purchaseOrders.facilityId })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, input.orderId), eq(purchaseOrders.tenantId, input.tenantId)));
    facilityId = po?.facilityId ?? null;
  } else if (input.orderType === 'transfer_order') {
    const [to] = await db
      .select({ facilityId: transferOrders.destinationFacilityId })
      .from(transferOrders)
      .where(and(eq(transferOrders.id, input.orderId), eq(transferOrders.tenantId, input.tenantId)));
    facilityId = to?.facilityId ?? null;
  } else if (input.orderType === 'work_order') {
    const [wo] = await db
      .select({ facilityId: workOrders.facilityId })
      .from(workOrders)
      .where(and(eq(workOrders.id, input.orderId), eq(workOrders.tenantId, input.tenantId)));
    facilityId = wo?.facilityId ?? null;
  }

  if (!facilityId) {
    log.warn({ orderId: input.orderId, orderType: input.orderType }, 'Could not determine facility for inventory update');
    return;
  }

  const correlationId = getCorrelationId();

  for (const line of input.lines) {
    if (line.quantityAccepted <= 0) continue;

    // Ensure inventory row exists (upsert with zero values if new)
    await upsertInventory({
      tenantId: input.tenantId,
      facilityId,
      partId: line.partId,
    });

    // Increment qtyOnHand for accepted items
    await adjustQuantity({
      tenantId: input.tenantId,
      facilityId,
      partId: line.partId,
      field: 'qtyOnHand',
      adjustmentType: 'increment',
      quantity: line.quantityAccepted,
      source: `receiving:${receiptId}`,
      userId: input.receivedByUserId,
      correlationId,
    });

    // For transfer orders, decrement qtyInTransit
    if (input.orderType === 'transfer_order') {
      await adjustQuantity({
        tenantId: input.tenantId,
        facilityId,
        partId: line.partId,
        field: 'qtyInTransit',
        adjustmentType: 'decrement',
        quantity: line.quantityAccepted,
        source: `receiving:${receiptId}`,
        userId: input.receivedByUserId,
        correlationId,
      });
    }
  }

  log.info(
    { receiptId, facilityId, lineCount: input.lines.length },
    'Inventory updated after receiving'
  );
}

// ─── Transition Kanban Cards After Receiving ──────────────────────────

async function transitionKanbanCardsAfterReceiving(
  tx: DbTransaction,
  input: ProcessReceiptInput,
  receiptId: string
): Promise<string[]> {
  const transitionedCardIds: string[] = [];

  // Collect kanbanCardIds from order lines
  let cardIds: string[] = [];

  if (input.orderType === 'purchase_order') {
    const poLines = await tx
      .select({ kanbanCardId: purchaseOrderLines.kanbanCardId })
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.purchaseOrderId, input.orderId),
          eq(purchaseOrderLines.tenantId, input.tenantId)
        )
      );
    cardIds = poLines
      .map((l) => l.kanbanCardId)
      .filter((id): id is string => id != null);
  } else if (input.orderType === 'work_order') {
    const [wo] = await tx
      .select({ kanbanCardId: workOrders.kanbanCardId })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.id, input.orderId),
          eq(workOrders.tenantId, input.tenantId)
        )
      );
    if (wo?.kanbanCardId) {
      cardIds = [wo.kanbanCardId];
    }
  } else if (input.orderType === 'transfer_order') {
    const [to] = await tx
      .select({ kanbanCardId: transferOrders.kanbanCardId })
      .from(transferOrders)
      .where(
        and(
          eq(transferOrders.id, input.orderId),
          eq(transferOrders.tenantId, input.tenantId)
        )
      );
    if (to?.kanbanCardId) {
      cardIds = [to.kanbanCardId];
    }
  }

  if (cardIds.length === 0) return transitionedCardIds;

  // Transition each card from ordered/in_transit → received
  for (const cardId of cardIds) {
    const [card] = await tx
      .select()
      .from(kanbanCards)
      .where(
        and(
          eq(kanbanCards.id, cardId),
          eq(kanbanCards.tenantId, input.tenantId)
        )
      );

    if (!card) continue;

    // Only transition cards that are in ordered or in_transit stage
    if (card.currentStage !== 'ordered' && card.currentStage !== 'in_transit') continue;

    const fromStage = card.currentStage;

    // Update card stage to 'received'
    await tx
      .update(kanbanCards)
      .set({
        currentStage: 'received',
        currentStageEnteredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(kanbanCards.id, cardId));

    // Insert stage transition record
    await tx
      .insert(cardStageTransitions)
      .values({
        tenantId: input.tenantId,
        cardId,
        loopId: card.loopId,
        cycleNumber: card.completedCycles + 1,
        fromStage,
        toStage: 'received',
        transitionedByUserId: input.receivedByUserId,
        method: 'system',
        notes: `Receiving confirmation for ${input.orderType} ${input.orderId}`,
        metadata: { receiptId, orderId: input.orderId, orderType: input.orderType },
      });

    // Audit the kanban transition
    await writeAuditEntry(tx, {
      tenantId: input.tenantId,
      userId: input.receivedByUserId ?? null,
      action: 'card.stage_changed',
      entityType: 'kanban_card',
      entityId: cardId,
      previousState: { currentStage: fromStage },
      newState: { currentStage: 'received' },
      metadata: {
        receiptId,
        orderId: input.orderId,
        orderType: input.orderType,
        loopId: card.loopId,
        method: 'system',
        trigger: 'receiving_confirmation',
      },
    });

    transitionedCardIds.push(cardId);
  }

  log.info(
    { receiptId, transitionedCards: transitionedCardIds.length },
    'Kanban cards transitioned after receiving'
  );

  return transitionedCardIds;
}

// ─── Get Expected Orders for Receiving ───────────────────────────────

export interface ExpectedOrdersInput {
  tenantId: string;
  facilityId?: string;
  orderType?: 'purchase_order' | 'transfer_order' | 'work_order';
}

export async function getExpectedOrders(input: ExpectedOrdersInput) {
  const { tenantId, facilityId, orderType } = input;

  const results: {
    purchaseOrders: Array<Record<string, unknown>>;
    transferOrders: Array<Record<string, unknown>>;
    workOrders: Array<Record<string, unknown>>;
  } = {
    purchaseOrders: [],
    transferOrders: [],
    workOrders: [],
  };

  // Purchase orders in receivable states
  if (!orderType || orderType === 'purchase_order') {
    let poQuery = db
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          sql`${purchaseOrders.status} IN ('sent', 'acknowledged', 'partially_received')`
        )
      );

    if (facilityId) {
      poQuery = db
        .select()
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, tenantId),
            eq(purchaseOrders.facilityId, facilityId),
            sql`${purchaseOrders.status} IN ('sent', 'acknowledged', 'partially_received')`
          )
        );
    }

    const pos = await poQuery.orderBy(desc(purchaseOrders.expectedDeliveryDate));

    // Enrich with lines showing remaining quantities
    for (const po of pos) {
      const lines = await db
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, po.id));

      const enrichedLines = lines.map((l) => ({
        ...l,
        quantityRemaining: l.quantityOrdered - l.quantityReceived,
      }));

      results.purchaseOrders.push({
        ...po,
        lines: enrichedLines,
        totalRemaining: enrichedLines.reduce((s, l) => s + l.quantityRemaining, 0),
      });
    }
  }

  // Transfer orders in transit
  if (!orderType || orderType === 'transfer_order') {
    let toQuery = db
      .select()
      .from(transferOrders)
      .where(
        and(
          eq(transferOrders.tenantId, tenantId),
          sql`${transferOrders.status} IN ('shipped', 'in_transit')`
        )
      );

    if (facilityId) {
      toQuery = db
        .select()
        .from(transferOrders)
        .where(
          and(
            eq(transferOrders.tenantId, tenantId),
            eq(transferOrders.destinationFacilityId, facilityId),
            sql`${transferOrders.status} IN ('shipped', 'in_transit')`
          )
        );
    }

    const tos = await toQuery.orderBy(desc(transferOrders.shippedDate));

    for (const to of tos) {
      const lines = await db
        .select()
        .from(transferOrderLines)
        .where(eq(transferOrderLines.transferOrderId, to.id));

      const enrichedLines = lines.map((l) => ({
        ...l,
        quantityRemaining: l.quantityRequested - l.quantityReceived,
      }));

      results.transferOrders.push({
        ...to,
        lines: enrichedLines,
        totalRemaining: enrichedLines.reduce((s, l) => s + l.quantityRemaining, 0),
      });
    }
  }

  // Work orders in progress (for production receiving)
  if (!orderType || orderType === 'work_order') {
    let woQuery = db
      .select()
      .from(workOrders)
      .where(
        and(
          eq(workOrders.tenantId, tenantId),
          sql`${workOrders.status} IN ('in_progress', 'scheduled')`
        )
      );

    if (facilityId) {
      woQuery = db
        .select()
        .from(workOrders)
        .where(
          and(
            eq(workOrders.tenantId, tenantId),
            eq(workOrders.facilityId, facilityId),
            sql`${workOrders.status} IN ('in_progress', 'scheduled')`
          )
        );
    }

    const wos = await woQuery.orderBy(desc(workOrders.scheduledEndDate));

    results.workOrders = wos.map((wo) => ({
      ...wo,
      quantityRemaining: wo.quantityToProduce - wo.quantityProduced,
    }));
  }

  return results;
}

// ─── Get Receiving History ───────────────────────────────────────────

export interface ReceivingHistoryInput {
  tenantId: string;
  page?: number;
  pageSize?: number;
  orderType?: string;
  status?: string;
}

export async function getReceivingHistory(input: ReceivingHistoryInput) {
  const { tenantId, page = 1, pageSize = 25 } = input;
  const offset = (page - 1) * pageSize;

  const conditions = [eq(receipts.tenantId, tenantId)];

  if (input.orderType) {
    conditions.push(eq(receipts.orderType, input.orderType));
  }
  if (input.status) {
    conditions.push(sql`${receipts.status} = ${input.status}`);
  }

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(receipts)
      .where(and(...conditions))
      .orderBy(desc(receipts.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(receipts)
      .where(and(...conditions)),
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

// ─── Main: Process Receipt ──────────────────────────────────────────

export async function processReceipt(input: ProcessReceiptInput) {
  const result = await db.transaction(async (tx) => {
    // Generate receipt number
    const receiptNumber = await getNextReceiptNumber(input.tenantId, tx);

    // Detect exceptions across all lines
    const allExceptions: Array<DetectedExceptions & { lineIndex: number }> = [];
    for (let i = 0; i < input.lines.length; i++) {
      const lineExceptions = detectExceptions(input.lines[i]);
      for (const exc of lineExceptions) {
        allExceptions.push({ ...exc, lineIndex: i });
      }
    }

    // Determine receipt status
    const status = determineReceiptStatus(input.lines, allExceptions.length);

    // Insert receipt header
    const [receipt] = await tx
      .insert(receipts)
      .values({
        tenantId: input.tenantId,
        receiptNumber,
        orderId: input.orderId,
        orderType: input.orderType,
        status,
        receivedByUserId: input.receivedByUserId,
        notes: input.notes,
      })
      .returning();

    // Insert receipt lines
    const insertedLines = await tx
      .insert(receiptLines)
      .values(
        input.lines.map((line) => ({
          tenantId: input.tenantId,
          receiptId: receipt.id,
          orderLineId: line.orderLineId,
          partId: line.partId,
          quantityExpected: line.quantityExpected,
          quantityAccepted: line.quantityAccepted,
          quantityDamaged: line.quantityDamaged,
          quantityRejected: line.quantityRejected,
          notes: line.notes,
        }))
      )
      .returning();

    // Insert exceptions
    const insertedExceptions = [];
    for (const exc of allExceptions) {
      const [inserted] = await tx
        .insert(receivingExceptions)
        .values({
          tenantId: input.tenantId,
          receiptId: receipt.id,
          receiptLineId: insertedLines[exc.lineIndex]?.id,
          orderId: input.orderId,
          orderType: input.orderType,
          exceptionType: exc.type,
          severity: exc.severity,
          quantityAffected: exc.quantityAffected,
          description: exc.description,
        })
        .returning();
      insertedExceptions.push(inserted);
    }

    // Update the source order
    await updateOrderAfterReceiving(tx, input, status);

    // Transition kanban cards from ordered/in_transit → received
    const transitionedCardIds = await transitionKanbanCardsAfterReceiving(tx, input, receipt.id);

    // Audit log — system-initiated receiving uses userId from input
    await writeAuditEntry(tx, {
      tenantId: input.tenantId,
      userId: input.receivedByUserId ?? null,
      action: 'receipt.created',
      entityType: 'receipt',
      entityId: receipt.id,
      previousState: null,
      newState: {
        status,
        receiptNumber,
        lineCount: input.lines.length,
        exceptionCount: insertedExceptions.length,
      },
      metadata: {
        orderId: input.orderId,
        orderType: input.orderType,
        ...(!input.receivedByUserId ? { systemActor: 'receiving_service' } : {}),
      },
    });

    const totalAccepted = input.lines.reduce((s, l) => s + l.quantityAccepted, 0);
    const totalDamaged = input.lines.reduce((s, l) => s + l.quantityDamaged, 0);
    const totalRejected = input.lines.reduce((s, l) => s + l.quantityRejected, 0);

    return {
      receipt,
      lines: insertedLines,
      exceptions: insertedExceptions,
      transitionedCardIds,
      eventPayload: {
        receiptId: receipt.id,
        receiptNumber,
        status,
        totalAccepted,
        totalDamaged,
        totalRejected,
        exceptions: insertedExceptions.map((exc) => ({
          id: exc.id,
          exceptionType: exc.exceptionType,
          severity: exc.severity,
          quantityAffected: exc.quantityAffected,
        })),
      },
    };
  });

  // Update inventory outside the main TX (adjustQuantity has its own TX)
  try {
    await updateInventoryAfterReceiving(input, result.receipt.id);
  } catch (err) {
    log.error(
      { err, receiptId: result.receipt.id, tenantId: input.tenantId },
      'Failed to update inventory after receiving — receipt committed, inventory may need manual adjustment'
    );
  }

  try {
    const eventBus = getEventBus(config.REDIS_URL);
    const timestamp = new Date().toISOString();

    await eventBus.publish({
      type: 'receiving.completed',
      tenantId: input.tenantId,
      receiptId: result.eventPayload.receiptId,
      receiptNumber: result.eventPayload.receiptNumber,
      orderType: input.orderType,
      orderId: input.orderId,
      status: result.eventPayload.status,
      totalAccepted: result.eventPayload.totalAccepted,
      totalDamaged: result.eventPayload.totalDamaged,
      totalRejected: result.eventPayload.totalRejected,
      exceptionsCreated: result.eventPayload.exceptions.length,
      timestamp,
    });

    // Publish KPI refresh for receiving completion
    void publishKpiRefreshed({
      tenantId: input.tenantId,
      mutationType: 'receiving.completed',
      source: 'orders',
      correlationId: getCorrelationId(),
    });

    for (const exc of result.eventPayload.exceptions) {
      await eventBus.publish({
        type: 'receiving.exception_created',
        tenantId: input.tenantId,
        exceptionId: exc.id,
        receiptId: result.eventPayload.receiptId,
        exceptionType: exc.exceptionType,
        severity: exc.severity,
        quantityAffected: exc.quantityAffected,
        orderId: input.orderId,
        orderType: input.orderType,
        timestamp,
      });
    }

    // Publish card transition events for kanban
    for (const cardId of result.transitionedCardIds) {
      await eventBus.publish({
        type: 'card.transition',
        tenantId: input.tenantId,
        cardId,
        loopId: '', // filled by consumer from card data
        fromStage: 'ordered',
        toStage: 'received',
        method: 'system',
        userId: input.receivedByUserId,
        timestamp,
      });
    }
  } catch (err) {
    log.error(
      { err, orderId: input.orderId, orderType: input.orderType, tenantId: input.tenantId },
      'Failed to publish receipt events after commit'
    );
  }

  log.info(
    {
      receiptId: result.receipt.id,
      receiptNumber: result.eventPayload.receiptNumber,
      status: result.eventPayload.status,
      exceptions: result.eventPayload.exceptions.length,
    },
    'Receipt processed'
  );

  return {
    receipt: result.receipt,
    lines: result.lines,
    exceptions: result.exceptions,
    transitionedCardIds: result.transitionedCardIds,
  };
}

// ─── Get Receipt ────────────────────────────────────────────────────

export async function getReceipt(tenantId: string, receiptId: string) {
  const [receipt] = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.tenantId, tenantId)));

  if (!receipt) return null;

  const lines = await db
    .select()
    .from(receiptLines)
    .where(eq(receiptLines.receiptId, receiptId));

  const exceptions = await db
    .select()
    .from(receivingExceptions)
    .where(eq(receivingExceptions.receiptId, receiptId));

  return { ...receipt, lines, exceptions };
}

// ─── Get Receipts for Order ─────────────────────────────────────────

export async function getReceiptsForOrder(tenantId: string, orderId: string) {
  return db
    .select()
    .from(receipts)
    .where(and(eq(receipts.orderId, orderId), eq(receipts.tenantId, tenantId)))
    .orderBy(desc(receipts.createdAt));
}

// ─── Get Open Exceptions ────────────────────────────────────────────

export async function getOpenExceptions(tenantId: string) {
  return db
    .select()
    .from(receivingExceptions)
    .where(
      and(
        eq(receivingExceptions.tenantId, tenantId),
        sql`${receivingExceptions.status} in ('open', 'in_progress')`
      )
    )
    .orderBy(desc(receivingExceptions.createdAt));
}

// ─── Get All Exceptions (including resolved) ────────────────────────

export async function getAllExceptions(tenantId: string) {
  return db
    .select()
    .from(receivingExceptions)
    .where(eq(receivingExceptions.tenantId, tenantId))
    .orderBy(desc(receivingExceptions.createdAt));
}

// ─── Resolve Exception ──────────────────────────────────────────────

export async function resolveException(input: ResolveExceptionInput) {
  const result = await db.transaction(async (tx) => {
    // Load exception
    const [exception] = await tx
      .select()
      .from(receivingExceptions)
      .where(
        and(
          eq(receivingExceptions.id, input.exceptionId),
          eq(receivingExceptions.tenantId, input.tenantId)
        )
      );

    if (!exception) {
      throw new AppError(404, 'Exception not found');
    }

    if (exception.status === 'resolved') {
      throw new AppError(409, 'Exception is already resolved');
    }

    // Update exception
    const [updated] = await tx
      .update(receivingExceptions)
      .set({
        status: 'resolved',
        resolutionType: input.resolutionType,
        resolutionNotes: input.resolutionNotes,
        resolvedByUserId: input.resolvedByUserId,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(receivingExceptions.id, input.exceptionId))
      .returning();

    // Audit log
    await writeAuditEntry(tx, {
      tenantId: input.tenantId,
      userId: input.resolvedByUserId ?? null,
      action: 'receipt.exception_resolved',
      entityType: 'receiving_exception',
      entityId: input.exceptionId,
      previousState: { status: exception.status },
      newState: { status: 'resolved', resolutionType: input.resolutionType },
      metadata: {
        receiptId: exception.receiptId,
        orderId: exception.orderId,
        ...(!input.resolvedByUserId ? { systemActor: 'receiving_service' } : {}),
      },
    });

    return {
      updated,
      eventPayload: {
        receiptId: exception.receiptId,
        exceptionType: exception.exceptionType,
      },
    };
  });

  try {
    const eventBus = getEventBus(config.REDIS_URL);
    await eventBus.publish({
      type: 'receiving.exception_resolved',
      tenantId: input.tenantId,
      exceptionId: input.exceptionId,
      receiptId: result.eventPayload.receiptId,
      exceptionType: result.eventPayload.exceptionType,
      resolutionType: input.resolutionType,
      resolvedByUserId: input.resolvedByUserId,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log.error(
      { err, exceptionId: input.exceptionId, tenantId: input.tenantId },
      'Failed to publish exception resolved event after commit'
    );
  }

  log.info(
    { exceptionId: input.exceptionId, resolutionType: input.resolutionType },
    'Exception resolved'
  );

  return result.updated;
}
