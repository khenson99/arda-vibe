/**
 * Production Exception Service (Ticket #77)
 *
 * Handles production exceptions and requeue hooks:
 * - Scrap threshold detection -> auto-create rework WO
 * - Material shortage on hold -> trigger procurement requeue
 * - Quality hold -> create quality exception record
 * - Completion with short quantity -> exception + potential requeue
 *
 * These hooks fire automatically when certain conditions are met
 * during WO lifecycle transitions. They bridge production exceptions
 * back into the procurement and production queues.
 */

import { db, schema } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import { getEventBus } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';

const log = createLogger('production-exception');

const {
  workOrders,
  workOrderRoutings,
  productionOperationLogs,
  productionQueueEntries,
  auditLog,
  kanbanCards,
} = schema;

// ─── Types ────────────────────────────────────────────────────────────

export type ProductionExceptionType =
  | 'scrap_threshold'
  | 'material_shortage'
  | 'quality_hold'
  | 'short_completion'
  | 'equipment_failure';

export interface ProductionException {
  id: string;
  workOrderId: string;
  woNumber: string;
  exceptionType: ProductionExceptionType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  quantityAffected: number;
  autoAction: string | null;
  autoActionResult: string | null;
  createdAt: string;
}

export interface ScrapCheckResult {
  exceededThreshold: boolean;
  scrapRate: number;
  threshold: number;
  reworkWOCreated: boolean;
  reworkWorkOrderId?: string;
}

export interface ShortageRequeueResult {
  requeued: boolean;
  reason: string;
  cardId?: string;
}

// ─── Scrap Threshold Check ──────────────────────────────────────────

/**
 * Check if a work order's scrap rate exceeds the configurable threshold.
 * If so, automatically create a rework WO for the scrapped quantity.
 *
 * Default scrap threshold: 10% of quantityToProduce.
 */
