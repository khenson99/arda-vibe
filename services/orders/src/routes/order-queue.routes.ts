import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { eq, and, sql, inArray, asc } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import { getEventBus } from '@arda/events';
import { config } from '@arda/config';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';
import {
  getNextPONumber,
  getNextWONumber,
  getNextTONumber,
} from '../services/order-number.service.js';
import { transitionTriggeredCardToOrdered } from '../services/card-lifecycle.service.js';

export const orderQueueRouter = Router();

const {
  kanbanCards,
  kanbanLoops,
  cardStageTransitions,
  auditLog,
  suppliers,
  supplierParts,
  parts,
  purchaseOrders,
  purchaseOrderLines,
  workOrders,
  workOrderRoutings,
  transferOrders,
  transferOrderLines,
} = schema;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface RequestAuditContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

type QueueRiskLevel = 'medium' | 'high';

export interface QueueRiskItem {
  cardId: string;
  loopId: string;
  loopType: 'procurement' | 'production' | 'transfer';
  queueType: 'procurement' | 'production' | 'transfer';
  partId: string;
  facilityId: string;
  riskLevel: QueueRiskLevel;
  triggeredAgeHours: number;
  estimatedDaysOfSupply: number | null;
  reason: string;
  thresholds: {
    ageHours: {
      medium: number;
      high: number;
    };
    daysOfSupply: {
      medium: number;
      high: number;
    } | null;
  };
}

const DEFAULT_RISK_LOOKBACK_DAYS = 30;
const DEFAULT_LEAD_TIME_DAYS = 7;

export interface QueueRiskScanInput {
  tenantId: string;
  lookbackDays: number;
  limit: number;
  minRiskLevel: QueueRiskLevel;
  emitEvents: boolean;
  now?: Date;
}

export interface QueueRiskScanResult {
  generatedAt: string;
  lookbackDays: number;
  totalTriggeredCards: number;
  totalRisks: number;
  byRiskLevel: {
    medium: number;
    high: number;
  };
  emittedRiskEvents: number;
  risks: QueueRiskItem[];
}

