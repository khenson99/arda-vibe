import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { getEventBus } from '@arda/events';
import { config } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import { getNextWONumber } from '../services/order-number.service.js';

const { workOrders, workOrderRoutings } = schema;

export const workOrdersRouter = Router();

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

async function writeWorkOrderStatusAudit(
  tx: any,
  input: {
    tenantId: string;
    workOrderId: string;
    workOrderNumber: string;
    fromStatus: string;
    toStatus: string;
    context: RequestAuditContext;
    metadata: Record<string, unknown>;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'work_order.status_changed',
    entityType: 'work_order',
    entityId: input.workOrderId,
    previousState: { status: input.fromStatus },
    newState: { status: input.toStatus },
    metadata: {
      ...input.metadata,
      workOrderNumber: input.workOrderNumber,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

async function writeWorkOrderCreateAudit(
  tx: any,
  input: {
    tenantId: string;
    workOrderId: string;
    workOrderNumber: string;
    initialStatus: string;
    quantityToProduce: number;
    routingStepCount: number;
    context: RequestAuditContext;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'work_order.created',
    entityType: 'work_order',
    entityId: input.workOrderId,
    previousState: null,
    newState: {
      status: input.initialStatus,
      quantityToProduce: input.quantityToProduce,
      routingStepCount: input.routingStepCount,
    },
    metadata: {
      source: 'work_orders.create',
      workOrderNumber: input.workOrderNumber,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

async function writeWorkOrderRoutingUpdatedAudit(
  tx: any,
  input: {
    tenantId: string;
    routingId: string;
    workOrderId: string;
    workOrderNumber: string;
    previousRouting: {
      status: string;
      actualMinutes: number | null;
      notes: string | null;
      stepNumber: number;
      operationName: string;
    };
    updatedRouting: {
      status: string;
      actualMinutes: number | null;
      notes: string | null;
      stepNumber: number;
      operationName: string;
    };
    context: RequestAuditContext;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'work_order.routing_updated',
    entityType: 'work_order_routing',
    entityId: input.routingId,
    previousState: {
      status: input.previousRouting.status,
      actualMinutes: input.previousRouting.actualMinutes,
      notes: input.previousRouting.notes,
    },
    newState: {
      status: input.updatedRouting.status,
      actualMinutes: input.updatedRouting.actualMinutes,
      notes: input.updatedRouting.notes,
    },
    metadata: {
      source: 'work_orders.routing_update',
      workOrderId: input.workOrderId,
      workOrderNumber: input.workOrderNumber,
      stepNumber: input.updatedRouting.stepNumber,
      operationName: input.updatedRouting.operationName,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

async function writeWorkOrderProductionReportedAudit(
  tx: any,
  input: {
    tenantId: string;
    workOrderId: string;
    workOrderNumber: string;
    previousQuantityProduced: number;
    previousQuantityRejected: number;
    newQuantityProduced: number;
    newQuantityRejected: number;
    reportedQuantityProduced: number;
    reportedQuantityRejected: number;
    context: RequestAuditContext;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: 'work_order.production_reported',
    entityType: 'work_order',
    entityId: input.workOrderId,
    previousState: {
      quantityProduced: input.previousQuantityProduced,
      quantityRejected: input.previousQuantityRejected,
    },
    newState: {
      quantityProduced: input.newQuantityProduced,
      quantityRejected: input.newQuantityRejected,
    },
    metadata: {
      source: 'work_orders.production',
      workOrderNumber: input.workOrderNumber,
      reportedQuantityProduced: input.reportedQuantityProduced,
      reportedQuantityRejected: input.reportedQuantityRejected,
    },
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

// ─── Validation Schemas ──────────────────────────────────────────────

const routingStepInputSchema = z.object({
  workCenterId: z.string().uuid('Invalid work center ID'),
  stepNumber: z.number().int().positive('Step number must be positive'),
  operationName: z.string().min(1, 'Operation name is required').max(255),
  estimatedMinutes: z.number().int().positive().optional(),
});

const createWorkOrderSchema = z.object({
  partId: z.string().uuid('Invalid part ID'),
  facilityId: z.string().uuid('Invalid facility ID'),
  quantityToProduce: z.number().int().positive('Quantity must be positive'),
  scheduledStartDate: z.string().datetime().optional(),
  scheduledEndDate: z.string().datetime().optional(),
  priority: z.number().int().default(0),
  notes: z.string().optional(),
  kanbanCardId: z.string().uuid().optional(),
  routingSteps: z.array(routingStepInputSchema).min(1, 'At least one routing step is required'),
});

const listWorkOrdersQuerySchema = z.object({
  status: z.enum(['draft', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled']).optional(),
  partId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional(),
  kanbanCardId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const statusTransitionSchema = z.object({
  status: z.enum(['draft', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled']),
});

const updateRoutingStepSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'complete', 'on_hold', 'skipped']).optional(),
  actualMinutes: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});

const reportProductionSchema = z.object({
  quantityProduced: z.number().int().nonnegative('Quantity produced must be non-negative'),
  quantityRejected: z.number().int().nonnegative().default(0),
});

// ─── Helper Functions ────────────────────────────────────────────────

/**
 * Validate status transition rules
 */
function validateStatusTransition(currentStatus: string, newStatus: string): void {
  const validTransitions: Record<string, string[]> = {
    draft: ['scheduled', 'cancelled'],
    scheduled: ['in_progress', 'cancelled'],
    in_progress: ['on_hold', 'completed', 'cancelled'],
    on_hold: ['in_progress', 'cancelled'],
    completed: [],
    cancelled: [],
  };

  if (!validTransitions[currentStatus]?.includes(newStatus)) {
    throw new AppError(400, `Cannot transition from ${currentStatus} to ${newStatus}`);
  }
}

/**
 * Fetch work order with routing steps
 */
async function fetchWorkOrderWithRoutings(workOrderId: string, tenantId: string) {
  const workOrder = await db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
    .limit(1);

  if (!workOrder.length) {
    throw new AppError(404, 'Work order not found');
  }

  const routings = await db
    .select()
    .from(workOrderRoutings)
    .where(
      and(
        eq(workOrderRoutings.workOrderId, workOrderId),
        eq(workOrderRoutings.tenantId, tenantId)
      )
    )
    .orderBy(workOrderRoutings.stepNumber);

  return {
    ...workOrder[0],
    routingSteps: routings,
  };
}

// ─── GET / — List Work Orders with Pagination and Filters ──────────

workOrdersRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;

    const queryInput = listWorkOrdersQuerySchema.parse(req.query);
    const { status, partId, facilityId, kanbanCardId, limit, offset } = queryInput;

    // Build filter conditions
    const conditions = [eq(workOrders.tenantId, tenantId)];

    if (status) {
      conditions.push(eq(workOrders.status, status as (typeof schema.woStatusEnum.enumValues)[number]));
    }
    if (partId) {
      conditions.push(eq(workOrders.partId, partId as string));
    }
    if (facilityId) {
      conditions.push(eq(workOrders.facilityId, facilityId as string));
    }
    if (kanbanCardId) {
      conditions.push(eq(workOrders.kanbanCardId, kanbanCardId as string));
    }

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(workOrders)
      .where(and(...conditions));

    const total = countResult[0]?.count ?? 0;

    // Get paginated results
    const results = await db
      .select()
      .from(workOrders)
      .where(and(...conditions))
      .orderBy(desc(workOrders.createdAt))
      .limit(limit as number)
      .offset(offset as number);

    res.json({
      data: results,
      pagination: {
        offset,
        limit,
        total,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── GET /:id — Work Order Detail with Routing Steps ────────────────

workOrdersRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;

    const workOrder = await fetchWorkOrderWithRoutings(id, tenantId);

    res.json(workOrder);
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ─── POST / — Create Work Order with Routing Steps ──────────────────

workOrdersRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);

    const input = createWorkOrderSchema.parse(req.body);

    // Generate next work order number
    const woNumber = await getNextWONumber(tenantId);

    const { createdWO, createdRoutings } = await db.transaction(async (tx) => {
      const [createdWO] = await tx
        .insert(workOrders)
        .values({
          tenantId,
          woNumber,
          partId: input.partId,
          facilityId: input.facilityId,
          status: 'draft',
          quantityToProduce: input.quantityToProduce,
          quantityProduced: 0,
          quantityRejected: 0,
          scheduledStartDate: input.scheduledStartDate ? new Date(input.scheduledStartDate) : undefined,
          scheduledEndDate: input.scheduledEndDate ? new Date(input.scheduledEndDate) : undefined,
          priority: input.priority,
          notes: input.notes,
          kanbanCardId: input.kanbanCardId,
          createdByUserId: userId,
        })
        .returning();

      const routingStepsToInsert = input.routingSteps.map((step) => ({
        tenantId,
        workOrderId: createdWO.id,
        workCenterId: step.workCenterId,
        stepNumber: step.stepNumber,
        operationName: step.operationName,
        status: 'pending' as const,
        estimatedMinutes: step.estimatedMinutes,
      }));

      const createdRoutings = await tx
        .insert(workOrderRoutings)
        .values(routingStepsToInsert)
        .returning();

      await writeWorkOrderCreateAudit(tx, {
        tenantId,
        workOrderId: createdWO.id,
        workOrderNumber: woNumber,
        initialStatus: createdWO.status,
        quantityToProduce: createdWO.quantityToProduce,
        routingStepCount: createdRoutings.length,
        context: auditContext,
      });

      return { createdWO, createdRoutings };
    });

    // Publish order.created event for real-time updates
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.created',
        tenantId,
        orderType: 'work_order',
        orderId: createdWO.id,
        orderNumber: woNumber,
        linkedCardIds: input.kanbanCardId ? [input.kanbanCardId] : [],
        timestamp: new Date().toISOString(),
      });
    } catch {
      console.error(`[work-orders] Failed to publish order.created event for ${woNumber}`);
    }

    res.status(201).json({
      ...createdWO,
      routingSteps: createdRoutings,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── PATCH /:id/status — Status Transitions ──────────────────────────

workOrdersRouter.patch('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const auditContext = getRequestAuditContext(req);

    const input = statusTransitionSchema.parse(req.body);
    const { status: newStatus } = input;

    // Fetch current work order
    const current = await db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.id, id), eq(workOrders.tenantId, tenantId)))
      .limit(1);

    if (!current.length) {
      throw new AppError(404, 'Work order not found');
    }

    const currentWO = current[0];

    // Validate transition
    validateStatusTransition(currentWO.status, newStatus);

    // Prepare update values
    const updateValues: any = {
      status: newStatus,
      updatedAt: new Date(),
    };

    // Set timestamps based on status transition
    if (newStatus === 'in_progress' && !currentWO.actualStartDate) {
      updateValues.actualStartDate = new Date();
    }

    if (newStatus === 'completed') {
      // Validate production quantities
      if (currentWO.quantityProduced < currentWO.quantityToProduce) {
        throw new AppError(
          400,
          `Cannot complete work order: produced (${currentWO.quantityProduced}) < required (${currentWO.quantityToProduce})`
        );
      }
      updateValues.actualEndDate = new Date();
    }

    // Update work order
    await db
      .update(workOrders)
      .set(updateValues)
      .where(and(eq(workOrders.id, id), eq(workOrders.tenantId, tenantId)))
      .returning();

    await writeWorkOrderStatusAudit(db, {
      tenantId,
      workOrderId: id,
      workOrderNumber: currentWO.woNumber,
      fromStatus: currentWO.status,
      toStatus: newStatus,
      context: auditContext,
      metadata: {
        source: 'work_orders.status',
      },
    });

    // Publish order.status_changed event
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.status_changed',
        tenantId,
        orderType: 'work_order',
        orderId: id,
        orderNumber: currentWO.woNumber,
        fromStatus: currentWO.status,
        toStatus: newStatus,
        timestamp: new Date().toISOString(),
      });
    } catch {
      console.error(`[work-orders] Failed to publish order.status_changed event for ${currentWO.woNumber}`);
    }

    // Fetch complete work order with routings
    const result = await fetchWorkOrderWithRoutings(id, tenantId);

    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ─── PATCH /:id/routings/:routingId — Update Routing Step ───────────

workOrdersRouter.patch('/:id/routings/:routingId', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const routingId = req.params.routingId as string;
    const auditContext = getRequestAuditContext(req);

    const input = updateRoutingStepSchema.parse(req.body);

    // Verify work order belongs to tenant
    const wo = await db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.id, id), eq(workOrders.tenantId, tenantId)))
      .limit(1);

    if (!wo.length) {
      throw new AppError(404, 'Work order not found');
    }

    // Fetch current routing step
    const currentRouting = await db
      .select()
      .from(workOrderRoutings)
      .where(
        and(
          eq(workOrderRoutings.id, routingId),
          eq(workOrderRoutings.workOrderId, id),
          eq(workOrderRoutings.tenantId, tenantId)
        )
      )
      .limit(1);

    if (!currentRouting.length) {
      throw new AppError(404, 'Routing step not found');
    }

    // Prepare update values
    const updateValues: any = {
      updatedAt: new Date(),
    };

    if (input.status !== undefined) {
      updateValues.status = input.status;

      // Set timestamps based on status
      if (input.status === 'in_progress' && !currentRouting[0].startedAt) {
        updateValues.startedAt = new Date();
      }

      if (input.status === 'complete' && !currentRouting[0].completedAt) {
        updateValues.completedAt = new Date();
      }
    }

    if (input.actualMinutes !== undefined) {
      updateValues.actualMinutes = input.actualMinutes;
    }

    if (input.notes !== undefined) {
      updateValues.notes = input.notes;
    }

    // Update routing step
    const [updatedRouting] = await db
      .update(workOrderRoutings)
      .set(updateValues)
      .where(
        and(
          eq(workOrderRoutings.id, routingId),
          eq(workOrderRoutings.workOrderId, id),
          eq(workOrderRoutings.tenantId, tenantId)
        )
      )
      .returning();

    await writeWorkOrderRoutingUpdatedAudit(db, {
      tenantId,
      routingId,
      workOrderId: id,
      workOrderNumber: wo[0].woNumber,
      previousRouting: {
        status: currentRouting[0].status,
        actualMinutes: currentRouting[0].actualMinutes,
        notes: currentRouting[0].notes,
        stepNumber: currentRouting[0].stepNumber,
        operationName: currentRouting[0].operationName,
      },
      updatedRouting: {
        status: updatedRouting.status,
        actualMinutes: updatedRouting.actualMinutes,
        notes: updatedRouting.notes,
        stepNumber: updatedRouting.stepNumber,
        operationName: updatedRouting.operationName,
      },
      context: auditContext,
    });

    res.json(updatedRouting);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ─── PATCH /:id/production — Report Production Quantities ──────────

workOrdersRouter.patch('/:id/production', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const auditContext = getRequestAuditContext(req);

    const input = reportProductionSchema.parse(req.body);
    const { quantityProduced, quantityRejected } = input;

    // Fetch current work order
    const current = await db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.id, id), eq(workOrders.tenantId, tenantId)))
      .limit(1);

    if (!current.length) {
      throw new AppError(404, 'Work order not found');
    }

    const currentWO = current[0];

    // Increment production counters
    const newQuantityProduced = currentWO.quantityProduced + quantityProduced;
    const newQuantityRejected = currentWO.quantityRejected + quantityRejected;

    // Update work order
    await db
      .update(workOrders)
      .set({
        quantityProduced: newQuantityProduced,
        quantityRejected: newQuantityRejected,
        updatedAt: new Date(),
      })
      .where(and(eq(workOrders.id, id), eq(workOrders.tenantId, tenantId)))
      .returning();

    await writeWorkOrderProductionReportedAudit(db, {
      tenantId,
      workOrderId: id,
      workOrderNumber: currentWO.woNumber,
      previousQuantityProduced: currentWO.quantityProduced,
      previousQuantityRejected: currentWO.quantityRejected,
      newQuantityProduced,
      newQuantityRejected,
      reportedQuantityProduced: quantityProduced,
      reportedQuantityRejected: quantityRejected,
      context: auditContext,
    });

    // Fetch complete work order with routings
    const result = await fetchWorkOrderWithRoutings(id, tenantId);

    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
});
