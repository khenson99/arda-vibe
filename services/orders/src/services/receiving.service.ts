import { eq, and, sql, desc } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import { getEventBus, publishKpiRefreshed } from '@arda/events';
import { getCorrelationId } from '@arda/observability';
import { config, createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';

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
