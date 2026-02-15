import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, gte, lte } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { DbOrTransaction } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { getEventBus } from '@arda/events';
import { config } from '@arda/config';
import type { UserRole, TransferStatus } from '@arda/shared-types';
import { AppError } from '../middleware/error-handler.js';
import { getNextTONumber } from '../services/order-number.service.js';
import {
  validateTransferTransition,
  getValidNextTransferStatuses,
} from '../services/transfer-lifecycle.service.js';
import { recommendSources } from '../services/source-recommendation.service.js';
import { getTransferQueue } from '../services/transfer-queue.service.js';

export const transferOrdersRouter = Router();
const { transferOrders, transferOrderLines, leadTimeHistory } = schema;

interface RequestAuditContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
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

async function writeTransferOrderStatusAudit(
  tx: DbOrTransaction,
  input: {
    tenantId: string;
    transferOrderId: string;
    transferOrderNumber: string;
    fromStatus: string;
    toStatus: string;
    context: RequestAuditContext;
    metadata: Record<string, unknown>;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'transfer_order.status_changed',
    entityType: 'transfer_order',
    entityId: input.transferOrderId,
    previousState: { status: input.fromStatus },
    newState: { status: input.toStatus },
    metadata: {
      ...input.metadata,
      transferOrderNumber: input.transferOrderNumber,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

async function writeTransferOrderCreateAudit(
  tx: DbOrTransaction,
  input: {
    tenantId: string;
    transferOrderId: string;
    transferOrderNumber: string;
    initialStatus: string;
    lineCount: number;
    context: RequestAuditContext;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'transfer_order.created',
    entityType: 'transfer_order',
    entityId: input.transferOrderId,
    previousState: null,
    newState: {
      status: input.initialStatus,
      lineCount: input.lineCount,
    },
    metadata: {
      source: 'transfer_orders.create',
      transferOrderNumber: input.transferOrderNumber,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

async function writeTransferOrderLinesShippedAudit(
  tx: DbOrTransaction,
  input: {
    tenantId: string;
    transferOrderId: string;
    transferOrderNumber: string;
    status: string;
    shippedLineChanges: Array<{
      lineId: string;
      fromQuantityShipped: number;
      toQuantityShipped: number;
    }>;
    context: RequestAuditContext;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'transfer_order.lines_shipped',
    entityType: 'transfer_order',
    entityId: input.transferOrderId,
    previousState: {
      status: input.status,
      lineChanges: input.shippedLineChanges.map((line) => ({
        lineId: line.lineId,
        quantityShipped: line.fromQuantityShipped,
      })),
    },
    newState: {
      status: input.status,
      lineChanges: input.shippedLineChanges.map((line) => ({
        lineId: line.lineId,
        quantityShipped: line.toQuantityShipped,
      })),
    },
    metadata: {
      source: 'transfer_orders.ship',
      transferOrderNumber: input.transferOrderNumber,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

async function writeTransferOrderLinesReceivedAudit(
  tx: DbOrTransaction,
  input: {
    tenantId: string;
    transferOrderId: string;
    transferOrderNumber: string;
    status: string;
    receivedLineChanges: Array<{
      lineId: string;
      fromQuantityReceived: number;
      toQuantityReceived: number;
    }>;
    context: RequestAuditContext;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'transfer_order.lines_received',
    entityType: 'transfer_order',
    entityId: input.transferOrderId,
    previousState: {
      status: input.status,
      lineChanges: input.receivedLineChanges.map((line) => ({
        lineId: line.lineId,
        quantityReceived: line.fromQuantityReceived,
      })),
    },
    newState: {
      status: input.status,
      lineChanges: input.receivedLineChanges.map((line) => ({
        lineId: line.lineId,
        quantityReceived: line.toQuantityReceived,
      })),
    },
    metadata: {
      source: 'transfer_orders.receive',
      transferOrderNumber: input.transferOrderNumber,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

// Validation schemas
const createTransferOrderSchema = z.object({
  sourceFacilityId: z.string().uuid(),
  destinationFacilityId: z.string().uuid(),
  notes: z.string().optional(),
  lines: z.array(
    z.object({
      partId: z.string().uuid(),
      quantityRequested: z.number().int().positive(),
    })
  ).min(1),
});

const statusTransitionSchema = z.object({
  status: z.enum(['draft', 'requested', 'approved', 'picking', 'shipped', 'in_transit', 'received', 'closed', 'cancelled']),
  reason: z.string().optional(),
});

const shipLinesSchema = z.object({
  lines: z.array(
    z.object({
      lineId: z.string().uuid(),
      quantityShipped: z.number().int().nonnegative(),
    })
  ).min(1),
});

const receiveLinesSchema = z.object({
  lines: z.array(
    z.object({
      lineId: z.string().uuid(),
      quantityReceived: z.number().int().nonnegative(),
    })
  ).min(1),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
  sourceFacilityId: z.string().uuid().optional(),
  destinationFacilityId: z.string().uuid().optional(),
});

// GET / - List transfer orders with pagination and filters
transferOrdersRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { page, limit, status, sourceFacilityId, destinationFacilityId } = paginationSchema.parse(req.query);
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const offset = (page - 1) * limit;
    const conditions = [eq(transferOrders.tenantId, tenantId)];

    if (status) {
      conditions.push(eq(transferOrders.status, status as (typeof schema.transferStatusEnum.enumValues)[number]));
    }
    if (sourceFacilityId) {
      conditions.push(eq(transferOrders.sourceFacilityId, sourceFacilityId));
    }
    if (destinationFacilityId) {
      conditions.push(eq(transferOrders.destinationFacilityId, destinationFacilityId));
    }

    const orders = await db
      .select()
      .from(transferOrders)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      .orderBy(sql`${transferOrders.createdAt} DESC`);

    const [{ count }] = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(transferOrders)
      .where(and(...conditions));

    res.json({
      data: orders,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── Transfer Queue ──────────────────────────────────────────────────

const transferQueueSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  destinationFacilityId: z.string().uuid().optional(),
  sourceFacilityId: z.string().uuid().optional(),
  status: z.enum(['draft', 'requested', 'triggered', 'below_reorder']).optional(),
  partId: z.string().uuid().optional(),
  minPriorityScore: z.coerce.number().optional(),
  maxPriorityScore: z.coerce.number().optional(),
});

// GET /queue - Get aggregated transfer queue with prioritized recommendations
// NOTE: This route MUST be registered before /:id routes
transferOrdersRouter.get('/queue', async (req: AuthRequest, res, next) => {
  try {
    const params = transferQueueSchema.parse(req.query);
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const offset = (params.page - 1) * params.limit;

    const result = await getTransferQueue({
      tenantId,
      filters: {
        destinationFacilityId: params.destinationFacilityId,
        sourceFacilityId: params.sourceFacilityId,
        status: params.status,
        partId: params.partId,
        minPriorityScore: params.minPriorityScore,
        maxPriorityScore: params.maxPriorityScore,
      },
      limit: params.limit,
      offset,
    });

    res.json({
      data: result.items,
      pagination: {
        page: params.page,
        limit: params.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / params.limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── Source Recommendation ──────────────────────────────────────────────

const sourceRecommendationSchema = z.object({
  destinationFacilityId: z.string().uuid(),
  partId: z.string().uuid(),
  minQty: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

// GET /recommendations/source - Get ranked source facilities for a part
// NOTE: This route MUST be registered before /:id routes to avoid matching "recommendations" as an id param
transferOrdersRouter.get('/recommendations/source', async (req: AuthRequest, res, next) => {
  try {
    const params = sourceRecommendationSchema.parse(req.query);
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const recommendations = await recommendSources({
      tenantId,
      destinationFacilityId: params.destinationFacilityId,
      partId: params.partId,
      minQty: params.minQty,
      limit: params.limit,
    });

    res.json({ data: recommendations });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── Lead-Time Analytics ─────────────────────────────────────────────────

/** Coerce a query-string value to a Date, rejecting anything that produces an Invalid Date. */
const zDateString = z
  .string()
  .transform((val, ctx) => {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
      return z.NEVER;
    }
    return d;
  });

const leadTimeFilterSchema = z.object({
  sourceFacilityId: z.string().uuid().optional(),
  destinationFacilityId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
  fromDate: zDateString.optional(),
  toDate: zDateString.optional(),
});

// GET /lead-times — aggregate lead-time statistics
transferOrdersRouter.get('/lead-times', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const filters = leadTimeFilterSchema.parse(req.query);
    const conditions = [eq(leadTimeHistory.tenantId, tenantId)];

    if (filters.sourceFacilityId) {
      conditions.push(eq(leadTimeHistory.sourceFacilityId, filters.sourceFacilityId));
    }
    if (filters.destinationFacilityId) {
      conditions.push(eq(leadTimeHistory.destinationFacilityId, filters.destinationFacilityId));
    }
    if (filters.partId) {
      conditions.push(eq(leadTimeHistory.partId, filters.partId));
    }
    if (filters.fromDate) {
      conditions.push(gte(leadTimeHistory.receivedAt, filters.fromDate));
    }
    if (filters.toDate) {
      conditions.push(lte(leadTimeHistory.receivedAt, filters.toDate));
    }

    const [result] = await db
      .select({
        avgLeadTimeDays: sql<number>`round(avg(${leadTimeHistory.leadTimeDays}::numeric), 2)::float`,
        medianLeadTimeDays: sql<number>`round(percentile_cont(0.5) within group (order by ${leadTimeHistory.leadTimeDays}::numeric), 2)::float`,
        p90LeadTimeDays: sql<number>`round(percentile_cont(0.9) within group (order by ${leadTimeHistory.leadTimeDays}::numeric), 2)::float`,
        minLeadTimeDays: sql<number>`round(min(${leadTimeHistory.leadTimeDays}::numeric), 2)::float`,
        maxLeadTimeDays: sql<number>`round(max(${leadTimeHistory.leadTimeDays}::numeric), 2)::float`,
        transferCount: sql<number>`count(*)::int`,
      })
      .from(leadTimeHistory)
      .where(and(...conditions));

    res.json({
      data: {
        avgLeadTimeDays: result.avgLeadTimeDays ?? null,
        medianLeadTimeDays: result.medianLeadTimeDays ?? null,
        p90LeadTimeDays: result.p90LeadTimeDays ?? null,
        minLeadTimeDays: result.minLeadTimeDays ?? null,
        maxLeadTimeDays: result.maxLeadTimeDays ?? null,
        transferCount: result.transferCount ?? 0,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

const leadTimeTrendSchema = leadTimeFilterSchema.extend({
  interval: z.enum(['day', 'week', 'month']).default('week'),
});

// GET /lead-times/trend — time-series buckets
transferOrdersRouter.get('/lead-times/trend', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const filters = leadTimeTrendSchema.parse(req.query);
    const conditions = [eq(leadTimeHistory.tenantId, tenantId)];

    if (filters.sourceFacilityId) {
      conditions.push(eq(leadTimeHistory.sourceFacilityId, filters.sourceFacilityId));
    }
    if (filters.destinationFacilityId) {
      conditions.push(eq(leadTimeHistory.destinationFacilityId, filters.destinationFacilityId));
    }
    if (filters.partId) {
      conditions.push(eq(leadTimeHistory.partId, filters.partId));
    }
    if (filters.fromDate) {
      conditions.push(gte(leadTimeHistory.receivedAt, filters.fromDate));
    }
    if (filters.toDate) {
      conditions.push(lte(leadTimeHistory.receivedAt, filters.toDate));
    }

    // Bucket expression — use sql.raw for the interval literal since date_trunc
    // requires a string literal, not a parameterised value
    const bucketExpr =
      filters.interval === 'day'
        ? sql`date_trunc('day', ${leadTimeHistory.receivedAt})`
        : filters.interval === 'month'
          ? sql`date_trunc('month', ${leadTimeHistory.receivedAt})`
          : sql`date_trunc('week', ${leadTimeHistory.receivedAt})`;

    const rows = await db
      .select({
        date: sql<string>`to_char(${bucketExpr}, 'YYYY-MM-DD')`,
        avgLeadTimeDays: sql<number>`round(avg(${leadTimeHistory.leadTimeDays}::numeric), 2)::float`,
        transferCount: sql<number>`count(*)::int`,
      })
      .from(leadTimeHistory)
      .where(and(...conditions))
      .groupBy(bucketExpr)
      .orderBy(bucketExpr);

    // Compute summary from the raw rows
    const totalTransfers = rows.reduce((sum, r) => sum + r.transferCount, 0);
    const overallAvg = totalTransfers > 0
      ? Math.round(
          (rows.reduce((sum, r) => sum + r.avgLeadTimeDays * r.transferCount, 0) / totalTransfers) * 100
        ) / 100
      : 0;

    res.json({
      data: rows,
      summary: {
        overallAvg,
        totalTransfers,
        dateRange: {
          from: rows.length > 0 ? rows[0].date : '',
          to: rows.length > 0 ? rows[rows.length - 1].date : '',
        },
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// GET /:id - Get transfer order detail with lines
transferOrdersRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const [order] = await db
      .select()
      .from(transferOrders)
      .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

    if (!order) {
      throw new AppError(404, 'Transfer order not found');
    }

    const lines = await db
      .select()
      .from(transferOrderLines)
      .where(
        and(
          eq(transferOrderLines.transferOrderId, id),
          eq(transferOrderLines.tenantId, tenantId),
        )
      );

    res.json({ data: { ...order, lines } });
  } catch (error) {
    next(error);
  }
});

// POST / - Create transfer order with lines
transferOrdersRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const payload = createTransferOrderSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId || !userId) {
      throw new AppError(401, 'Unauthorized');
    }

    if (payload.sourceFacilityId === payload.destinationFacilityId) {
      throw new AppError(400, 'Source and destination facilities must be different');
    }

    const toNumber = await getNextTONumber(tenantId);

    const { createdOrder, lines } = await db.transaction(async (tx) => {
      const [createdOrder] = await tx
        .insert(transferOrders)
        .values({
          tenantId,
          toNumber,
          sourceFacilityId: payload.sourceFacilityId,
          destinationFacilityId: payload.destinationFacilityId,
          status: 'draft',
          notes: payload.notes || null,
          createdByUserId: userId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      const lines = await tx
        .insert(transferOrderLines)
        .values(
          payload.lines.map((line) => ({
            tenantId,
            transferOrderId: createdOrder.id,
            partId: line.partId,
            quantityRequested: line.quantityRequested,
            quantityShipped: 0,
            quantityReceived: 0,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }))
        )
        .returning();

      await writeTransferOrderCreateAudit(tx, {
        tenantId,
        transferOrderId: createdOrder.id,
        transferOrderNumber: toNumber,
        initialStatus: createdOrder.status,
        lineCount: lines.length,
        context: auditContext,
      });

      return { createdOrder, lines };
    });

    // Publish order.created event for real-time updates
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.created',
        tenantId,
        orderType: 'transfer_order',
        orderId: createdOrder.id,
        orderNumber: toNumber,
        linkedCardIds: [],
        timestamp: new Date().toISOString(),
      });
    } catch {
      console.error(`[transfer-orders] Failed to publish order.created event for ${toNumber}`);
    }

    res.status(201).json({
      ...createdOrder,
      lines,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// GET /:id/transitions - Get valid next statuses for current user's role
transferOrdersRouter.get('/:id/transitions', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const tenantId = req.user!.tenantId;
    const userRole = req.user!.role as UserRole;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const [order] = await db
      .select()
      .from(transferOrders)
      .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

    if (!order) {
      throw new AppError(404, 'Transfer order not found');
    }

    const validNextStatuses = getValidNextTransferStatuses(
      order.status as TransferStatus,
      userRole
    );

    res.json({ data: { currentStatus: order.status, validTransitions: validNextStatuses } });
  } catch (error) {
    next(error);
  }
});

// PATCH /:id/status - Update transfer order status with lifecycle validation
transferOrdersRouter.patch('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const { status: newStatus, reason } = statusTransitionSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const userRole = req.user!.role as UserRole;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const { updatedOrder, lines } = await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(transferOrders)
        .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)))
        .for('update');

      if (!order) {
        throw new AppError(404, 'Transfer order not found');
      }

      // Validate transition using the lifecycle service (role + reason checks)
      const transition = validateTransferTransition({
        currentStatus: order.status as TransferStatus,
        targetStatus: newStatus as TransferStatus,
        userRole,
        reason,
      });

      if (!transition.valid) {
        throw new AppError(400, transition.error!);
      }

      const updateData: Partial<typeof transferOrders.$inferInsert> = {
        status: newStatus,
        updatedAt: new Date(),
        // Spread auto-populated fields (e.g. requestedDate, shippedDate, receivedDate)
        ...(transition.autoFields as Partial<typeof transferOrders.$inferInsert>),
      };

      // If cancelling, store the reason in notes
      if (newStatus === 'cancelled' && reason) {
        updateData.notes = order.notes
          ? `${order.notes}\n[Cancelled] ${reason}`
          : `[Cancelled] ${reason}`;
      }

      const [updated] = await tx
        .update(transferOrders)
        .set(updateData)
        .where(
          and(
            eq(transferOrders.id, id),
            eq(transferOrders.tenantId, tenantId),
          )
        )
        .returning();

      await writeTransferOrderStatusAudit(tx, {
        tenantId,
        transferOrderId: id,
        transferOrderNumber: order.toNumber,
        fromStatus: order.status,
        toStatus: newStatus,
        context: auditContext,
        metadata: {
          source: 'transfer_orders.status',
          ...(reason && { reason }),
        },
      });

      // Publish order.status_changed event
      try {
        const eventBus = getEventBus(config.REDIS_URL);
        await eventBus.publish({
          type: 'order.status_changed',
          tenantId,
          orderType: 'transfer_order',
          orderId: id,
          orderNumber: order.toNumber,
          fromStatus: order.status,
          toStatus: newStatus,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(`[transfer-orders] Failed to publish order.status_changed event for ${order.toNumber}`);
      }

      const orderLines = await tx
        .select()
        .from(transferOrderLines)
        .where(
          and(
            eq(transferOrderLines.transferOrderId, id),
            eq(transferOrderLines.tenantId, tenantId),
          )
        );

      return { updatedOrder: updated, lines: orderLines };
    });

    res.json({ data: { ...updatedOrder, lines } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// PATCH /:id/ship - Ship lines
transferOrdersRouter.patch('/:id/ship', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const { lines: shipLines } = shipLinesSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const [order] = await db
      .select()
      .from(transferOrders)
      .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

    if (!order) {
      throw new AppError(404, 'Transfer order not found');
    }

    if (order.status !== 'picking') {
      throw new AppError(400, 'Transfer order must be in picking status to ship');
    }

    const { updatedOrder, updatedLines } = await db.transaction(async (tx) => {
      const shippedLineChanges: Array<{
        lineId: string;
        fromQuantityShipped: number;
        toQuantityShipped: number;
      }> = [];

      for (const shipLine of shipLines) {
        const [line] = await tx
          .select()
          .from(transferOrderLines)
          .where(
            and(
              eq(transferOrderLines.id, shipLine.lineId),
              eq(transferOrderLines.transferOrderId, id),
              eq(transferOrderLines.tenantId, tenantId),
            )
          );

        if (!line) {
          throw new AppError(404, `Line ${shipLine.lineId} not found`);
        }

        if (shipLine.quantityShipped > line.quantityRequested) {
          throw new AppError(400, `Shipped quantity cannot exceed requested quantity for line ${shipLine.lineId}`);
        }

        shippedLineChanges.push({
          lineId: shipLine.lineId,
          fromQuantityShipped: line.quantityShipped,
          toQuantityShipped: shipLine.quantityShipped,
        });

        await tx
          .update(transferOrderLines)
          .set({
            quantityShipped: shipLine.quantityShipped,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transferOrderLines.id, shipLine.lineId),
              eq(transferOrderLines.transferOrderId, id),
              eq(transferOrderLines.tenantId, tenantId),
            )
          );
      }

      const updatedLines = await tx
        .select()
        .from(transferOrderLines)
        .where(
          and(
            eq(transferOrderLines.transferOrderId, id),
            eq(transferOrderLines.tenantId, tenantId),
          )
        );

      const fullyShipped = updatedLines.length > 0
        && updatedLines.every((line) => line.quantityShipped >= line.quantityRequested);

      if (fullyShipped && order.status !== 'shipped') {
        await tx
          .update(transferOrders)
          .set({
            status: 'shipped',
            shippedDate: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

        await writeTransferOrderStatusAudit(tx, {
          tenantId,
          transferOrderId: id,
          transferOrderNumber: order.toNumber,
          fromStatus: order.status,
          toStatus: 'shipped',
          context: auditContext,
          metadata: {
            source: 'transfer_orders.ship',
          },
        });
      }

      const [updatedOrder] = await tx
        .select()
        .from(transferOrders)
        .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

      if (shippedLineChanges.length > 0) {
        await writeTransferOrderLinesShippedAudit(tx, {
          tenantId,
          transferOrderId: id,
          transferOrderNumber: order.toNumber,
          status: order.status,
          shippedLineChanges,
          context: auditContext,
        });
      }

      return { updatedOrder, updatedLines };
    });

    if (updatedOrder.status !== order.status) {
      try {
        const eventBus = getEventBus(config.REDIS_URL);
        await eventBus.publish({
          type: 'order.status_changed',
          tenantId,
          orderType: 'transfer_order',
          orderId: id,
          orderNumber: order.toNumber,
          fromStatus: order.status,
          toStatus: updatedOrder.status,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(
          `[transfer-orders] Failed to publish order.status_changed event for ${order.toNumber}`
        );
      }
    }

    res.json({
      ...updatedOrder,
      lines: updatedLines,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// PATCH /:id/receive - Receive lines
transferOrdersRouter.patch('/:id/receive', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const { lines: receiveLines } = receiveLinesSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const [order] = await db
      .select()
      .from(transferOrders)
      .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

    if (!order) {
      throw new AppError(404, 'Transfer order not found');
    }

    if (order.status !== 'in_transit') {
      throw new AppError(400, 'Transfer order must be in in_transit status to receive');
    }

    const { updatedOrder, updatedLines } = await db.transaction(async (tx) => {
      const receivedLineChanges: Array<{
        lineId: string;
        fromQuantityReceived: number;
        toQuantityReceived: number;
      }> = [];

      for (const receiveLine of receiveLines) {
        const [line] = await tx
          .select()
          .from(transferOrderLines)
          .where(
            and(
              eq(transferOrderLines.id, receiveLine.lineId),
              eq(transferOrderLines.transferOrderId, id),
              eq(transferOrderLines.tenantId, tenantId),
            )
          );

        if (!line) {
          throw new AppError(404, `Line ${receiveLine.lineId} not found`);
        }

        if (receiveLine.quantityReceived > line.quantityShipped) {
          throw new AppError(400, `Received quantity cannot exceed shipped quantity for line ${receiveLine.lineId}`);
        }

        receivedLineChanges.push({
          lineId: receiveLine.lineId,
          fromQuantityReceived: line.quantityReceived,
          toQuantityReceived: receiveLine.quantityReceived,
        });

        await tx
          .update(transferOrderLines)
          .set({
            quantityReceived: receiveLine.quantityReceived,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transferOrderLines.id, receiveLine.lineId),
              eq(transferOrderLines.transferOrderId, id),
              eq(transferOrderLines.tenantId, tenantId),
            )
          );
      }

      if (receivedLineChanges.length > 0) {
        await writeTransferOrderLinesReceivedAudit(tx, {
          tenantId,
          transferOrderId: id,
          transferOrderNumber: order.toNumber,
          status: order.status,
          receivedLineChanges,
          context: auditContext,
        });
      }

      const updatedLines = await tx
        .select()
        .from(transferOrderLines)
        .where(
          and(
            eq(transferOrderLines.transferOrderId, id),
            eq(transferOrderLines.tenantId, tenantId),
          )
        );

      const fullyReceived = updatedLines.length > 0
        && updatedLines.every((line) => line.quantityReceived >= line.quantityShipped);

      if (fullyReceived && order.status !== 'received') {
        await tx
          .update(transferOrders)
          .set({
            status: 'received',
            receivedDate: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transferOrders.id, id),
              eq(transferOrders.tenantId, tenantId),
            )
          );

        await writeTransferOrderStatusAudit(tx, {
          tenantId,
          transferOrderId: id,
          transferOrderNumber: order.toNumber,
          fromStatus: order.status,
          toStatus: 'received',
          context: auditContext,
          metadata: {
            source: 'transfer_orders.receive',
            updatedLineIds: receiveLines.map((line) => line.lineId),
          },
        });

        // Persist lead-time history — one row per line
        if (order.shippedDate) {
          const receivedAt = new Date();
          const shippedAt = new Date(order.shippedDate);
          const leadTimeDays = Number(
            ((receivedAt.getTime() - shippedAt.getTime()) / (1000 * 60 * 60 * 24)).toFixed(2)
          );

          await tx.insert(leadTimeHistory).values(
            updatedLines.map((line) => ({
              tenantId,
              sourceFacilityId: order.sourceFacilityId,
              destinationFacilityId: order.destinationFacilityId,
              partId: line.partId,
              transferOrderId: order.id,
              shippedAt,
              receivedAt,
              leadTimeDays: leadTimeDays.toFixed(2),
            }))
          );
        }
      }

      const [updatedOrder] = await tx
        .select()
        .from(transferOrders)
        .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

      return { updatedOrder, updatedLines };
    });

    if (updatedOrder.status !== order.status) {
      try {
        const eventBus = getEventBus(config.REDIS_URL);
        await eventBus.publish({
          type: 'order.status_changed',
          tenantId,
          orderType: 'transfer_order',
          orderId: id,
          orderNumber: order.toNumber,
          fromStatus: order.status,
          toStatus: updatedOrder.status,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(
          `[transfer-orders] Failed to publish order.status_changed event for ${order.toNumber}`
        );
      }
    }

    res.json({
      ...updatedOrder,
      lines: updatedLines,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});