export async function checkScrapThreshold(
  tenantId: string,
  workOrderId: string,
  scrapThresholdPercent: number = 10,
  userId?: string
): Promise<ScrapCheckResult> {
  const [wo] = await db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
    .execute();

  if (!wo) throw new AppError(404, `Work order ${workOrderId} not found`);

  const scrapRate =
    wo.quantityToProduce > 0
      ? (wo.quantityScrapped / wo.quantityToProduce) * 100
      : 0;

  if (scrapRate <= scrapThresholdPercent) {
    return {
      exceededThreshold: false,
      scrapRate: Math.round(scrapRate * 100) / 100,
      threshold: scrapThresholdPercent,
      reworkWOCreated: false,
    };
  }

  log.warn(
    { workOrderId, scrapRate: scrapRate.toFixed(1), threshold: scrapThresholdPercent },
    'Scrap threshold exceeded, creating rework WO'
  );

  // Create a rework WO for the scrapped quantity
  const now = new Date();
  const reworkWoNumber = `${wo.woNumber}-RW`;

  const [reworkWo] = await db
    .insert(workOrders)
    .values({
      tenantId,
      woNumber: reworkWoNumber,
      kanbanCardId: wo.kanbanCardId,
      partId: wo.partId,
      facilityId: wo.facilityId,
      quantityToProduce: wo.quantityScrapped,
      quantityProduced: 0,
      quantityScrapped: 0,
      status: 'draft',
      isExpedited: wo.isExpedited,
      isRework: true,
      parentWorkOrderId: workOrderId,
      routingTemplateId: wo.routingTemplateId,
      priority: Math.min(100, wo.priority + 10), // bump priority for rework
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: workOrders.id })
    .execute();

  // Create queue entry for the rework WO
  await db.insert(productionQueueEntries).values({
    tenantId,
    workOrderId: reworkWo.id,
    cardId: wo.kanbanCardId,
    partId: wo.partId,
    facilityId: wo.facilityId,
    priorityScore: String(Math.min(100, wo.priority + 10)),
    manualPriority: Math.min(100, wo.priority + 10),
    status: 'pending',
    enteredQueueAt: now,
  });

  // Log the rework creation
  await db.insert(productionOperationLogs).values({
    tenantId,
    workOrderId,
    operationType: 'rework',
    quantityProduced: 0,
    quantityRejected: 0,
    quantityScrapped: wo.quantityScrapped,
    notes: `Auto-rework: scrap rate ${scrapRate.toFixed(1)}% exceeded ${scrapThresholdPercent}% threshold. Rework WO: ${reworkWoNumber}`,
    operatorUserId: userId || null,
  });

  // Audit
  await db.insert(auditLog).values({
    tenantId,
    userId: userId || null,
    action: 'production_exception.scrap_rework',
    entityType: 'work_order',
    entityId: workOrderId,
    previousState: { scrapRate: scrapRate.toFixed(1), quantityScrapped: wo.quantityScrapped },
    newState: { reworkWorkOrderId: reworkWo.id, reworkWoNumber, reworkQuantity: wo.quantityScrapped },
    metadata: { threshold: scrapThresholdPercent, source: 'production_exception' },
    ipAddress: null,
    userAgent: null,
    timestamp: now,
  });

  // Publish rework event
  try {
    const eventBus = getEventBus(config.REDIS_URL);
    await eventBus.publish({
      type: 'production.rework',
      tenantId,
      originalWorkOrderId: workOrderId,
      reworkWorkOrderId: reworkWo.id,
      reworkQuantity: wo.quantityScrapped,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    log.error({ err, workOrderId }, 'Failed to publish rework event');
  }

  return {
    exceededThreshold: true,
    scrapRate: Math.round(scrapRate * 100) / 100,
    threshold: scrapThresholdPercent,
    reworkWOCreated: true,
    reworkWorkOrderId: reworkWo.id,
  };
}

// ─── Material Shortage Requeue ──────────────────────────────────────

/**
 * When a WO is placed on hold for material_shortage, check if the
 * linked Kanban card should be re-triggered for procurement.
 *
 * This bridges production shortages back into the procurement queue
 * so that material can be ordered to resume production.
 */
export async function handleMaterialShortageHold(
  tenantId: string,
  workOrderId: string,
  userId?: string
): Promise<ShortageRequeueResult> {
  const [wo] = await db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
    .execute();

  if (!wo) throw new AppError(404, `Work order ${workOrderId} not found`);

  if (wo.holdReason !== 'material_shortage') {
    return { requeued: false, reason: 'WO is not on hold for material shortage' };
  }

  if (!wo.kanbanCardId) {
    return { requeued: false, reason: 'WO has no linked Kanban card' };
  }

  // Check if the card's loop is a production loop that needs material
  const [card] = await db
    .select({
      id: kanbanCards.id,
      loopId: kanbanCards.loopId,
      currentStage: kanbanCards.currentStage,
    })
    .from(kanbanCards)
    .where(and(eq(kanbanCards.id, wo.kanbanCardId), eq(kanbanCards.tenantId, tenantId)))
    .execute();

  if (!card) {
    return { requeued: false, reason: 'Linked Kanban card not found' };
  }

  const now = new Date();

  // Log the shortage notification
  await db.insert(productionOperationLogs).values({
    tenantId,
    workOrderId,
    operationType: 'hold',
    notes: `Material shortage detected. Card ${card.id} flagged for procurement review.`,
    operatorUserId: userId || null,
  });

  // Audit the requeue intent
  await db.insert(auditLog).values({
    tenantId,
    userId: userId || null,
    action: 'production_exception.material_shortage_requeue',
    entityType: 'work_order',
    entityId: workOrderId,
    previousState: { holdReason: 'material_shortage' },
    newState: { cardId: card.id, loopId: card.loopId, requeueIntent: true },
    metadata: { source: 'production_exception' },
    ipAddress: null,
    userAgent: null,
    timestamp: now,
  });

  // Publish event for procurement queue to pick up
  try {
    const eventBus = getEventBus(config.REDIS_URL);
    await eventBus.publish({
      type: 'production.hold',
      tenantId,
      workOrderId,
      workOrderNumber: wo.woNumber,
      holdReason: 'material_shortage',
      holdNotes: wo.holdNotes || undefined,
      userId,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    log.error({ err, workOrderId }, 'Failed to publish material shortage hold event');
  }

  log.info(
    { workOrderId, cardId: card.id },
    'Material shortage hold processed; procurement requeue signaled'
  );

  return {
    requeued: true,
    reason: 'Material shortage flagged for procurement review',
    cardId: card.id,
  };
}

// ─── Short Completion Check ─────────────────────────────────────────

/**
 * When a WO is completed with less than the required quantity,
 * determine if a follow-up WO should be created for the shortfall.
 *
 * Configurable tolerance: default 5% under-production is acceptable.
 */
export async function checkShortCompletion(
  tenantId: string,
  workOrderId: string,
  tolerancePercent: number = 5,
  userId?: string
): Promise<{
  isShort: boolean;
  shortfall: number;
  shortfallPercent: number;
  followUpCreated: boolean;
  followUpWorkOrderId?: string;
}> {
  const [wo] = await db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
    .execute();

  if (!wo) throw new AppError(404, `Work order ${workOrderId} not found`);

  const shortfall = wo.quantityToProduce - wo.quantityProduced;
  const shortfallPercent =
    wo.quantityToProduce > 0
      ? (shortfall / wo.quantityToProduce) * 100
      : 0;

  if (shortfall <= 0 || shortfallPercent <= tolerancePercent) {
    return {
      isShort: false,
      shortfall: Math.max(0, shortfall),
      shortfallPercent: Math.round(shortfallPercent * 100) / 100,
      followUpCreated: false,
    };
  }

  log.warn(
    {
      workOrderId,
      shortfall,
      shortfallPercent: shortfallPercent.toFixed(1),
      tolerance: tolerancePercent,
    },
    'Short completion detected, creating follow-up WO'
  );

  const now = new Date();
  const followUpWoNumber = `${wo.woNumber}-FU`;

  const [followUpWo] = await db
    .insert(workOrders)
    .values({
      tenantId,
      woNumber: followUpWoNumber,
      kanbanCardId: wo.kanbanCardId,
      partId: wo.partId,
      facilityId: wo.facilityId,
      quantityToProduce: shortfall,
      quantityProduced: 0,
      quantityScrapped: 0,
      status: 'draft',
      isExpedited: wo.isExpedited,
      isRework: false,
      parentWorkOrderId: workOrderId,
      routingTemplateId: wo.routingTemplateId,
      priority: wo.priority,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: workOrders.id })
    .execute();

  // Create queue entry
  await db.insert(productionQueueEntries).values({
    tenantId,
    workOrderId: followUpWo.id,
    cardId: wo.kanbanCardId,
    partId: wo.partId,
    facilityId: wo.facilityId,
    priorityScore: String(wo.priority),
    manualPriority: wo.priority,
    status: 'pending',
    enteredQueueAt: now,
  });

  // Audit
  await db.insert(auditLog).values({
    tenantId,
    userId: userId || null,
    action: 'production_exception.short_completion_followup',
    entityType: 'work_order',
    entityId: workOrderId,
    previousState: { quantityToProduce: wo.quantityToProduce, quantityProduced: wo.quantityProduced },
    newState: {
      shortfall,
      shortfallPercent: shortfallPercent.toFixed(1),
      followUpWorkOrderId: followUpWo.id,
      followUpWoNumber,
    },
    metadata: { tolerancePercent, source: 'production_exception' },
    ipAddress: null,
    userAgent: null,
    timestamp: now,
  });

  return {
    isShort: true,
    shortfall,
    shortfallPercent: Math.round(shortfallPercent * 100) / 100,
    followUpCreated: true,
    followUpWorkOrderId: followUpWo.id,
  };
}

// ─── Batch Exception Processing ─────────────────────────────────────

/**
 * Run all applicable exception checks for a completed work order.
 * Called automatically after WO completion posting.
 */
export async function processCompletionExceptions(
  tenantId: string,
  workOrderId: string,
  userId?: string
): Promise<{
  scrapCheck: ScrapCheckResult;
  shortCheck: Awaited<ReturnType<typeof checkShortCompletion>>;
}> {
  const scrapCheck = await checkScrapThreshold(tenantId, workOrderId, 10, userId);
  const shortCheck = await checkShortCompletion(tenantId, workOrderId, 5, userId);

  return { scrapCheck, shortCheck };
}
