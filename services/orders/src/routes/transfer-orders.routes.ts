import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { getEventBus } from '@arda/events';
import { config } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import { getNextTONumber } from '../services/order-number.service.js';

export const transferOrdersRouter = Router();
const { transferOrders, transferOrderLines } = schema;

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
      conditions.push(eq(transferOrders.status, status as any));
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
        pages: Math.ceil(count / limit),
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

    res.json({
      ...order,
      lines,
    });
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

// PATCH /:id/status - Update transfer order status with transitions
transferOrdersRouter.patch('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const { status: newStatus } = statusTransitionSchema.parse(req.body);
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

    // Validate status transitions
    const validTransitions: Record<string, string[]> = {
      draft: ['requested', 'cancelled'],
      requested: ['approved', 'cancelled'],
      approved: ['picking', 'cancelled'],
      picking: ['shipped', 'cancelled'],
      shipped: ['in_transit', 'cancelled'],
      in_transit: ['received', 'cancelled'],
      received: ['closed', 'cancelled'],
      closed: [],
      cancelled: [],
    };

    if (!validTransitions[order.status]?.includes(newStatus)) {
      throw new AppError(400, `Cannot transition from ${order.status} to ${newStatus}`);
    }

    const updateData: Record<string, any> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    // Set timestamps based on status transition
    if (newStatus === 'requested') {
      updateData.requestedDate = new Date();
    } else if (newStatus === 'shipped') {
      updateData.shippedDate = new Date();
    } else if (newStatus === 'received') {
      updateData.receivedDate = new Date();
    }

    const [updatedOrder] = await db
      .update(transferOrders)
      .set(updateData)
      .where(
        and(
          eq(transferOrders.id, id),
          eq(transferOrders.tenantId, tenantId),
        )
      )
      .returning();

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

    const lines = await db
      .select()
      .from(transferOrderLines)
      .where(
        and(
          eq(transferOrderLines.transferOrderId, id),
          eq(transferOrderLines.tenantId, tenantId),
        )
      );

    res.json({
      ...updatedOrder,
      lines,
    });
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

      const [updatedOrder] = await tx
        .select()
        .from(transferOrders)
        .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

      return { updatedOrder, updatedLines };
    });

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

      const updatedLines = await tx
        .select()
        .from(transferOrderLines)
        .where(
          and(
            eq(transferOrderLines.transferOrderId, id),
            eq(transferOrderLines.tenantId, tenantId),
          )
        );

      const [updatedOrder] = await tx
        .select()
        .from(transferOrders)
        .where(and(eq(transferOrders.id, id), eq(transferOrders.tenantId, tenantId)));

      return { updatedOrder, updatedLines };
    });

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
