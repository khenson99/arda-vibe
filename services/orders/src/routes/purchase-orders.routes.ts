import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, desc, asc, inArray } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest, AuditContext } from '@arda/auth-utils';
import { getEventBus, publishKpiRefreshed } from '@arda/events';
import { config } from '@arda/config';
import { getCorrelationId } from '@arda/observability';
import { AppError } from '../middleware/error-handler.js';
import { getNextPONumber } from '../services/order-number.service.js';
import {
  SmtpEmailAdapter,
  SimplePdfGenerator,
  type EmailAttachment,
  type EmailMessage,
  type PurchaseOrderPdfData,
} from '../services/po-dispatch.service.js';

export const purchaseOrdersRouter = Router();

function getRequestAuditContext(req: AuthRequest): AuditContext {
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

// Validation schemas
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

const SendEmailDraftSchema = z.object({
  to: z.string().email().optional(),
  cc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(255).optional(),
  bodyText: z.string().min(1).max(10000).optional(),
  bodyHtml: z.string().max(15000).optional(),
  includeAttachment: z.boolean().default(true),
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

function formatAddress(input: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}) {
  const lineOne = input.addressLine1?.trim();
  const lineTwo = input.addressLine2?.trim();
  const locality = [input.city?.trim(), input.state?.trim(), input.postalCode?.trim()]
    .filter(Boolean)
    .join(', ');
  const country = input.country?.trim();

  return [lineOne, lineTwo, locality, country].filter(Boolean).join(', ') || 'N/A';
}

function defaultEmailBodyText(input: {
  supplierName: string;
  poNumber: string;
  includeAttachment: boolean;
}) {
  return [
    `Hello ${input.supplierName},`,
    '',
    input.includeAttachment
      ? `Please find attached Purchase Order ${input.poNumber}.`
      : `Purchase Order ${input.poNumber} details are included below.`,
    '',
    'Please confirm receipt and expected delivery timing.',
    '',
    'Thank you,',
    'Arda Procurement',
  ].join('\n');
}

function defaultEmailBodyHtml(bodyText: string) {
  return bodyText
    .split('\n')
    .map((line) => `<p>${line || '&nbsp;'}</p>`)
    .join('');
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
    const auditContext = getRequestAuditContext(req);

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

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: createdPO.id,
        previousState: null,
        newState: {
          status: createdPO.status,
          lineCount: insertedLines.length,
          totalAmount,
        },
        metadata: {
          source: 'purchase_orders.create',
          orderNumber: poNumber,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

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

    // Publish kpi.refreshed for affected metrics
    void publishKpiRefreshed({
      tenantId,
      mutationType: 'purchase_order.created',
      facilityId: createdPO.facilityId,
      source: 'orders',
      correlationId: getCorrelationId(),
    });

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
    const auditContext = getRequestAuditContext(req);

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

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'purchase_order.line_added',
        entityType: 'purchase_order',
        entityId: id,
        previousState: {
          totalAmount: String(po.totalAmount ?? '0.00'),
        },
        newState: {
          totalAmount,
          lineId: newLine.id,
          lineNumber: newLine.lineNumber,
          partId: newLine.partId,
          quantityOrdered: newLine.quantityOrdered,
        },
        metadata: {
          source: 'purchase_orders.add_line',
          orderNumber: po.poNumber,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

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

// POST /:id/send-email-draft - Send editable draft email for a purchase order
purchaseOrdersRouter.post('/:id/send-email-draft', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const tenantId = req.user!.tenantId;
    const payload = SendEmailDraftSchema.parse(req.body);

    const [purchaseOrder] = await db
      .select()
      .from(schema.purchaseOrders)
      .where(and(eq(schema.purchaseOrders.id, id), eq(schema.purchaseOrders.tenantId, tenantId)))
      .limit(1)
      .execute();

    if (!purchaseOrder) {
      throw new AppError(404, 'Purchase order not found');
    }

    const [supplier] = await db
      .select()
      .from(schema.suppliers)
      .where(
        and(
          eq(schema.suppliers.id, purchaseOrder.supplierId),
          eq(schema.suppliers.tenantId, tenantId)
        )
      )
      .limit(1)
      .execute();

    if (!supplier) {
      throw new AppError(404, 'Supplier not found for purchase order');
    }

    const lines = await db
      .select()
      .from(schema.purchaseOrderLines)
      .where(
        and(
          eq(schema.purchaseOrderLines.purchaseOrderId, id),
          eq(schema.purchaseOrderLines.tenantId, tenantId)
        )
      )
      .orderBy(asc(schema.purchaseOrderLines.lineNumber))
      .execute();

    const partIds = Array.from(new Set(lines.map((line) => line.partId)));
    const parts =
      partIds.length > 0
        ? await db
            .select()
            .from(schema.parts)
            .where(and(eq(schema.parts.tenantId, tenantId), inArray(schema.parts.id, partIds)))
            .execute()
        : [];
    const partsById = new Map(parts.map((part) => [part.id, part]));

    const [facility] = await db
      .select()
      .from(schema.facilities)
      .where(
        and(
          eq(schema.facilities.id, purchaseOrder.facilityId),
          eq(schema.facilities.tenantId, tenantId)
        )
      )
      .limit(1)
      .execute();

    const to = payload.to?.trim() || supplier.contactEmail?.trim() || undefined;
    if (!to) {
      throw new AppError(400, 'Recipient email is required');
    }

    const includeAttachment = payload.includeAttachment ?? true;
    const subject = payload.subject?.trim() || `Purchase Order ${purchaseOrder.poNumber}`;
    const bodyText =
      payload.bodyText?.trim() ||
      defaultEmailBodyText({
        supplierName: supplier.name,
        poNumber: purchaseOrder.poNumber,
        includeAttachment,
      });
    const bodyHtml = payload.bodyHtml?.trim() || defaultEmailBodyHtml(bodyText);

    const attachments: EmailAttachment[] = [];
    if (includeAttachment) {
      const pdfData: PurchaseOrderPdfData = {
        poNumber: purchaseOrder.poNumber,
        orderDate: (purchaseOrder.orderDate ?? purchaseOrder.createdAt).toISOString().slice(0, 10),
        expectedDeliveryDate:
          purchaseOrder.expectedDeliveryDate?.toISOString().slice(0, 10) || 'TBD',
        supplierName: supplier.name,
        supplierContact: supplier.contactName || 'Procurement',
        supplierEmail: to,
        supplierAddress: formatAddress(supplier),
        buyerCompanyName: 'Arda',
        buyerAddress:
          facility?.name && facility?.code
            ? `${facility.name} (${facility.code})`
            : facility?.name || purchaseOrder.facilityId,
        facilityName: facility?.name || purchaseOrder.facilityId,
        lines: lines.map((line) => {
          const part = partsById.get(line.partId);
          return {
            lineNumber: line.lineNumber,
            partNumber: part?.partNumber || line.partId,
            partName: line.description || part?.name || line.partId,
            quantity: line.quantityOrdered,
            unitCost: String(line.unitCost ?? '0'),
            lineTotal: String(line.lineTotal ?? '0'),
            uom: part?.uom || 'each',
          };
        }),
        subtotal: String(purchaseOrder.subtotal ?? '0'),
        taxAmount: String(purchaseOrder.taxAmount ?? '0'),
        shippingAmount: String(purchaseOrder.shippingAmount ?? '0'),
        totalAmount: String(purchaseOrder.totalAmount ?? '0'),
        currency: purchaseOrder.currency || 'USD',
        notes: purchaseOrder.notes ?? undefined,
        terms: purchaseOrder.paymentTerms ?? undefined,
      };

      const pdfGenerator = new SimplePdfGenerator();
      const pdfBuffer = await pdfGenerator.generatePurchaseOrderPdf(pdfData);
      attachments.push({
        filename: `${purchaseOrder.poNumber}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      });
    }

    const emailAdapter = new SmtpEmailAdapter({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
      from: config.EMAIL_FROM,
    });

    const message: EmailMessage = {
      to,
      cc: payload.cc,
      subject,
      bodyText,
      bodyHtml,
      attachments,
    };

    const result = await emailAdapter.send(message);

    res.json({
      success: true,
      data: {
        messageId: result.messageId,
        to,
        cc: payload.cc ?? [],
        subject,
        attachmentIncluded: includeAttachment,
        poId: purchaseOrder.id,
        poNumber: purchaseOrder.poNumber,
      },
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
    const auditContext = getRequestAuditContext(req);

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
    }

    // Build update object based on new status
    const updateData: Record<string, any> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    if (newStatus === 'cancelled') {
      updateData.cancelledAt = new Date();
      updateData.cancelReason = cancelReason;
    }
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

    // Wrap mutation + audit in same transaction
    const updated = await db.transaction(async (tx) => {
      await tx
        .update(schema.purchaseOrders)
        .set(updateData)
        .where(
          and(
            eq(schema.purchaseOrders.id, id),
            eq(schema.purchaseOrders.tenantId, req.user!.tenantId),
          ),
        );

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'purchase_order.status_changed',
        entityType: 'purchase_order',
        entityId: id,
        previousState: { status: po.status },
        newState: { status: newStatus },
        metadata: {
          source: 'purchase_orders.status',
          orderNumber: po.poNumber,
          ...(cancelReason ? { cancelReason } : {}),
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      const [result] = await tx
        .select()
        .from(schema.purchaseOrders)
        .where(
          and(
            eq(schema.purchaseOrders.id, id),
            eq(schema.purchaseOrders.tenantId, req.user!.tenantId),
          ),
        )
        .limit(1);

      return result;
    });

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

    // Publish kpi.refreshed for affected metrics
    void publishKpiRefreshed({
      tenantId: req.user!.tenantId,
      mutationType: 'purchase_order.status_changed',
      facilityId: po.facilityId,
      source: 'orders',
      correlationId: getCorrelationId(),
    });

    res.json({
      data: updated,
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
    const auditContext = getRequestAuditContext(req);

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
      const receivedLineChanges: Array<{
        lineId: string;
        fromQuantityReceived: number;
        toQuantityReceived: number;
      }> = [];

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

        receivedLineChanges.push({
          lineId: receiveLine.lineId,
          fromQuantityReceived: existingLine[0].quantityReceived,
          toQuantityReceived: receiveLine.quantityReceived,
        });

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

      if (receivedLineChanges.length > 0) {
        await writeAuditEntry(tx, {
          tenantId,
          userId: auditContext.userId,
          action: 'purchase_order.lines_received',
          entityType: 'purchase_order',
          entityId: id,
          previousState: {
            status: po.status,
            lineChanges: receivedLineChanges.map((line) => ({
              lineId: line.lineId,
              quantityReceived: line.fromQuantityReceived,
            })),
          },
          newState: {
            status: po.status,
            lineChanges: receivedLineChanges.map((line) => ({
              lineId: line.lineId,
              quantityReceived: line.toQuantityReceived,
            })),
          },
          metadata: {
            source: 'purchase_orders.receive',
            orderNumber: po.poNumber,
          },
          ipAddress: auditContext.ipAddress,
          userAgent: auditContext.userAgent,
        });
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

        await writeAuditEntry(tx, {
          tenantId,
          userId: auditContext.userId,
          action: 'purchase_order.status_changed',
          entityType: 'purchase_order',
          entityId: id,
          previousState: { status: po.status },
          newState: { status: newStatus },
          metadata: {
            source: 'purchase_orders.receive',
            orderNumber: po.poNumber,
            updatedLineIds: receiveLines.map((line) => line.lineId),
          },
          ipAddress: auditContext.ipAddress,
          userAgent: auditContext.userAgent,
        });
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

    if (updated.status !== po.status) {
      try {
        const eventBus = getEventBus(config.REDIS_URL);
        await eventBus.publish({
          type: 'order.status_changed',
          tenantId,
          orderType: 'purchase_order',
          orderId: id,
          orderNumber: po.poNumber,
          fromStatus: po.status,
          toStatus: updated.status,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(
          `[purchase-orders] Failed to publish order.status_changed event for ${po.poNumber}`
        );
      }
    }

    // Receiving always affects KPI metrics (fill_rate, supplier_otd, order_accuracy)
    void publishKpiRefreshed({
      tenantId,
      mutationType: 'receiving.completed',
      facilityId: po.facilityId,
      source: 'orders',
      correlationId: getCorrelationId(),
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