function getRequestAuditContext(req: AuthRequest): RequestAuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0]?.trim();

  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

  return {
    userId: req.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

function parseNumberish(input: unknown, fallback = 0): number {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeQueueRisk(input: {
  card: {
    cardId: string;
    loopId: string;
    loopType: 'procurement' | 'production' | 'transfer';
    partId: string;
    facilityId: string;
    currentStageEnteredAt: Date | string;
    minQuantity: number;
    orderQuantity: number;
    statedLeadTimeDays: number | null;
    safetyStockDays: string | number | null;
  };
  triggerCount: number;
  lookbackDays: number;
  now: Date;
}): QueueRiskItem | null {
  const ageHours = Math.max(
    0,
    Math.floor(
      (input.now.getTime() - new Date(input.card.currentStageEnteredAt).getTime()) / (1000 * 60 * 60)
    )
  );

  const leadTimeDays = Math.max(
    1,
    parseNumberish(input.card.statedLeadTimeDays, DEFAULT_LEAD_TIME_DAYS)
  );
  const safetyStockDays = Math.max(0, parseNumberish(input.card.safetyStockDays, 0));

  const ageHighThreshold = Math.max(12, Math.round((leadTimeDays + safetyStockDays) * 24));
  const ageMediumThreshold = Math.max(8, Math.round(ageHighThreshold * 0.75));

  const estimatedDailyConsumption =
    input.triggerCount > 0
      ? (Math.max(1, input.card.orderQuantity) * input.triggerCount) / input.lookbackDays
      : null;
  const estimatedDaysOfSupply =
    estimatedDailyConsumption && estimatedDailyConsumption > 0
      ? roundTo(Math.max(0, input.card.minQuantity) / estimatedDailyConsumption)
      : null;

  const dosHighThreshold = roundTo(Math.max(1, Math.min(3, (leadTimeDays + safetyStockDays) * 0.35)));
  const dosMediumThreshold = roundTo(Math.max(dosHighThreshold + 1, Math.min(7, dosHighThreshold + 2)));

  let riskLevel: QueueRiskLevel | null = null;
  const reasons: string[] = [];

  if (ageHours >= ageHighThreshold) {
    riskLevel = 'high';
    reasons.push(`triggered age ${ageHours}h exceeds high threshold ${ageHighThreshold}h`);
  } else if (ageHours >= ageMediumThreshold) {
    riskLevel = 'medium';
    reasons.push(`triggered age ${ageHours}h exceeds medium threshold ${ageMediumThreshold}h`);
  }

  if (estimatedDaysOfSupply !== null) {
    if (estimatedDaysOfSupply <= dosHighThreshold) {
      riskLevel = 'high';
      reasons.push(
        `estimated days of supply ${estimatedDaysOfSupply} is below high threshold ${dosHighThreshold}`
      );
    } else if (estimatedDaysOfSupply <= dosMediumThreshold) {
      riskLevel = riskLevel === 'high' ? 'high' : 'medium';
      reasons.push(
        `estimated days of supply ${estimatedDaysOfSupply} is below medium threshold ${dosMediumThreshold}`
      );
    }
  }

  if (!riskLevel) {
    return null;
  }

  return {
    cardId: input.card.cardId,
    loopId: input.card.loopId,
    loopType: input.card.loopType,
    queueType: input.card.loopType,
    partId: input.card.partId,
    facilityId: input.card.facilityId,
    riskLevel,
    triggeredAgeHours: ageHours,
    estimatedDaysOfSupply,
    reason: reasons.join('; '),
    thresholds: {
      ageHours: {
        medium: ageMediumThreshold,
        high: ageHighThreshold,
      },
      daysOfSupply:
        estimatedDaysOfSupply === null
          ? null
          : {
              medium: dosMediumThreshold,
              high: dosHighThreshold,
            },
    },
  };
}

async function writeOrderQueueAudit(
  tx: DbTransaction,
  input: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    newState: Record<string, unknown>;
    metadata: Record<string, unknown>;
    context: RequestAuditContext;
  }
) {
  await tx.insert(auditLog).values({
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    previousState: null,
    newState: input.newState,
    metadata: input.metadata,
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
    timestamp: new Date(),
  });
}

async function writeCardTransitionAudit(
  tx: DbTransaction,
  input: {
    tenantId: string;
    transitionedCards: Array<{ cardId: string; loopId: string }>;
    orderType: 'purchase_order' | 'work_order' | 'transfer_order';
    orderId: string;
    orderNumber: string;
    context: RequestAuditContext;
  }
) {
  if (input.transitionedCards.length === 0) return;

  await tx.insert(auditLog).values(
    input.transitionedCards.map((card) => ({
      tenantId: input.tenantId,
      userId: input.context.userId,
      action: 'kanban_card.transitioned_to_ordered',
      entityType: 'kanban_card',
      entityId: card.cardId,
      previousState: { stage: 'triggered' },
      newState: {
        stage: 'ordered',
        orderType: input.orderType,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
      },
      metadata: {
        loopId: card.loopId,
        source: 'order_queue',
      },
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
      timestamp: new Date(),
    }))
  );
}

async function writePurchaseOrderStatusAuditFromQueue(
  tx: DbTransaction,
  input: {
    tenantId: string;
    poId: string;
    orderNumber: string;
    fromStatus: string;
    toStatus: string;
    context: RequestAuditContext;
    metadata: Record<string, unknown>;
  }
) {
  await tx.insert(auditLog).values({
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'purchase_order.status_changed',
    entityType: 'purchase_order',
    entityId: input.poId,
    previousState: { status: input.fromStatus },
    newState: { status: input.toStatus },
    metadata: {
      ...input.metadata,
      orderNumber: input.orderNumber,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
    timestamp: new Date(),
  });
}

async function publishOrderCreatedEvent(input: {
  tenantId: string;
  orderType: 'purchase_order' | 'work_order' | 'transfer_order';
  orderId: string;
  orderNumber: string;
  linkedCardIds: string[];
}) {
  try {
    const eventBus = getEventBus(config.REDIS_URL);
    await eventBus.publish({
      type: 'order.created',
      tenantId: input.tenantId,
      orderType: input.orderType,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      linkedCardIds: input.linkedCardIds,
      timestamp: new Date().toISOString(),
    });
  } catch {
    console.error(
      `[order-queue] Failed to publish order.created event for ${input.orderType} ${input.orderNumber}`
    );
  }
}

async function publishOrderStatusChangedEvent(input: {
  tenantId: string;
  orderId: string;
  orderNumber: string;
  fromStatus: string;
  toStatus: string;
}) {
  try {
    const eventBus = getEventBus(config.REDIS_URL);
    await eventBus.publish({
      type: 'order.status_changed',
      tenantId: input.tenantId,
      orderType: 'purchase_order',
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      timestamp: new Date().toISOString(),
    });
  } catch {
    console.error(
      `[order-queue] Failed to publish order.status_changed event for purchase order ${input.orderNumber}`
    );
  }
}

async function publishCardOrderedTransitions(input: {
  tenantId: string;
  cards: Array<{
    cardId: string;
    loopId: string;
  }>;
}) {
  if (input.cards.length === 0) return;

  const eventBus = getEventBus(config.REDIS_URL);

  await Promise.all(
    input.cards.map(async (card) => {
      try {
        await eventBus.publish({
          type: 'card.transition',
          tenantId: input.tenantId,
          cardId: card.cardId,
          loopId: card.loopId,
          fromStage: 'triggered',
          toStage: 'ordered',
          method: 'system',
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(
          `[order-queue] Failed to publish card.transition event for card ${card.cardId}`
        );
      }
    })
  );
}

export async function emitQueueOrderEvents(input: {
  tenantId: string;
  orderType: 'purchase_order' | 'work_order' | 'transfer_order';
  orderId: string;
  orderNumber: string;
  linkedCardIds: string[];
  transitionedCards: Array<{ cardId: string; loopId: string }>;
}) {
  await publishOrderCreatedEvent({
    tenantId: input.tenantId,
    orderType: input.orderType,
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    linkedCardIds: input.linkedCardIds,
  });

  await publishCardOrderedTransitions({
    tenantId: input.tenantId,
    cards: input.transitionedCards,
  });
}

export async function publishQueueRiskDetectedEvents(input: {
  tenantId: string;
  risks: QueueRiskItem[];
}) {
  if (input.risks.length === 0) return;

  let eventBus: ReturnType<typeof getEventBus>;
  try {
    eventBus = getEventBus(config.REDIS_URL);
  } catch {
    console.error('[order-queue] Failed to initialize event bus for queue risk events');
    return;
  }

  await Promise.all(
    input.risks.map(async (risk) => {
      try {
        await eventBus.publish({
          type: 'queue.risk_detected',
          tenantId: input.tenantId,
          queueType: risk.queueType,
          loopId: risk.loopId,
          cardId: risk.cardId,
          partId: risk.partId,
          facilityId: risk.facilityId,
          riskLevel: risk.riskLevel,
          triggeredAgeHours: risk.triggeredAgeHours,
          estimatedDaysOfSupply: risk.estimatedDaysOfSupply,
          reason: risk.reason,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(
          `[order-queue] Failed to publish queue.risk_detected event for card ${risk.cardId}`
        );
      }
    })
  );
}

export async function runQueueRiskScanForTenant(
  input: QueueRiskScanInput
): Promise<QueueRiskScanResult> {
  const now = input.now ?? new Date();
  const lookbackStart = new Date(now);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - input.lookbackDays);

  const triggeredCards = await db
    .select({
      cardId: kanbanCards.id,
      loopId: kanbanCards.loopId,
      currentStageEnteredAt: kanbanCards.currentStageEnteredAt,
      loopType: kanbanLoops.loopType,
      partId: kanbanLoops.partId,
      facilityId: kanbanLoops.facilityId,
      minQuantity: kanbanLoops.minQuantity,
      orderQuantity: kanbanLoops.orderQuantity,
      statedLeadTimeDays: kanbanLoops.statedLeadTimeDays,
      safetyStockDays: kanbanLoops.safetyStockDays,
    })
    .from(kanbanCards)
    .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
    .where(
      and(
        eq(kanbanCards.tenantId, input.tenantId),
        eq(kanbanCards.currentStage, 'triggered'),
        eq(kanbanCards.isActive, true),
        eq(kanbanLoops.isActive, true)
      )
    )
    .orderBy(asc(kanbanCards.currentStageEnteredAt))
    .execute();

  if (triggeredCards.length === 0) {
    return {
      generatedAt: now.toISOString(),
      lookbackDays: input.lookbackDays,
      totalTriggeredCards: 0,
      totalRisks: 0,
      byRiskLevel: { medium: 0, high: 0 },
      emittedRiskEvents: 0,
      risks: [],
    };
  }

  const uniqueLoopIds = Array.from(new Set(triggeredCards.map((row) => row.loopId)));

  const triggerCountsByLoop = await db
    .select({
      loopId: cardStageTransitions.loopId,
      triggerCount: sql<number>`CAST(COUNT(*) AS INTEGER)`,
    })
    .from(cardStageTransitions)
    .where(
      and(
        eq(cardStageTransitions.tenantId, input.tenantId),
        inArray(cardStageTransitions.loopId, uniqueLoopIds),
        eq(cardStageTransitions.toStage, 'triggered'),
        sql`${cardStageTransitions.transitionedAt} >= ${lookbackStart}`
      )
    )
    .groupBy(cardStageTransitions.loopId)
    .execute();

  const triggerCountMap = new Map(triggerCountsByLoop.map((row) => [row.loopId, row.triggerCount]));

  let risks = triggeredCards
    .map((card) =>
      computeQueueRisk({
        card,
        triggerCount: triggerCountMap.get(card.loopId) ?? 0,
        lookbackDays: input.lookbackDays,
        now,
      })
    )
    .filter((risk): risk is QueueRiskItem => risk !== null);

  if (input.minRiskLevel === 'high') {
    risks = risks.filter((risk) => risk.riskLevel === 'high');
  }

  risks.sort((a, b) => {
    if (a.riskLevel !== b.riskLevel) {
      return a.riskLevel === 'high' ? -1 : 1;
    }
    return b.triggeredAgeHours - a.triggeredAgeHours;
  });

  const limitedRisks = risks.slice(0, input.limit);

  if (input.emitEvents && limitedRisks.length > 0) {
    await publishQueueRiskDetectedEvents({ tenantId: input.tenantId, risks: limitedRisks });
  }

  const byRiskLevel = limitedRisks.reduce(
    (acc, risk) => {
      acc[risk.riskLevel] += 1;
      return acc;
    },
    { medium: 0, high: 0 }
  );

  return {
    generatedAt: now.toISOString(),
    lookbackDays: input.lookbackDays,
    totalTriggeredCards: triggeredCards.length,
    totalRisks: limitedRisks.length,
    byRiskLevel,
    emittedRiskEvents: input.emitEvents ? limitedRisks.length : 0,
    risks: limitedRisks,
  };
}

// Validation schemas
const createPOSchema = z.object({
  cardIds: z.array(z.string()).min(1, 'At least one card ID is required'),
  supplierId: z.string().optional(),
  facilityId: z.string().optional(),
  expectedDeliveryDate: z.string().datetime().optional(),
  notes: z.string().optional(),
});

const procurementOrderMethodSchema = z.enum([
  'email',
  'online',
  'purchase_order',
  'shopping',
  'rfq',
  'third_party',
  'phone',
]);

const createProcurementDraftSchema = z.object({
  supplierId: z.string().uuid(),
  recipient: z.string().max(255).optional().nullable(),
  recipientEmail: z.string().email().optional().nullable(),
  paymentTerms: z.string().max(500).optional().nullable(),
  shippingTerms: z.string().max(500).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  thirdPartyInstructions: z.string().max(4000).optional().nullable(),
  lines: z
    .array(
      z.object({
        cardId: z.string().uuid(),
        quantityOrdered: z.number().int().positive(),
        unitPrice: z.number().nonnegative().optional().nullable(),
        description: z.string().max(2000).optional().nullable(),
        orderMethod: procurementOrderMethodSchema,
        sourceUrl: z.string().url().optional().nullable(),
        notes: z.string().max(4000).optional().nullable(),
      })
    )
    .min(1, 'At least one procurement line is required'),
});

const verifyProcurementDraftSchema = z.object({
  poIds: z.array(z.string().uuid()).min(1, 'At least one draft purchase order is required'),
  cardIds: z.array(z.string().uuid()).min(1, 'At least one card ID is required'),
});

const createWOSchema = z.object({
  cardId: z.string(),
  routingSteps: z
    .array(
      z.object({
        workCenterId: z.string(),
        stepNumber: z.number().int().positive(),
        operationName: z.string(),
        estimatedMinutes: z.number().int().positive().optional(),
      })
    )
    .optional(),
  scheduledStartDate: z.string().datetime().optional(),
  scheduledEndDate: z.string().datetime().optional(),
  notes: z.string().optional(),
});

const createTOSchema = z.object({
  cardIds: z.array(z.string()).min(1, 'At least one card ID is required'),
  notes: z.string().optional(),
});

const queueRiskQuerySchema = z.object({
  lookbackDays: z.coerce.number().int().min(7).max(90).default(DEFAULT_RISK_LOOKBACK_DAYS),
  limit: z.coerce.number().int().positive().max(200).default(100),
  minRiskLevel: z.enum(['medium', 'high']).default('medium'),
  emitEvents: z
    .preprocess((value) => {
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
      return value;
    }, z.boolean())
    .default(true),
});

type ProcurementOrderMethod = z.infer<typeof procurementOrderMethodSchema>;

function validateProcurementDraftMethods(input: {
  lines: Array<{
    orderMethod: ProcurementOrderMethod;
    sourceUrl: string | null | undefined;
  }>;
  recipientEmail: string | null;
  supplierPhone: string | null;
  thirdPartyInstructions: string | null;
}) {
  const fieldErrors: Array<{ field: string; message: string }> = [];
  const methods = new Set(input.lines.map((line) => line.orderMethod));

  if (
    (methods.has('email') || methods.has('purchase_order') || methods.has('rfq')) &&
    !input.recipientEmail
  ) {
    fieldErrors.push({
      field: 'recipientEmail',
      message: 'Recipient email is required for email, purchase order, and RFQ methods',
    });
  }

  if (methods.has('phone') && !input.supplierPhone) {
    fieldErrors.push({
      field: 'supplierContactPhone',
      message: 'Supplier phone is required for phone orders',
    });
  }

  if (methods.has('third_party') && !input.thirdPartyInstructions) {
    fieldErrors.push({
      field: 'thirdPartyInstructions',
      message: 'Third-party instruction text is required for third-party orders',
    });
  }

  input.lines.forEach((line, index) => {
    if ((line.orderMethod === 'online' || line.orderMethod === 'shopping') && !line.sourceUrl) {
      fieldErrors.push({
        field: `lines[${index}].sourceUrl`,
        message: 'Source URL is required for online and shopping methods',
      });
    }
  });

  return fieldErrors;
}

// GET / - List all triggered cards needing orders
orderQueueRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { loopType } = req.query;
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Tenant ID not found');
    }

    // Build query to fetch triggered cards with loop details
    const conditions = [
      eq(kanbanCards.tenantId, tenantId),
      eq(kanbanCards.currentStage, 'triggered'),
      eq(kanbanCards.isActive, true),
    ];

    // Filter by loopType if provided
    if (loopType && ['procurement', 'production', 'transfer'].includes(String(loopType))) {
      conditions.push(eq(kanbanLoops.loopType, String(loopType) as (typeof schema.loopTypeEnum.enumValues)[number]));
    }

    const query = db
      .select({
        id: kanbanCards.id,
        cardNumber: kanbanCards.cardNumber,
        currentStage: kanbanCards.currentStage,
        currentStageEnteredAt: kanbanCards.currentStageEnteredAt,
        linkedPurchaseOrderId: kanbanCards.linkedPurchaseOrderId,
        linkedWorkOrderId: kanbanCards.linkedWorkOrderId,
        linkedTransferOrderId: kanbanCards.linkedTransferOrderId,
        loopId: kanbanCards.loopId,
        loopType: kanbanLoops.loopType,
        partId: kanbanLoops.partId,
        facilityId: kanbanLoops.facilityId,
        primarySupplierId: kanbanLoops.primarySupplierId,
        supplierName: suppliers.name,
        supplierRecipient: suppliers.recipient,
        supplierRecipientEmail: suppliers.recipientEmail,
        supplierContactEmail: suppliers.contactEmail,
        supplierContactPhone: suppliers.contactPhone,
        supplierPaymentTerms: suppliers.paymentTerms,
        supplierShippingTerms: suppliers.shippingTerms,
        supplierUnitCost: supplierParts.unitCost,
        partUnitPrice: parts.unitPrice,
        sourceFacilityId: kanbanLoops.sourceFacilityId,
        orderQuantity: kanbanLoops.orderQuantity,
        minQuantity: kanbanLoops.minQuantity,
        numberOfCards: kanbanLoops.numberOfCards,
        draftPurchaseOrderId: sql<string | null>`
          (
            select pol.purchase_order_id
            from orders.purchase_order_lines pol
            inner join orders.purchase_orders po on po.id = pol.purchase_order_id
            where pol.tenant_id = ${tenantId}
              and po.tenant_id = ${tenantId}
              and pol.kanban_card_id = ${kanbanCards.id}
              and po.status = 'draft'
            order by po.created_at desc
            limit 1
          )
        `.as('draftPurchaseOrderId'),
      })
      .from(kanbanCards)
      .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
      .leftJoin(
        parts,
        and(eq(parts.id, kanbanLoops.partId), eq(parts.tenantId, tenantId))
      )
      .leftJoin(
        suppliers,
        and(eq(suppliers.id, kanbanLoops.primarySupplierId), eq(suppliers.tenantId, tenantId))
      )
      .leftJoin(
        supplierParts,
        and(
          eq(supplierParts.partId, kanbanLoops.partId),
          eq(supplierParts.supplierId, kanbanLoops.primarySupplierId),
          eq(supplierParts.tenantId, tenantId),
          eq(supplierParts.isActive, true)
        )
      )
      .where(and(...conditions))
      .orderBy(asc(kanbanCards.currentStageEnteredAt));

    const cards = await query.execute();

    // Group by loop type for response
    const grouped = cards.reduce(
      (acc, card) => {
        if (!acc[card.loopType]) {
          acc[card.loopType] = [];
        }
        acc[card.loopType].push(card);
        return acc;
      },
      {} as Record<string, typeof cards>
    );

    res.json({
      success: true,
      data: grouped,
      total: cards.length,
    });
  } catch (error) {
    next(error);
  }
});

// GET /summary - Queue summary by loop type
orderQueueRouter.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Tenant ID not found');
    }

    // Get triggered cards with loop type
    const triggeredCards = await db
      .select({
        loopType: kanbanLoops.loopType,
        count: sql<number>`count(*)`.as('count'),
        oldestStageEnteredAt: sql<string>`min(${kanbanCards.currentStageEnteredAt})`.as(
          'oldestStageEnteredAt'
        ),
      })
      .from(kanbanCards)
      .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
      .where(
        and(
          eq(kanbanCards.tenantId, tenantId),
          eq(kanbanCards.currentStage, 'triggered'),
          eq(kanbanCards.isActive, true)
        )
      )
      .groupBy(kanbanLoops.loopType)
      .execute();

    // Calculate total and oldest
    const totalTriggered = triggeredCards.reduce((sum, row) => sum + row.count, 0);
    const oldestEnteredAt = triggeredCards.reduce((oldest, row) => {
      if (!oldest || new Date(row.oldestStageEnteredAt) < new Date(oldest)) {
        return row.oldestStageEnteredAt;
      }
      return oldest;
    }, null as string | null);

    const oldestCardAge = oldestEnteredAt
      ? Math.floor((Date.now() - new Date(oldestEnteredAt).getTime()) / (1000 * 60 * 60))
      : 0; // in hours

    const summary = {
      totalAwaitingOrders: totalTriggered,
      oldestCardAgeHours: oldestCardAge,
      byLoopType: {} as Record<string, number>,
    };

    triggeredCards.forEach((row) => {
      summary.byLoopType[row.loopType] = row.count;
    });

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
});

