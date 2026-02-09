import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { getEventBus } from '@arda/events';
import { config } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import { getNextWONumber } from '../services/order-number.service.js';

const { workOrders, workOrderRoutings } = schema;

export const workOrdersRouter = Router();

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
      conditions.push(eq(workOrders.status, status as any));
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
    const [updatedWO] = await db
      .update(workOrders)
      .set(updateValues)
      .where(and(eq(workOrders.id, id), eq(workOrders.tenantId, tenantId)))
      .returning();

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
    const [updatedWO] = await db
      .update(workOrders)
      .set({
        quantityProduced: newQuantityProduced,
        quantityRejected: newQuantityRejected,
        updatedAt: new Date(),
      })
      .where(and(eq(workOrders.id, id), eq(workOrders.tenantId, tenantId)))
      .returning();

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
