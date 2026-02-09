import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, desc, asc } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { getEventBus } from '@arda/events';
import { config } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import { getNextPONumber } from '../services/order-number.service.js';

export const purchaseOrdersRouter = Router();

// Validation schemas
const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const POFilterSchema = z.object({
  status: z.enum([
    'draft',
    'pending_approval',
    'approved',
    'sent',
    'acknowledged',
    'partially_received',
    'received',
    'closed',
    'cancelled',
  ]).optional(),
  supplierId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const POLineSchema = z.object({
  partId: z.string().uuid(),
  kanbanCardId: z.string().uuid().optional().nullable(),
  lineNumber: z.number().int().positive(),
  quantityOrdered: z.number().int().positive(),
  unitCost: z.number().positive(),
  notes: z.string().optional().nullable(),
});

const CreatePOSchema = z.object({
  supplierId: z.string().uuid(),
  facilityId: z.string().uuid(),
  orderDate: z.string().datetime().optional(),
  expectedDeliveryDate: z.string().datetime(),
  currency: z.string().length(3).toUpperCase().default('USD'),
  notes: z.string().optional().nullable(),
  internalNotes: z.string().optional().nullable(),
  lines: z.array(POLineSchema).min(1),
});

const AddPOLineSchema = z.object({
  partId: z.string().uuid(),
  kanbanCardId: z.string().uuid().optional().nullable(),
  lineNumber: z.number().int().positive(),
  quantityOrdered: z.number().int().positive(),
  unitCost: z.number().positive(),
  notes: z.string().optional().nullable(),
});

const StatusTransitionSchema = z.object({
  status: z.enum([
    'draft',
    'pending_approval',
    'approved',
    'sent',
    'acknowledged',
    'partially_received',
    'received',
    'closed',
    'cancelled',
  ]),
  cancelReason: z.string().optional(),
});

const ReceiveLineSchema = z.object({
  lineId: z.string().uuid(),
  quantityReceived: z.number().int().nonnegative(),
});

const ReceiveLinesSchema = z.object({
  lines: z.array(ReceiveLineSchema).min(1),
});

// Type definitions
interface POLineInput {
  partId: string;
  kanbanCardId?: string | null;
  lineNumber: number;
  quantityOrdered: number;
  unitCost: number;
  notes?: string | null;
}

// Helper: Calculate line total
function calculateLineTotal(quantityOrdered: number, unitCost: number): string {
  return (quantityOrdered * unitCost).toFixed(2);
}

// Helper: Calculate PO totals
function calculatePOTotals(lines: POLineInput[]) {
  const subtotal = lines.reduce((sum, line) => sum + (line.quantityOrdered * line.unitCost), 0);
  return {
    subtotal: subtotal.toFixed(2),
    taxAmount: '0.00', // Default, can be customized based on business logic
    shippingAmount: '0.00', // Default, can be customized based on business logic
    totalAmount: subtotal.toFixed(2),
  };
}

// Helper: Validate status transition
function isValidStatusTransition(currentStatus: string, newStatus: string): boolean {
  const validTransitions: Record<string, string[]> = {
    draft: ['pending_approval', 'cancelled'],
    pending_approval: ['approved', 'cancelled', 'draft'],
    approved: ['sent', 'cancelled'],
    sent: ['acknowledged', 'partially_received', 'cancelled'],
    acknowledged: ['partially_received', 'cancelled'],
    partially_received: ['received', 'cancelled'],
    received: ['closed', 'cancelled'],
    closed: [],
    cancelled: [],
  };

  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
}

// GET / - List purchase orders with pagination and filters
purchaseOrdersRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { page, limit, status, supplierId, facilityId } = POFilterSchema.parse(req.query);
    const offset = (page - 1) * limit;

    const conditions = [eq(schema.purchaseOrders.tenantId, req.user!.tenantId)];

    if (status) {
      conditions.push(eq(schema.purchaseOrders.status, status));
    }
    if (supplierId) {
      conditions.push(eq(schema.purchaseOrders.supplierId, supplierId));
    }
    if (facilityId) {
      conditions.push(eq(schema.purchaseOrders.facilityId, facilityId));
    }

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.purchaseOrders)
      .where(and(...conditions));

    const total = countResult[0]?.count ?? 0;

    // Get paginated results
    const purchaseOrders = await db
      .select()
      .from(schema.purchaseOrders)
      .where(and(...conditions))
      .orderBy(desc(schema.purchaseOrders.createdAt))
      .limit(limit as number)
      .offset(offset as number);

    res.json({
      data: purchaseOrders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// GET /:id - Get purchase order detail with lines
purchaseOrdersRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;

    const purchaseOrder = await db
      .select()
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.id, id),
          eq(schema.purchaseOrders.tenantId, req.user!.tenantId),
        ),
      )
      .limit(1);

    if (!purchaseOrder.length) {
      throw new AppError(404, 'Purchase order not found');
    }

    const lines = await db
      .select()
      .from(schema.purchaseOrderLines)
      .where(
        and(
          eq(schema.purchaseOrderLines.purchaseOrderId, id),
          eq(schema.purchaseOrderLines.tenantId, req.user!.tenantId),
        ),
      )
      .orderBy(asc(schema.purchaseOrderLines.lineNumber));

    res.json({
      data: {
        ...purchaseOrder[0],
        lines,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST / - Create purchase order with lines
purchaseOrdersRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const payload = CreatePOSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;

    // Generate PO number
    const poNumber = await getNextPONumber(tenantId);

    // Calculate totals
    const { subtotal, taxAmount, shippingAmount, totalAmount } = calculatePOTotals(payload.lines);

    const { createdPO, insertedLines } = await db.transaction(async (tx) => {
      const [createdPO] = await tx
        .insert(schema.purchaseOrders)
        .values({
          tenantId,
          poNumber,
          supplierId: payload.supplierId,
          facilityId: payload.facilityId,
          status: 'draft',
          orderDate: payload.orderDate ? new Date(payload.orderDate) : new Date(),
          expectedDeliveryDate: new Date(payload.expectedDeliveryDate),
          subtotal,
          taxAmount,
          shippingAmount,
          totalAmount,
          currency: payload.currency,
          notes: payload.notes || null,
          internalNotes: payload.internalNotes || null,
          createdByUserId: userId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      const insertedLines = await tx
        .insert(schema.purchaseOrderLines)
        .values(
          payload.lines.map((line) => ({
            tenantId,
            purchaseOrderId: createdPO.id,
            partId: line.partId,
            kanbanCardId: line.kanbanCardId || null,
            lineNumber: line.lineNumber,
            quantityOrdered: line.quantityOrdered,
            quantityReceived: 0,
            unitCost: String(line.unitCost),
            lineTotal: calculateLineTotal(line.quantityOrdered, line.unitCost),
            notes: line.notes || null,
          })),
        )
        .returning();

      return { createdPO, insertedLines };
    });

    // Publish order.created event
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.created',
        tenantId,
        orderType: 'purchase_order',
        orderId: createdPO.id,
        orderNumber: poNumber,
        linkedCardIds: insertedLines.filter((l) => l.kanbanCardId).map((l) => l.kanbanCardId!),
        timestamp: new Date().toISOString(),
      });
    } catch {
      console.error(`[purchase-orders] Failed to publish order.created event for ${poNumber}`);
    }

    res.status(201).json({
      data: {
        ...createdPO,
        lines: insertedLines,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// POST /:id/lines - Add line items to existing purchase order
purchaseOrdersRouter.post('/:id/lines', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const payload = AddPOLineSchema.parse(req.body);
    const tenantId = req.user!.tenantId;

    const newLine = await db.transaction(async (tx) => {
      // Verify PO exists and belongs to tenant
      const purchaseOrder = await tx
        .select()
        .from(schema.purchaseOrders)
        .where(
          and(
            eq(schema.purchaseOrders.id, id),
            eq(schema.purchaseOrders.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!purchaseOrder.length) {
        throw new AppError(404, 'Purchase order not found');
      }

      const po = purchaseOrder[0];

      // Verify PO is in draft or pending_approval status
      if (!['draft', 'pending_approval'].includes(po.status)) {
        throw new AppError(409, `Cannot add lines to purchase order in ${po.status} status`);
      }

      const [newLine] = await tx
        .insert(schema.purchaseOrderLines)
        .values({
          tenantId,
          purchaseOrderId: id,
          partId: payload.partId,
          kanbanCardId: payload.kanbanCardId || null,
          lineNumber: payload.lineNumber,
          quantityOrdered: payload.quantityOrdered,
          quantityReceived: 0,
          unitCost: String(payload.unitCost),
          lineTotal: calculateLineTotal(payload.quantityOrdered, payload.unitCost),
          notes: payload.notes || null,
        })
        .returning();

      const allLines = await tx
        .select()
        .from(schema.purchaseOrderLines)
        .where(
          and(
            eq(schema.purchaseOrderLines.purchaseOrderId, id),
            eq(schema.purchaseOrderLines.tenantId, tenantId),
          )
        );

      const { subtotal, taxAmount, shippingAmount, totalAmount } = calculatePOTotals(
        allLines.map((l) => ({
          partId: l.partId,
          kanbanCardId: l.kanbanCardId,
          lineNumber: l.lineNumber,
          quantityOrdered: l.quantityOrdered,
          unitCost: Number(l.unitCost),
          notes: l.notes,
        })),
      );

      await tx
        .update(schema.purchaseOrders)
        .set({
          subtotal,
          taxAmount,
          shippingAmount,
          totalAmount,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.purchaseOrders.id, id),
            eq(schema.purchaseOrders.tenantId, tenantId),
          )
        );

      return newLine;
    });

    res.status(201).json({
      data: newLine,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// PATCH /:id/status - Status transitions with validation
purchaseOrdersRouter.patch('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const { status: newStatus, cancelReason } = StatusTransitionSchema.parse(req.body);

    // Verify PO exists and belongs to tenant
    const purchaseOrder = await db
      .select()
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.id, id),
          eq(schema.purchaseOrders.tenantId, req.user!.tenantId),
        ),
      )
      .limit(1);

    if (!purchaseOrder.length) {
      throw new AppError(404, 'Purchase order not found');
    }

    const po = purchaseOrder[0];

    // Validate transition
    if (!isValidStatusTransition(po.status, newStatus)) {
      throw new AppError(409, `Cannot transition from ${po.status} to ${newStatus}`);
    }

    // Handle cancellation
    if (newStatus === 'cancelled') {
      if (!cancelReason) {
        throw new AppError(400, 'cancelReason is required when cancelling');
      }
      await db
        .update(schema.purchaseOrders)
        .set({
          status: newStatus,
          cancelledAt: new Date(),
          cancelReason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.purchaseOrders.id, id),
            eq(schema.purchaseOrders.tenantId, req.user!.tenantId),
          ),
        );

      const updated = await db
        .select()
        .from(schema.purchaseOrders)
        .where(
          and(
            eq(schema.purchaseOrders.id, id),
            eq(schema.purchaseOrders.tenantId, req.user!.tenantId),
          ),
        )
        .limit(1);

      return res.json({
        data: updated[0],
      });
    }

    // Build update object based on new status
    const updateData: Record<string, any> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    if (newStatus === 'approved') {
      updateData.approvedByUserId = req.user!.sub;
      updateData.approvedAt = new Date();
    }

    if (newStatus === 'sent') {
      updateData.sentAt = new Date();
    }

    if (newStatus === 'received') {
      updateData.actualDeliveryDate = new Date();
    }

    await db
      .update(schema.purchaseOrders)
      .set(updateData)
      .where(
        and(
          eq(schema.purchaseOrders.id, id),
          eq(schema.purchaseOrders.tenantId, req.user!.tenantId),
        ),
      );

    const updated = await db
      .select()
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.id, id),
          eq(schema.purchaseOrders.tenantId, req.user!.tenantId),
        ),
      )
      .limit(1);

    // Publish order.status_changed event
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.status_changed',
        tenantId: req.user!.tenantId,
        orderType: 'purchase_order',
        orderId: id,
        orderNumber: po.poNumber,
        fromStatus: po.status,
        toStatus: newStatus,
        timestamp: new Date().toISOString(),
      });
    } catch {
      console.error(`[purchase-orders] Failed to publish order.status_changed event for ${po.poNumber}`);
    }

    res.json({
      data: updated[0],
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// PATCH /:id/receive - Receive line items and auto-transition if fully received
purchaseOrdersRouter.patch('/:id/receive', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const { lines: receiveLines } = ReceiveLinesSchema.parse(req.body);
    const tenantId = req.user!.tenantId;

    // Verify PO exists and belongs to tenant
    const purchaseOrder = await db
      .select()
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.id, id),
          eq(schema.purchaseOrders.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!purchaseOrder.length) {
      throw new AppError(404, 'Purchase order not found');
    }

    const po = purchaseOrder[0];

    // Verify PO is in a receivable status
    if (!['sent', 'acknowledged', 'partially_received'].includes(po.status)) {
      throw new AppError(409, `Cannot receive items on purchase order in ${po.status} status`);
    }

    const { updated, updatedLines } = await db.transaction(async (tx) => {
      for (const receiveLine of receiveLines) {
        const existingLine = await tx
          .select()
          .from(schema.purchaseOrderLines)
          .where(
            and(
              eq(schema.purchaseOrderLines.id, receiveLine.lineId),
              eq(schema.purchaseOrderLines.purchaseOrderId, id),
              eq(schema.purchaseOrderLines.tenantId, tenantId),
            ),
          )
          .limit(1);

        if (!existingLine.length) {
          throw new AppError(404, `Line item ${receiveLine.lineId} not found`);
        }

        await tx
          .update(schema.purchaseOrderLines)
          .set({
            quantityReceived: receiveLine.quantityReceived,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.purchaseOrderLines.id, receiveLine.lineId),
              eq(schema.purchaseOrderLines.purchaseOrderId, id),
              eq(schema.purchaseOrderLines.tenantId, tenantId),
            ),
          );
      }

      const allLines = await tx
        .select()
        .from(schema.purchaseOrderLines)
        .where(
          and(
            eq(schema.purchaseOrderLines.purchaseOrderId, id),
            eq(schema.purchaseOrderLines.tenantId, tenantId),
          ),
        );

      const fullyReceived = allLines.every((line) => line.quantityReceived >= line.quantityOrdered);

      let newStatus = po.status;
      if (po.status !== 'partially_received' && !fullyReceived) {
        newStatus = 'partially_received';
      } else if (fullyReceived && po.status !== 'received') {
        newStatus = 'received';
      }

      if (newStatus !== po.status) {
        const updateData: Record<string, any> = {
          status: newStatus,
          updatedAt: new Date(),
        };

        if (newStatus === 'received') {
          updateData.actualDeliveryDate = new Date();
        }

        await tx
          .update(schema.purchaseOrders)
          .set(updateData)
          .where(
            and(
              eq(schema.purchaseOrders.id, id),
              eq(schema.purchaseOrders.tenantId, tenantId),
            ),
          );
      }

      const [updated] = await tx
        .select()
        .from(schema.purchaseOrders)
        .where(
          and(
            eq(schema.purchaseOrders.id, id),
            eq(schema.purchaseOrders.tenantId, tenantId),
          ),
        )
        .limit(1);

      const updatedLines = await tx
        .select()
        .from(schema.purchaseOrderLines)
        .where(
          and(
            eq(schema.purchaseOrderLines.purchaseOrderId, id),
            eq(schema.purchaseOrderLines.tenantId, tenantId),
          ),
        )
        .orderBy(asc(schema.purchaseOrderLines.lineNumber));

      return { updated, updatedLines };
    });

    res.json({
      data: {
        ...updated,
        lines: updatedLines,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});