// GET /risk-scan - Detect queue stockout risks from triggered card age + days-of-supply
orderQueueRouter.get('/risk-scan', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Tenant ID not found');
    }

    const { lookbackDays, limit, minRiskLevel, emitEvents } = queueRiskQuerySchema.parse(req.query);
    const result = await runQueueRiskScanForTenant({
      tenantId,
      lookbackDays,
      limit,
      minRiskLevel,
      emitEvents,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

async function createProcurementDraftsHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user?.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Tenant ID not found');
    }

    const validatedData = createProcurementDraftSchema.parse(req.body);
    const cardIds = Array.from(new Set(validatedData.lines.map((line) => line.cardId)));

    if (cardIds.length !== validatedData.lines.length) {
      return res.status(400).json({
        error: 'Each procurement line must target a unique card ID',
        details: {
          fields: [{ field: 'lines', message: 'Duplicate cardId values are not allowed' }],
        },
      });
    }

    const lineByCardId = new Map(validatedData.lines.map((line) => [line.cardId, line]));

    const cards = await db
      .select({
        id: kanbanCards.id,
        currentStage: kanbanCards.currentStage,
        loopId: kanbanCards.loopId,
        cardNumber: kanbanCards.cardNumber,
        loopType: kanbanLoops.loopType,
        partId: kanbanLoops.partId,
        facilityId: kanbanLoops.facilityId,
        primarySupplierId: kanbanLoops.primarySupplierId,
        supplierName: suppliers.name,
        supplierRecipient: suppliers.recipient,
        supplierRecipientEmail: suppliers.recipientEmail,
        supplierContactEmail: suppliers.contactEmail,
        supplierContactPhone: suppliers.contactPhone,
        supplierPaymentTerms: suppliers.paymentTerms,
        supplierShippingTerms: suppliers.shippingTerms,
        supplierUnitCost: supplierParts.unitCost,
        partUnitPrice: parts.unitPrice,
      })
      .from(kanbanCards)
      .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
      .leftJoin(
        parts,
        and(eq(parts.id, kanbanLoops.partId), eq(parts.tenantId, tenantId))
      )
      .leftJoin(
        suppliers,
        and(eq(suppliers.id, kanbanLoops.primarySupplierId), eq(suppliers.tenantId, tenantId))
      )
      .leftJoin(
        supplierParts,
        and(
          eq(supplierParts.partId, kanbanLoops.partId),
          eq(supplierParts.supplierId, kanbanLoops.primarySupplierId),
          eq(supplierParts.tenantId, tenantId),
          eq(supplierParts.isActive, true)
        )
      )
      .where(and(eq(kanbanCards.tenantId, tenantId), inArray(kanbanCards.id, cardIds)))
      .execute();

    if (cards.length !== cardIds.length) {
      throw new AppError(404, 'One or more card IDs not found');
    }

    const invalidTriggered = cards.filter((card) => card.currentStage !== 'triggered');
    if (invalidTriggered.length > 0) {
      throw new AppError(400, 'All cards must be in triggered stage');
    }

    const invalidLoopType = cards.filter((card) => card.loopType !== 'procurement');
    if (invalidLoopType.length > 0) {
      throw new AppError(400, 'All cards must belong to procurement loops');
    }

    const invalidSupplier = cards.filter(
      (card) => card.primarySupplierId !== validatedData.supplierId
    );
    if (invalidSupplier.length > 0) {
      throw new AppError(400, 'All cards must belong to the selected supplier');
    }

    const existingDraftLinks = await db
      .select({
        cardId: purchaseOrderLines.kanbanCardId,
        purchaseOrderId: purchaseOrderLines.purchaseOrderId,
        poNumber: purchaseOrders.poNumber,
      })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
      .where(
        and(
          eq(purchaseOrderLines.tenantId, tenantId),
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.status, 'draft'),
          inArray(purchaseOrderLines.kanbanCardId, cardIds)
        )
      )
      .execute();

    const openDraftConflicts = existingDraftLinks
      .filter((row): row is { cardId: string; purchaseOrderId: string; poNumber: string } => !!row.cardId)
      .map((row) => ({
        cardId: row.cardId,
        purchaseOrderId: row.purchaseOrderId,
        poNumber: row.poNumber,
      }));

    if (openDraftConflicts.length > 0) {
      return res.status(409).json({
        error: 'One or more cards already belong to an open draft purchase order',
        details: {
          conflicts: openDraftConflicts,
        },
      });
    }

    const supplierRecipient = cards[0]?.supplierRecipient?.trim() || null;
    const supplierRecipientEmail = cards[0]?.supplierRecipientEmail?.trim() || null;
    const supplierContactEmail = cards[0]?.supplierContactEmail?.trim() || null;
    const supplierContactPhone = cards[0]?.supplierContactPhone?.trim() || null;
    const recipient = validatedData.recipient?.trim() || supplierRecipient;
    const recipientEmail = validatedData.recipientEmail?.trim() || supplierRecipientEmail || supplierContactEmail;
    const thirdPartyInstructions = validatedData.thirdPartyInstructions?.trim() || null;

    const methodValidationErrors = validateProcurementDraftMethods({
      lines: validatedData.lines.map((line) => ({
        orderMethod: line.orderMethod,
        sourceUrl: line.sourceUrl,
      })),
      recipientEmail,
      supplierPhone: supplierContactPhone,
      thirdPartyInstructions,
    });

    if (methodValidationErrors.length > 0) {
      return res.status(400).json({
        error: 'Method-specific validation failed',
        details: {
          fields: methodValidationErrors,
        },
      });
    }

    const notes = validatedData.notes?.trim() || null;
    const paymentTerms = validatedData.paymentTerms?.trim() || cards[0]?.supplierPaymentTerms?.trim() || null;
    const shippingTerms = validatedData.shippingTerms?.trim() || cards[0]?.supplierShippingTerms?.trim() || null;
    const cardById = new Map(cards.map((card) => [card.id, card]));

    const result = await db.transaction(async (tx) => {
      const cardsByFacility = new Map<string, typeof cards>();
      cards.forEach((card) => {
        const existing = cardsByFacility.get(card.facilityId) ?? [];
        existing.push(card);
        cardsByFacility.set(card.facilityId, existing);
      });

      const drafts: Array<{
        poId: string;
        poNumber: string;
        facilityId: string;
        cardIds: string[];
        lineTotalAmount: number;
      }> = [];

      for (const [facilityId, facilityCards] of cardsByFacility.entries()) {
        const poNumber = await getNextPONumber(tenantId);
        const [createdPO] = await tx
          .insert(purchaseOrders)
          .values({
            tenantId,
            poNumber,
            supplierId: validatedData.supplierId,
            facilityId,
            status: 'draft',
            notes,
            paymentTerms,
            shippingTerms,
            sentToEmail: recipientEmail,
          })
          .returning({ id: purchaseOrders.id })
          .execute();

        const lineValues = facilityCards.map((card, index) => {
          const line = lineByCardId.get(card.id)!;
          const explicitUnitPrice = line.unitPrice != null ? Number(line.unitPrice) : NaN;
          const supplierCost = Number(card.supplierUnitCost);
          const partPrice = Number(card.partUnitPrice);
          const resolvedUnitPrice = Number.isFinite(explicitUnitPrice)
            ? explicitUnitPrice
            : Number.isFinite(supplierCost)
              ? supplierCost
              : Number.isFinite(partPrice)
                ? partPrice
                : 0;
          const normalizedUnitPrice = Math.max(0, roundTo(resolvedUnitPrice, 4));
          const lineTotalAmount = Math.max(0, roundTo(normalizedUnitPrice * line.quantityOrdered, 4));

          return {
            tenantId,
            purchaseOrderId: createdPO.id,
            partId: card.partId,
            kanbanCardId: card.id,
            lineNumber: index + 1,
            quantityOrdered: line.quantityOrdered,
            quantityReceived: 0,
            unitCost: normalizedUnitPrice.toFixed(4),
            lineTotal: lineTotalAmount.toFixed(4),
            notes: line.notes?.trim() || notes,
            description: line.description?.trim() || null,
            orderMethod: line.orderMethod,
            sourceUrl: line.sourceUrl?.trim() || null,
          };
        });

        await tx
          .insert(purchaseOrderLines)
          .values(lineValues)
          .execute();

        const lineTotalAmount = lineValues.reduce((sum, line) => sum + Number(line.lineTotal), 0);

        await writeOrderQueueAudit(tx, {
          tenantId,
          action: 'order_queue.procurement_draft_created',
          entityType: 'purchase_order',
          entityId: createdPO.id,
          newState: {
            status: 'draft',
            poNumber,
            facilityId,
            supplierId: validatedData.supplierId,
            lineCount: facilityCards.length,
          },
          metadata: {
            source: 'order_queue.procurement_create_drafts',
            linkedCardIds: facilityCards.map((card) => card.id),
            recipientEmail,
          },
          context: auditContext,
        });

        drafts.push({
          poId: createdPO.id,
          poNumber,
          facilityId,
          cardIds: facilityCards.map((card) => card.id),
          lineTotalAmount: roundTo(lineTotalAmount, 4),
        });
      }

      return { drafts };
    });

    await Promise.all(
      result.drafts.map(async (draft) => {
        await publishOrderCreatedEvent({
          tenantId,
          orderType: 'purchase_order',
          orderId: draft.poId,
          orderNumber: draft.poNumber,
          linkedCardIds: draft.cardIds,
        });
      })
    );

    res.status(201).json({
      success: true,
      message: `Created ${result.drafts.length} procurement draft purchase order(s)`,
      data: {
        supplierId: validatedData.supplierId,
        recipient,
        recipientEmail,
        drafts: result.drafts,
        totalDrafts: result.drafts.length,
        totalCards: cardIds.length,
        totalAmount: roundTo(result.drafts.reduce((sum, draft) => sum + draft.lineTotalAmount, 0), 4),
        pricingSource: {
          defaultOrder: ['line.unitPrice', 'supplier_parts.unit_cost', 'parts.unit_price', 'fallback_zero'],
          cardIds: cardIds.map((cardId) => ({
            cardId,
            supplierUnitCost: cardById.get(cardId)?.supplierUnitCost ?? null,
            partUnitPrice: cardById.get(cardId)?.partUnitPrice ?? null,
          })),
        },
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, `Validation error: ${error.errors[0].message}`));
    }
    next(error);
  }
}

