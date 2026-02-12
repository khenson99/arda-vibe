import { eq, and, sql } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import { getEventBus } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { getNextPONumber } from './order-number.service.js';

const log = createLogger('exception-automation');

const {
  receivingExceptions,
  purchaseOrders,
  purchaseOrderLines,
} = schema;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Types ──────────────────────────────────────────────────────────

type AutomatedAction = 'auto_resolve' | 'follow_up_po' | 'escalate';

interface AutomationResult {
  exceptionId: string;
  action: AutomatedAction;
  success: boolean;
  detail: string;
  followUpOrderId?: string;
}

// ─── Rules Engine ───────────────────────────────────────────────────

/**
 * Determines the automated action for a given exception.
 *
 * Decision tree:
 * - Overage → auto-resolve (accept as-is)
 * - Short shipment with high/critical severity → create follow-up PO
 * - All others → escalate for manual review
 */
export function determineAutomatedAction(
  exceptionType: string,
  severity: string
): AutomatedAction {
  if (exceptionType === 'overage') {
    return 'auto_resolve';
  }

  if (exceptionType === 'short_shipment' && (severity === 'high' || severity === 'critical')) {
    return 'follow_up_po';
  }

  return 'escalate';
}

// ─── Auto-Resolve ───────────────────────────────────────────────────

async function autoResolveException(
  tx: DbTransaction,
  exception: typeof receivingExceptions.$inferSelect
): Promise<AutomationResult> {
  await tx
    .update(receivingExceptions)
    .set({
      status: 'resolved',
      resolutionType: 'accept_as_is',
      resolutionNotes: 'Auto-resolved: overage accepted as-is by automation.',
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(receivingExceptions.id, exception.id));

  await writeAuditEntry(tx, {
    tenantId: exception.tenantId,
    userId: null,
    action: 'receiving.exception_auto_resolved',
    entityType: 'receiving_exception',
    entityId: exception.id,
    previousState: { status: exception.status },
    newState: { status: 'resolved', resolutionType: 'accept_as_is' },
    metadata: { automation: true, systemActor: 'exception_automation' },
  });

  return {
    exceptionId: exception.id,
    action: 'auto_resolve',
    success: true,
    detail: 'Overage auto-accepted',
  };
}

// ─── Create Follow-Up PO ────────────────────────────────────────────

async function createFollowUpPO(
  tx: DbTransaction,
  exception: typeof receivingExceptions.$inferSelect
): Promise<AutomationResult> {
  if (exception.orderType !== 'purchase_order') {
    return {
      exceptionId: exception.id,
      action: 'follow_up_po',
      success: false,
      detail: `Cannot create follow-up PO for order type ${exception.orderType}`,
    };
  }

  // Load the original PO to copy supplier/facility
  const [originalPO] = await tx
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.id, exception.orderId),
        eq(purchaseOrders.tenantId, exception.tenantId)
      )
    );

  if (!originalPO) {
    return {
      exceptionId: exception.id,
      action: 'follow_up_po',
      success: false,
      detail: 'Original PO not found',
    };
  }

  // Load the original PO line matching the receipt line's part
  // We need the part info from the receipt line
  const [receiptLine] = exception.receiptLineId
    ? await tx
        .select()
        .from(schema.receiptLines)
        .where(eq(schema.receiptLines.id, exception.receiptLineId))
    : [null];

  const partId = receiptLine?.partId;
  if (!partId) {
    return {
      exceptionId: exception.id,
      action: 'follow_up_po',
      success: false,
      detail: 'Cannot determine part ID for follow-up PO',
    };
  }

  // Find original line unit cost
  const [originalLine] = await tx
    .select()
    .from(purchaseOrderLines)
    .where(
      and(
        eq(purchaseOrderLines.purchaseOrderId, originalPO.id),
        eq(purchaseOrderLines.partId, partId),
        eq(purchaseOrderLines.tenantId, exception.tenantId)
      )
    );

  const unitCost = originalLine?.unitCost ?? '0';
  const lineTotal = (parseFloat(unitCost) * exception.quantityAffected).toFixed(2);

  // Generate new PO number
  const poNumber = await getNextPONumber(exception.tenantId, tx);

  // Create follow-up PO
  const deliveryDate = new Date();
  deliveryDate.setDate(deliveryDate.getDate() + 14);

  const [followUpPO] = await tx
    .insert(purchaseOrders)
    .values({
      tenantId: exception.tenantId,
      poNumber,
      supplierId: originalPO.supplierId,
      facilityId: originalPO.facilityId,
      status: 'draft',
      orderDate: new Date(),
      expectedDeliveryDate: deliveryDate,
      subtotal: lineTotal,
      totalAmount: lineTotal,
      currency: originalPO.currency ?? 'USD',
      notes: `Follow-up PO for short shipment on ${originalPO.poNumber}`,
      internalNotes: `Auto-created from exception ${exception.id}`,
    })
    .returning();

  // Create PO line
  await tx.insert(purchaseOrderLines).values({
    tenantId: exception.tenantId,
    purchaseOrderId: followUpPO.id,
    partId,
    lineNumber: 1,
    quantityOrdered: exception.quantityAffected,
    unitCost,
    lineTotal,
  });

  // Resolve the exception
  await tx
    .update(receivingExceptions)
    .set({
      status: 'resolved',
      resolutionType: 'follow_up_po',
      resolutionNotes: `Follow-up PO ${poNumber} created for ${exception.quantityAffected} units`,
      resolvedAt: new Date(),
      followUpOrderId: followUpPO.id,
      updatedAt: new Date(),
    })
    .where(eq(receivingExceptions.id, exception.id));

  // Audit log
  await writeAuditEntry(tx, {
    tenantId: exception.tenantId,
    userId: null,
    action: 'receiving.follow_up_po_created',
    entityType: 'receiving_exception',
    entityId: exception.id,
    previousState: { status: exception.status },
    newState: {
      status: 'resolved',
      resolutionType: 'follow_up_po',
      followUpOrderId: followUpPO.id,
    },
    metadata: {
      automation: true,
      systemActor: 'exception_automation',
      followUpPONumber: poNumber,
      originalPONumber: originalPO.poNumber,
    },
  });

  return {
    exceptionId: exception.id,
    action: 'follow_up_po',
    success: true,
    detail: `Follow-up PO ${poNumber} created`,
    followUpOrderId: followUpPO.id,
  };
}

// ─── Escalate ───────────────────────────────────────────────────────

async function escalateException(
  tx: DbTransaction,
  exception: typeof receivingExceptions.$inferSelect
): Promise<AutomationResult> {
  await tx
    .update(receivingExceptions)
    .set({
      status: 'in_progress',
      updatedAt: new Date(),
    })
    .where(eq(receivingExceptions.id, exception.id));

  await writeAuditEntry(tx, {
    tenantId: exception.tenantId,
    userId: null,
    action: 'receiving.exception_escalated',
    entityType: 'receiving_exception',
    entityId: exception.id,
    previousState: { status: exception.status },
    newState: { status: 'in_progress' },
    metadata: { automation: true, systemActor: 'exception_automation', reason: 'Requires manual review' },
  });

  return {
    exceptionId: exception.id,
    action: 'escalate',
    success: true,
    detail: 'Escalated to manual review',
  };
}

// ─── Emit Automation Events ─────────────────────────────────────────

async function emitAutomationEvents(
  result: AutomationResult,
  exception: typeof receivingExceptions.$inferSelect
) {
  const eventBus = getEventBus(config.REDIS_URL);

  if (result.action === 'auto_resolve' || result.action === 'follow_up_po') {
    await eventBus.publish({
      type: 'receiving.exception_resolved',
      tenantId: exception.tenantId,
      exceptionId: exception.id,
      receiptId: exception.receiptId,
      exceptionType: exception.exceptionType,
      resolutionType: result.action === 'auto_resolve' ? 'accept_as_is' : 'follow_up_po',
      followUpOrderId: result.followUpOrderId,
      timestamp: new Date().toISOString(),
    });
  }

  if (result.followUpOrderId) {
    await eventBus.publish({
      type: 'order.created',
      tenantId: exception.tenantId,
      orderType: 'purchase_order',
      orderId: result.followUpOrderId,
      orderNumber: result.detail.replace('Follow-up PO ', '').replace(' created', ''),
      linkedCardIds: [],
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── Main: Process Exception Automation ─────────────────────────────

export async function processExceptionAutomation(
  tenantId: string,
  exceptionId: string
): Promise<AutomationResult> {
  // Load exception
  const [exception] = await db
    .select()
    .from(receivingExceptions)
    .where(
      and(
        eq(receivingExceptions.id, exceptionId),
        eq(receivingExceptions.tenantId, tenantId)
      )
    );

  if (!exception) {
    return { exceptionId, action: 'escalate', success: false, detail: 'Exception not found' };
  }

  if (exception.status === 'resolved') {
    return { exceptionId, action: 'escalate', success: false, detail: 'Already resolved' };
  }

  const action = determineAutomatedAction(exception.exceptionType, exception.severity);

  const result = await db.transaction(async (tx) => {
    switch (action) {
      case 'auto_resolve':
        return autoResolveException(tx, exception);
      case 'follow_up_po':
        return createFollowUpPO(tx, exception);
      case 'escalate':
        return escalateException(tx, exception);
    }
  });

  // Emit events outside the transaction
  if (result.success) {
    await emitAutomationEvents(result, exception);
  }

  log.info({ exceptionId, action: result.action, success: result.success }, 'Automation completed');
  return result;
}

// ─── Batch: Process All Open Exceptions ─────────────────────────────

export async function processAllOpenExceptions(tenantId: string): Promise<AutomationResult[]> {
  const openExceptions = await db
    .select()
    .from(receivingExceptions)
    .where(
      and(
        eq(receivingExceptions.tenantId, tenantId),
        eq(receivingExceptions.status, 'open')
      )
    );

  const results: AutomationResult[] = [];
  for (const exception of openExceptions) {
    try {
      const result = await processExceptionAutomation(tenantId, exception.id);
      results.push(result);
    } catch (err) {
      log.error({ exceptionId: exception.id, err }, 'Automation failed for exception');
      results.push({
        exceptionId: exception.id,
        action: 'escalate',
        success: false,
        detail: `Automation error: ${err instanceof Error ? err.message : 'unknown'}`,
      });
    }
  }

  log.info({ tenantId, total: results.length, succeeded: results.filter(r => r.success).length }, 'Batch automation complete');
  return results;
}