// POST /procurement/create-drafts - Create procurement draft purchase orders grouped by facility
orderQueueRouter.post('/procurement/create-drafts', createProcurementDraftsHandler);
// Compatibility alias: /queue/create-drafts
orderQueueRouter.post('/create-drafts', createProcurementDraftsHandler);

async function verifyProcurementDraftsHandler(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user?.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Tenant ID not found');
    }

    const validatedData = verifyProcurementDraftSchema.parse(req.body);
    const poIds = Array.from(new Set(validatedData.poIds));
    const expectedCardIds = Array.from(new Set(validatedData.cardIds));

    const purchaseOrderRecords = await db
      .select({
        id: purchaseOrders.id,
        poNumber: purchaseOrders.poNumber,
        status: purchaseOrders.status,
        supplierId: purchaseOrders.supplierId,
        sentToEmail: purchaseOrders.sentToEmail,
        supplierContactEmail: suppliers.contactEmail,
      })
      .from(purchaseOrders)
      .leftJoin(
        suppliers,
        and(eq(suppliers.id, purchaseOrders.supplierId), eq(suppliers.tenantId, tenantId))
      )
      .where(and(eq(purchaseOrders.tenantId, tenantId), inArray(purchaseOrders.id, poIds)))
      .execute();

    if (purchaseOrderRecords.length !== poIds.length) {
      throw new AppError(404, 'One or more draft purchase orders were not found');
    }

    const nonDraftOrders = purchaseOrderRecords.filter((po) => po.status !== 'draft');
    if (nonDraftOrders.length > 0) {
      throw new AppError(409, 'All purchase orders must still be in draft status before verify');
    }

    const draftLines = await db
      .select({
        poId: purchaseOrderLines.purchaseOrderId,
        cardId: purchaseOrderLines.kanbanCardId,
      })
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.tenantId, tenantId),
          inArray(purchaseOrderLines.purchaseOrderId, poIds)
        )
      )
      .execute();

    const lineLinks = draftLines.filter(
      (line): line is { poId: string; cardId: string } => !!line.cardId
    );

    const linkedCardIds = Array.from(new Set(lineLinks.map((line) => line.cardId)));
    const expectedSet = new Set(expectedCardIds);
    const linkedSet = new Set(linkedCardIds);
    const sameCardSet =
      expectedSet.size === linkedSet.size &&
      Array.from(expectedSet).every((cardId) => linkedSet.has(cardId));

    if (!sameCardSet) {
      return res.status(409).json({
        error: 'Draft purchase order lines no longer match expected cards',
        details: {
          expectedCardIds,
          linkedCardIds,
        },
      });
    }

    const cards = await db
      .select({
        id: kanbanCards.id,
        currentStage: kanbanCards.currentStage,
      })
      .from(kanbanCards)
      .where(and(eq(kanbanCards.tenantId, tenantId), inArray(kanbanCards.id, expectedCardIds)))
      .execute();

    if (cards.length !== expectedCardIds.length) {
      throw new AppError(404, 'One or more cards were not found');
    }

    const nonTriggered = cards.filter((card) => card.currentStage !== 'triggered');
    if (nonTriggered.length > 0) {
      throw new AppError(409, 'All cards must still be in triggered stage before verification');
    }

    const cardToPoMap = new Map<string, string>();
    for (const link of lineLinks) {
      if (cardToPoMap.has(link.cardId) && cardToPoMap.get(link.cardId) !== link.poId) {
        throw new AppError(409, 'A card is linked to multiple draft purchase orders');
      }
      cardToPoMap.set(link.cardId, link.poId);
    }

    const result = await db.transaction(async (tx) => {
      const transitionedCards: Array<{ cardId: string; loopId: string }> = [];
      const updatedOrders: Array<{ poId: string; poNumber: string }> = [];
      const now = new Date();

      for (const po of purchaseOrderRecords) {
        const poCardIds = lineLinks
          .filter((line) => line.poId === po.id)
          .map((line) => line.cardId);
        const sentToEmail = po.sentToEmail || po.supplierContactEmail || null;

        await tx
          .update(purchaseOrders)
          .set({
            status: 'sent',
            sentAt: now,
            sentToEmail,
            updatedAt: now,
          })
          .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.tenantId, tenantId)))
          .execute();

        await writePurchaseOrderStatusAuditFromQueue(tx, {
          tenantId,
          poId: po.id,
          orderNumber: po.poNumber,
          fromStatus: po.status,
          toStatus: 'sent',
          metadata: {
            source: 'order_queue.procurement_verify',
            linkedCardIds: poCardIds,
          },
          context: auditContext,
        });

        const transitionedForPO: Array<{ cardId: string; loopId: string }> = [];
        for (const cardId of poCardIds) {
          const linkedPurchaseOrderId = cardToPoMap.get(cardId);
          if (!linkedPurchaseOrderId) {
            throw new AppError(409, `Card ${cardId} is not linked to a provided draft purchase order`);
          }
          const transitioned = await transitionTriggeredCardToOrdered(tx, {
            tenantId,
            cardId,
            linkedPurchaseOrderId,
            notes: `Verified procurement order for ${po.poNumber}`,
            userId: auditContext.userId,
          });
          transitionedCards.push(transitioned);
          transitionedForPO.push(transitioned);
        }

        await writeCardTransitionAudit(tx, {
          tenantId,
          transitionedCards: transitionedForPO,
          orderType: 'purchase_order',
          orderId: po.id,
          orderNumber: po.poNumber,
          context: auditContext,
        });

        await writeOrderQueueAudit(tx, {
          tenantId,
          action: 'order_queue.procurement_verified',
          entityType: 'purchase_order',
          entityId: po.id,
          newState: {
            status: 'sent',
            poNumber: po.poNumber,
            sentAt: now.toISOString(),
          },
          metadata: {
            source: 'order_queue.procurement_verify',
            linkedCardIds: poCardIds,
          },
          context: auditContext,
        });

        updatedOrders.push({ poId: po.id, poNumber: po.poNumber });
      }

      return { transitionedCards, updatedOrders };
    });

    await Promise.all(
      result.updatedOrders.map((order) =>
        publishOrderStatusChangedEvent({
          tenantId,
          orderId: order.poId,
          orderNumber: order.poNumber,
          fromStatus: 'draft',
          toStatus: 'sent',
        })
      )
    );

    await publishCardOrderedTransitions({
      tenantId,
      cards: result.transitionedCards,
    });

    res.json({
      success: true,
      message: `Verified ${result.updatedOrders.length} draft purchase order(s)`,
      data: {
        poIds: result.updatedOrders.map((order) => order.poId),
        cardIds: expectedCardIds,
        transitionedCards: result.transitionedCards.length,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, `Validation error: ${error.errors[0].message}`));
    }
    next(error);
  }
}

// POST /procurement/verify - Mark drafts as sent and transition cards triggered->ordered
orderQueueRouter.post('/procurement/verify', verifyProcurementDraftsHandler);
// Compatibility alias: /queue/verify
orderQueueRouter.post('/verify', verifyProcurementDraftsHandler);

// POST /create-po - Create Purchase Order from triggered cards
orderQueueRouter.post('/create-po', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Tenant ID not found');
    }

    const validatedData = createPOSchema.parse(req.body);
    const { cardIds, supplierId, facilityId, expectedDeliveryDate, notes } = validatedData;

    // Fetch all cards to validate
    const cards = await db
      .select({
        id: kanbanCards.id,
        tenantId: kanbanCards.tenantId,
        currentStage: kanbanCards.currentStage,
        loopId: kanbanCards.loopId,
        completedCycles: kanbanCards.completedCycles,
      })
      .from(kanbanCards)
      .where(
        and(
          inArray(kanbanCards.id, cardIds),
          eq(kanbanCards.tenantId, tenantId),
        )
      )
      .execute();

    // Validate all cards belong to tenant and are triggered
    if (cards.length !== cardIds.length) {
      throw new AppError(404, 'One or more card IDs not found');
    }

    if (cards.some((c) => c.tenantId !== tenantId)) {
      throw new AppError(403, 'Invalid card access');
    }

    if (cards.some((c) => c.currentStage !== 'triggered')) {
      throw new AppError(400, 'All cards must be in triggered stage');
    }

    // Fetch loops for all cards
    const loops = await db
      .select({
        id: kanbanLoops.id,
        loopType: kanbanLoops.loopType,
        partId: kanbanLoops.partId,
        facilityId: kanbanLoops.facilityId,
        primarySupplierId: kanbanLoops.primarySupplierId,
        orderQuantity: kanbanLoops.orderQuantity,
      })
      .from(kanbanLoops)
      .where(
        and(
          inArray(kanbanLoops.id, cards.map((c) => c.loopId)),
          eq(kanbanLoops.tenantId, tenantId),
        )
      )
      .execute();

    // Validate all loops are procurement type
    if (loops.some((l) => l.loopType !== 'procurement')) {
      throw new AppError(400, 'All cards must be from procurement loops');
    }

    // Map loop details to cards
    const cardLoopMap = new Map(loops.map((l) => [l.id, l]));
    const cardDetails = cards.map((c) => ({
      ...c,
      loopDetails: cardLoopMap.get(c.loopId)!,
    }));

    // Execute transaction
    const result = await db.transaction(async (tx) => {
      // Generate PO number
      const poNumber = await getNextPONumber(tenantId);

      // Create PO
      const insertedPO = await tx
        .insert(purchaseOrders)
        .values({
          poNumber,
          tenantId,
          supplierId: supplierId || cardDetails[0].loopDetails.primarySupplierId!,
          facilityId: facilityId || cardDetails[0].loopDetails.facilityId,
          status: 'draft',
          expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : undefined,
          notes: notes || undefined,
        })
        .returning({ id: purchaseOrders.id })
        .execute();

      const poId = insertedPO[0].id;

      const transitionedCards: Array<{ cardId: string; loopId: string }> = [];

      // Create PO lines and update cards
      for (let i = 0; i < cardDetails.length; i++) {
        const cardDetail = cardDetails[i];
        const loopDetail = cardDetail.loopDetails;

        // Insert PO line
        await tx
          .insert(purchaseOrderLines)
          .values({
            tenantId,
            purchaseOrderId: poId,
            lineNumber: i + 1,
            partId: loopDetail.partId,
            quantityOrdered: loopDetail.orderQuantity,
            quantityReceived: 0,
            unitCost: '0',
            lineTotal: '0',
            notes: notes || null,
          })
          .execute();

        const transitionedCard = await transitionTriggeredCardToOrdered(tx, {
          tenantId,
          cardId: cardDetail.id,
          linkedPurchaseOrderId: poId,
          notes: `Created PO ${poNumber}`,
          userId: auditContext.userId,
        });

        transitionedCards.push(transitionedCard);
      }

      await writeOrderQueueAudit(tx, {
        tenantId,
        action: 'order_queue.purchase_order_created',
        entityType: 'purchase_order',
        entityId: poId,
        newState: {
          status: 'draft',
          poNumber,
          lineCount: cardDetails.length,
        },
        metadata: {
          source: 'order_queue',
          linkedCardIds: cardIds,
        },
        context: auditContext,
      });

      await writeCardTransitionAudit(tx, {
        tenantId,
        transitionedCards,
        orderType: 'purchase_order',
        orderId: poId,
        orderNumber: poNumber,
        context: auditContext,
      });

      return { poId, poNumber, transitionedCards };
    });

    await emitQueueOrderEvents({
      tenantId,
      orderType: 'purchase_order',
      orderId: result.poId,
      orderNumber: result.poNumber,
      linkedCardIds: cardIds,
      transitionedCards: result.transitionedCards,
    });

    res.status(201).json({
      success: true,
      message: `Purchase Order ${result.poNumber} created with ${cardIds.length} line(s)`,
      data: {
        poId: result.poId,
        poNumber: result.poNumber,
        cardsLinked: cardIds.length,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, `Validation error: ${error.errors[0].message}`));
    }
    next(error);
  }
});

// POST /create-wo - Create Work Order from triggered production card
orderQueueRouter.post('/create-wo', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Tenant ID not found');
    }

    const validatedData = createWOSchema.parse(req.body);
    const { cardId, routingSteps, scheduledStartDate, scheduledEndDate, notes } = validatedData;

    // Fetch card with loop details
    const cardResult = await db
      .select({
        id: kanbanCards.id,
        tenantId: kanbanCards.tenantId,
        currentStage: kanbanCards.currentStage,
        loopId: kanbanCards.loopId,
        completedCycles: kanbanCards.completedCycles,
        loopType: kanbanLoops.loopType,
        partId: kanbanLoops.partId,
        facilityId: kanbanLoops.facilityId,
        orderQuantity: kanbanLoops.orderQuantity,
      })
      .from(kanbanCards)
      .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
      .where(
        and(
          eq(kanbanCards.id, cardId),
          eq(kanbanCards.tenantId, tenantId),
        )
      )
      .execute();

    if (cardResult.length === 0) {
      throw new AppError(404, 'Card not found');
    }

    const card = cardResult[0];

    // Validate tenant, stage, and loop type
    if (card.tenantId !== tenantId) {
      throw new AppError(403, 'Invalid card access');
    }

    if (card.currentStage !== 'triggered') {
      throw new AppError(400, 'Card must be in triggered stage');
    }

    if (card.loopType !== 'production') {
      throw new AppError(400, 'Card must be from a production loop');
    }

    // Execute transaction
    const result = await db.transaction(async (tx) => {
      // Generate WO number
      const woNumber = await getNextWONumber(tenantId);

      // Create WO
      const insertedWO = await tx
        .insert(workOrders)
        .values({
          woNumber,
          tenantId,
          partId: card.partId,
          facilityId: card.facilityId,
          quantityToProduce: card.orderQuantity,
          quantityProduced: 0,
          quantityRejected: 0,
          status: 'draft',
          scheduledStartDate: scheduledStartDate ? new Date(scheduledStartDate) : null,
          scheduledEndDate: scheduledEndDate ? new Date(scheduledEndDate) : null,
          notes: notes || null,
          createdByUserId: null,
        })
        .returning({ id: workOrders.id })
        .execute();

      const woId = insertedWO[0].id;

      // Insert routing steps if provided
      if (routingSteps && routingSteps.length > 0) {
        for (const step of routingSteps) {
          await tx
            .insert(workOrderRoutings)
            .values({
              tenantId,
              workOrderId: woId,
              workCenterId: step.workCenterId,
              stepNumber: step.stepNumber,
              operationName: step.operationName,
              status: 'pending',
              estimatedMinutes: step.estimatedMinutes || null,
            })
            .execute();
        }
      }

      const transitionedCard = await transitionTriggeredCardToOrdered(tx, {
        tenantId,
        cardId,
        linkedWorkOrderId: woId,
        notes: `Created WO ${woNumber}`,
        userId: auditContext.userId,
      });

      await writeOrderQueueAudit(tx, {
        tenantId,
        action: 'order_queue.work_order_created',
        entityType: 'work_order',
        entityId: woId,
        newState: {
          status: 'draft',
          woNumber,
          quantityToProduce: card.orderQuantity,
        },
        metadata: {
          source: 'order_queue',
          linkedCardIds: [cardId],
        },
        context: auditContext,
      });

      await writeCardTransitionAudit(tx, {
        tenantId,
        transitionedCards: [transitionedCard],
        orderType: 'work_order',
        orderId: woId,
        orderNumber: woNumber,
        context: auditContext,
      });

      return {
        woId,
        woNumber,
        transitionedCards: [transitionedCard],
      };
    });

    await emitQueueOrderEvents({
      tenantId,
      orderType: 'work_order',
      orderId: result.woId,
      orderNumber: result.woNumber,
      linkedCardIds: [cardId],
      transitionedCards: result.transitionedCards,
    });

    res.status(201).json({
      success: true,
      message: `Work Order ${result.woNumber} created`,
      data: {
        woId: result.woId,
        woNumber: result.woNumber,
        quantity: card.orderQuantity,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, `Validation error: ${error.errors[0].message}`));
    }
    next(error);
  }
});

// POST /create-to - Create Transfer Order from triggered transfer cards
orderQueueRouter.post('/create-to', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Tenant ID not found');
    }

    const validatedData = createTOSchema.parse(req.body);
    const { cardIds, notes } = validatedData;

    // Fetch all cards with loop details
    const cardResults = await db
      .select({
        id: kanbanCards.id,
        tenantId: kanbanCards.tenantId,
        currentStage: kanbanCards.currentStage,
        loopId: kanbanCards.loopId,
        completedCycles: kanbanCards.completedCycles,
        loopType: kanbanLoops.loopType,
        partId: kanbanLoops.partId,
        facilityId: kanbanLoops.facilityId,
        sourceFacilityId: kanbanLoops.sourceFacilityId,
        orderQuantity: kanbanLoops.orderQuantity,
      })
      .from(kanbanCards)
      .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
      .where(
        and(
          inArray(kanbanCards.id, cardIds),
          eq(kanbanCards.tenantId, tenantId),
        )
      )
      .execute();

    // Validate all cards found
    if (cardResults.length !== cardIds.length) {
      throw new AppError(404, 'One or more card IDs not found');
    }

    // Validate tenant access and stage
    if (cardResults.some((c) => c.tenantId !== tenantId)) {
      throw new AppError(403, 'Invalid card access');
    }

    if (cardResults.some((c) => c.currentStage !== 'triggered')) {
      throw new AppError(400, 'All cards must be in triggered stage');
    }

    // Validate all are transfer loops
    if (cardResults.some((c) => c.loopType !== 'transfer')) {
      throw new AppError(400, 'All cards must be from transfer loops');
    }

    // Execute transaction
    const result = await db.transaction(async (tx) => {
      // Generate TO number
      const toNumber = await getNextTONumber(tenantId);

      // Create TO
      const insertedTO = await tx
        .insert(transferOrders)
        .values({
          toNumber,
          tenantId,
          sourceFacilityId: cardResults[0].sourceFacilityId!,
          destinationFacilityId: cardResults[0].facilityId,
          status: 'draft',
          notes: notes || undefined,
        })
        .returning({ id: transferOrders.id })
        .execute();

      const toId = insertedTO[0].id;

      const transitionedCards: Array<{ cardId: string; loopId: string }> = [];

      // Create TO lines and update cards
      for (let i = 0; i < cardResults.length; i++) {
        const card = cardResults[i];

        // Insert TO line
        await tx
          .insert(transferOrderLines)
          .values({
            tenantId,
            transferOrderId: toId,
            partId: card.partId,
            quantityRequested: card.orderQuantity,
            quantityShipped: 0,
            quantityReceived: 0,
            notes: notes || null,
          })
          .execute();

        const transitionedCard = await transitionTriggeredCardToOrdered(tx, {
          tenantId,
          cardId: card.id,
          linkedTransferOrderId: toId,
          notes: `Created TO ${toNumber}`,
          userId: auditContext.userId,
        });

        transitionedCards.push(transitionedCard);
      }

      await writeOrderQueueAudit(tx, {
        tenantId,
        action: 'order_queue.transfer_order_created',
        entityType: 'transfer_order',
        entityId: toId,
        newState: {
          status: 'draft',
          toNumber,
          lineCount: cardResults.length,
        },
        metadata: {
          source: 'order_queue',
          linkedCardIds: cardIds,
        },
        context: auditContext,
      });

      await writeCardTransitionAudit(tx, {
        tenantId,
        transitionedCards,
        orderType: 'transfer_order',
        orderId: toId,
        orderNumber: toNumber,
        context: auditContext,
      });

      return { toId, toNumber, transitionedCards };
    });

    await emitQueueOrderEvents({
      tenantId,
      orderType: 'transfer_order',
      orderId: result.toId,
      orderNumber: result.toNumber,
      linkedCardIds: cardIds,
      transitionedCards: result.transitionedCards,
    });

    res.status(201).json({
      success: true,
      message: `Transfer Order ${result.toNumber} created with ${cardIds.length} line(s)`,
      data: {
        toId: result.toId,
        toNumber: result.toNumber,
        cardsLinked: cardIds.length,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, `Validation error: ${error.errors[0].message}`));
    }
    next(error);
  }
});
