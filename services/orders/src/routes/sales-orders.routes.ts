import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, gte, lte, desc } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import { requireRole, type AuthRequest, type AuditContext } from '@arda/auth-utils';
import { type SOStatus, SO_VALID_TRANSITIONS } from '@arda/shared-types';

import { AppError } from '../middleware/error-handler.js';
import { getNextSONumber } from '../services/order-number.service.js';

const { salesOrders, salesOrderLines, customers } = schema;

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

// ─── Validation Schemas ─────────────────────────────────────────────

const soStatusValues = [
  'draft', 'confirmed', 'processing', 'partially_shipped',
  'shipped', 'delivered', 'invoiced', 'closed', 'cancelled',
] as const;

const createLineSchema = z.object({
  partId: z.string().uuid(),
  quantityOrdered: z.number().int().positive(),
  unitPrice: z.number().positive(),
  discountPercent: z.number().min(0).max(100).default(0),
  notes: z.string().optional(),
});

const createSalesOrderSchema = z.object({
  customerId: z.string().uuid(),
  facilityId: z.string().uuid(),
  orderDate: z.string().datetime().optional(),
  requestedShipDate: z.string().datetime().optional(),
  shippingAddressId: z.string().uuid().optional(),
  billingAddressId: z.string().uuid().optional(),
  paymentTerms: z.string().max(255).optional(),
  shippingMethod: z.string().max(100).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
  lines: z.array(createLineSchema).min(1),
});

const updateSalesOrderSchema = z.object({
  requestedShipDate: z.string().datetime().optional(),
  promisedShipDate: z.string().datetime().optional(),
  shippingAddressId: z.string().uuid().optional(),
  billingAddressId: z.string().uuid().optional(),
  paymentTerms: z.string().max(255).optional(),
  shippingMethod: z.string().max(100).optional(),
  trackingNumber: z.string().max(255).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
});

const addLineSchema = createLineSchema;

const updateLineSchema = z.object({
  quantityOrdered: z.number().int().positive().optional(),
  unitPrice: z.number().positive().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  notes: z.string().optional(),
});

const listSalesOrdersSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
  status: z.enum(soStatusValues).optional(),
  customerId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

const transitionStatusSchema = z.object({
  cancelReason: z.string().optional(),
});

// ─── RBAC Definitions ───────────────────────────────────────────────
// Writers: salesperson (+ tenant_admin via middleware)
// Readers: salesperson, ecommerce_director (+ tenant_admin via middleware)
const canRead = requireRole('salesperson', 'ecommerce_director');
const canWrite = requireRole('salesperson');

export const salesOrdersRouter = Router();

// ─── Helpers ────────────────────────────────────────────────────────

function tenantScope(req: AuthRequest) {
  const tenantId = req.user!.tenantId;
  const conditions = [eq(salesOrders.tenantId, tenantId)];
  if (req.user!.role === 'salesperson') {
    conditions.push(eq(salesOrders.createdByUserId, req.user!.sub));
  }
  return conditions;
}

async function findOrderOrThrow(orderId: string, req: AuthRequest) {
  const conditions = [
    eq(salesOrders.id, orderId),
    ...tenantScope(req),
  ];
  const order = await db.query.salesOrders.findFirst({
    where: and(...conditions),
  });
  if (!order) {
    throw new AppError(404, 'Sales order not found');
  }
  return order;
}

function computeLineTotal(qty: number, unitPrice: number, discountPercent: number): string {
  const gross = qty * unitPrice;
  const net = gross * (1 - discountPercent / 100);
  return net.toFixed(2);
}

function computeOrderTotals(lines: Array<{ lineTotal: string }>) {
  const subtotal = lines.reduce((sum, l) => sum + parseFloat(l.lineTotal), 0);
  return { subtotal: subtotal.toFixed(2), totalAmount: subtotal.toFixed(2) };
}

// ═════════════════════════════════════════════════════════════════════
//  Sales Order CRUD
// ═════════════════════════════════════════════════════════════════════

// ─── GET /sales-orders ──────────────────────────────────────────────
salesOrdersRouter.get('/', canRead, async (req: AuthRequest, res, next) => {
  try {
    const query = listSalesOrdersSchema.parse(req.query);
    const offset = (query.page - 1) * query.pageSize;

    const conditions = tenantScope(req);

    if (query.status) {
      conditions.push(eq(salesOrders.status, query.status));
    }
    if (query.customerId) {
      conditions.push(eq(salesOrders.customerId, query.customerId));
    }
    if (query.dateFrom) {
      conditions.push(gte(salesOrders.orderDate, new Date(query.dateFrom)));
    }
    if (query.dateTo) {
      conditions.push(lte(salesOrders.orderDate, new Date(query.dateTo)));
    }

    const whereClause = and(...conditions);

    const [data, countResult] = await Promise.all([
      db.select()
        .from(salesOrders)
        .where(whereClause)
        .limit(query.pageSize)
        .offset(offset)
        .orderBy(desc(salesOrders.createdAt)),
      db.select({ count: sql<number>`count(*)` })
        .from(salesOrders)
        .where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    res.json({
      data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid query parameters', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /sales-orders/:id ──────────────────────────────────────────
salesOrdersRouter.get('/:id', canRead, async (req: AuthRequest, res, next) => {
  try {
    const conditions = [
      eq(salesOrders.id, req.params.id as string),
      ...tenantScope(req),
    ];
    const order = await db.query.salesOrders.findFirst({
      where: and(...conditions),
      with: {
        customer: true,
        lines: true,
        shippingAddress: true,
        billingAddress: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'Sales order not found');
    }

    res.json(order);
  } catch (err) {
    next(err);
  }
});

// ─── POST /sales-orders ─────────────────────────────────────────────
salesOrdersRouter.post('/', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = createSalesOrderSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    // Verify customer exists and belongs to tenant
    const customer = await db.query.customers.findFirst({
      where: and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)),
    });
    if (!customer) {
      throw new AppError(404, 'Customer not found');
    }

    const created = await db.transaction(async (tx) => {
      const soNumber = await getNextSONumber(tenantId, tx);

      // Build lines with computed totals
      const lineData = input.lines.map((line, idx) => ({
        tenantId,
        partId: line.partId,
        lineNumber: idx + 1,
        quantityOrdered: line.quantityOrdered,
        unitPrice: String(line.unitPrice),
        discountPercent: String(line.discountPercent ?? 0),
        lineTotal: computeLineTotal(line.quantityOrdered, line.unitPrice, line.discountPercent ?? 0),
        notes: line.notes,
      }));

      const { subtotal, totalAmount } = computeOrderTotals(lineData);

      const [order] = await tx
        .insert(salesOrders)
        .values({
          tenantId,
          soNumber,
          customerId: input.customerId,
          facilityId: input.facilityId,
          status: 'draft',
          orderDate: input.orderDate ? new Date(input.orderDate) : new Date(),
          requestedShipDate: input.requestedShipDate ? new Date(input.requestedShipDate) : undefined,
          shippingAddressId: input.shippingAddressId,
          billingAddressId: input.billingAddressId,
          paymentTerms: input.paymentTerms,
          shippingMethod: input.shippingMethod,
          notes: input.notes,
          internalNotes: input.internalNotes,
          subtotal,
          totalAmount,
          createdByUserId: req.user!.sub,
        })
        .returning();

      // Insert lines
      const insertedLines = [];
      for (const line of lineData) {
        const [inserted] = await tx
          .insert(salesOrderLines)
          .values({ ...line, salesOrderId: order.id })
          .returning();
        insertedLines.push(inserted);
      }

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'sales_order.created',
        entityType: 'sales_order',
        entityId: order.id,
        newState: {
          soNumber: order.soNumber,
          customerId: order.customerId,
          status: order.status,
          lineCount: insertedLines.length,
          totalAmount,
        },
        metadata: { source: 'sales-orders.create', customerName: customer.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return { ...order, lines: insertedLines };
    });

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /sales-orders/:id ────────────────────────────────────────
salesOrdersRouter.patch('/:id', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = updateSalesOrderSchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);
    const existing = await findOrderOrThrow(req.params.id as string, req);

    // Only draft/confirmed orders can be edited
    if (!['draft', 'confirmed'].includes(existing.status)) {
      throw new AppError(409, `Cannot edit sales order in "${existing.status}" status`);
    }

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    // Convert date strings to Date objects for DB
    const dbValues: Record<string, unknown> = { ...input, updatedAt: new Date() };
    if (input.requestedShipDate) dbValues.requestedShipDate = new Date(input.requestedShipDate);
    if (input.promisedShipDate) dbValues.promisedShipDate = new Date(input.promisedShipDate);

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(salesOrders)
        .set(dbValues)
        .where(and(
          eq(salesOrders.id, req.params.id as string),
          eq(salesOrders.tenantId, req.user!.tenantId),
        ))
        .returning();

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'sales_order.updated',
        entityType: 'sales_order',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'sales-orders.update', soNumber: row.soNumber },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════
//  Status Transitions
// ═════════════════════════════════════════════════════════════════════

// ─── POST /sales-orders/:id/submit ──────────────────────────────────
// Transition: draft → confirmed
salesOrdersRouter.post('/:id/submit', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const existing = await findOrderOrThrow(req.params.id as string, req);
    await transitionStatus(existing, 'confirmed', req, res);
  } catch (err) {
    next(err);
  }
});

// ─── POST /sales-orders/:id/cancel ──────────────────────────────────
salesOrdersRouter.post('/:id/cancel', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const body = transitionStatusSchema.parse(req.body);
    const existing = await findOrderOrThrow(req.params.id as string, req);
    await transitionStatus(existing, 'cancelled', req, res, body.cancelReason);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── POST /sales-orders/:id/transition ──────────────────────────────
// Generic transition endpoint for all valid transitions
salesOrdersRouter.post('/:id/transition', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      status: z.enum(soStatusValues),
      cancelReason: z.string().optional(),
    }).parse(req.body);

    const existing = await findOrderOrThrow(req.params.id as string, req);
    await transitionStatus(existing, body.status, req, res, body.cancelReason);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── POST /sales-orders/:id/convert-quote ───────────────────────────
// Converts a draft (quote) to confirmed (order)
salesOrdersRouter.post('/:id/convert-quote', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const existing = await findOrderOrThrow(req.params.id as string, req);
    if (existing.status !== 'draft') {
      throw new AppError(409, 'Only draft orders (quotes) can be converted');
    }
    await transitionStatus(existing, 'confirmed', req, res);
  } catch (err) {
    next(err);
  }
});

async function transitionStatus(
  existing: Record<string, unknown>,
  targetStatus: SOStatus,
  req: AuthRequest,
  res: express.Response,
  cancelReason?: string
) {
  const currentStatus = existing.status as SOStatus;
  const allowed = SO_VALID_TRANSITIONS[currentStatus];

  if (!allowed.includes(targetStatus)) {
    throw new AppError(
      409,
      `Cannot transition from "${currentStatus}" to "${targetStatus}". Allowed: ${allowed.join(', ') || 'none'}`
    );
  }

  const auditContext = getRequestAuditContext(req);
  const updateData: Record<string, unknown> = {
    status: targetStatus,
    updatedAt: new Date(),
  };
  if (targetStatus === 'cancelled') {
    updateData.cancelledAt = new Date();
    if (cancelReason) updateData.cancelReason = cancelReason;
  }
  if (targetStatus === 'shipped' && !existing.actualShipDate) {
    updateData.actualShipDate = new Date();
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(salesOrders)
      .set(updateData)
      .where(and(
        eq(salesOrders.id, existing.id as string),
        eq(salesOrders.tenantId, req.user!.tenantId),
      ))
      .returning();

    await writeAuditEntry(tx, {
      tenantId: req.user!.tenantId,
      userId: auditContext.userId,
      action: 'sales_order.status_changed',
      entityType: 'sales_order',
      entityId: row.id,
      previousState: { status: currentStatus },
      newState: { status: targetStatus },
      metadata: {
        source: 'sales-orders.transition',
        soNumber: row.soNumber,
        ...(cancelReason ? { cancelReason } : {}),
      },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    return row;
  });

  res.json(updated);
}

// Need express type for transitionStatus response parameter
import type express from 'express';

// ═════════════════════════════════════════════════════════════════════
//  Sales Order Lines
// ═════════════════════════════════════════════════════════════════════

// ─── POST /sales-orders/:id/lines ───────────────────────────────────
salesOrdersRouter.post('/:id/lines', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = addLineSchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);
    const order = await findOrderOrThrow(req.params.id as string, req);

    if (!['draft', 'confirmed'].includes(order.status as string)) {
      throw new AppError(409, `Cannot add lines to order in "${order.status}" status`);
    }

    const created = await db.transaction(async (tx) => {
      // Get next line number
      const existingLines = await tx
        .select({ lineNumber: salesOrderLines.lineNumber })
        .from(salesOrderLines)
        .where(eq(salesOrderLines.salesOrderId, order.id as string))
        .orderBy(desc(salesOrderLines.lineNumber))
        .limit(1);

      const nextLineNumber = existingLines.length > 0 ? (existingLines[0].lineNumber + 1) : 1;
      const lineTotal = computeLineTotal(input.quantityOrdered, input.unitPrice, input.discountPercent ?? 0);

      const [line] = await tx
        .insert(salesOrderLines)
        .values({
          tenantId: req.user!.tenantId,
          salesOrderId: order.id as string,
          partId: input.partId,
          lineNumber: nextLineNumber,
          quantityOrdered: input.quantityOrdered,
          unitPrice: String(input.unitPrice),
          discountPercent: String(input.discountPercent ?? 0),
          lineTotal,
          notes: input.notes,
        })
        .returning();

      // Recalculate order totals
      const allLines = await tx
        .select({ lineTotal: salesOrderLines.lineTotal })
        .from(salesOrderLines)
        .where(eq(salesOrderLines.salesOrderId, order.id as string));

      const { subtotal, totalAmount } = computeOrderTotals(
        allLines.map(l => ({ lineTotal: l.lineTotal }))
      );

      await tx
        .update(salesOrders)
        .set({ subtotal, totalAmount, updatedAt: new Date() })
        .where(eq(salesOrders.id, order.id as string));

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'sales_order_line.added',
        entityType: 'sales_order_line',
        entityId: line.id,
        newState: {
          salesOrderId: line.salesOrderId,
          partId: line.partId,
          lineNumber: line.lineNumber,
          quantityOrdered: line.quantityOrdered,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        },
        metadata: { source: 'sales-orders.lines.add', soNumber: order.soNumber },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return line;
    });

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /sales-orders/:id/lines/:lineId ──────────────────────────
salesOrdersRouter.patch('/:id/lines/:lineId', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = updateLineSchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);
    const order = await findOrderOrThrow(req.params.id as string, req);

    if (!['draft', 'confirmed'].includes(order.status as string)) {
      throw new AppError(409, `Cannot update lines on order in "${order.status}" status`);
    }

    const existingLine = await db.query.salesOrderLines.findFirst({
      where: and(
        eq(salesOrderLines.id, req.params.lineId as string),
        eq(salesOrderLines.salesOrderId, req.params.id as string),
        eq(salesOrderLines.tenantId, req.user!.tenantId),
      ),
    });
    if (!existingLine) {
      throw new AppError(404, 'Sales order line not found');
    }

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existingLine as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      // Compute new lineTotal if qty or price changed
      const qty = input.quantityOrdered ?? existingLine.quantityOrdered;
      const price = input.unitPrice ?? parseFloat(existingLine.unitPrice);
      const discount = input.discountPercent ?? parseFloat(existingLine.discountPercent ?? '0');
      const lineTotal = computeLineTotal(qty, price, discount);

      const setValues: Record<string, unknown> = { ...input, lineTotal, updatedAt: new Date() };
      if (input.unitPrice !== undefined) setValues.unitPrice = String(input.unitPrice);
      if (input.discountPercent !== undefined) setValues.discountPercent = String(input.discountPercent);

      const [row] = await tx
        .update(salesOrderLines)
        .set(setValues)
        .where(and(
          eq(salesOrderLines.id, req.params.lineId as string),
          eq(salesOrderLines.tenantId, req.user!.tenantId),
        ))
        .returning();

      // Recalculate order totals
      const allLines = await tx
        .select({ lineTotal: salesOrderLines.lineTotal })
        .from(salesOrderLines)
        .where(eq(salesOrderLines.salesOrderId, req.params.id as string));

      const { subtotal, totalAmount } = computeOrderTotals(
        allLines.map(l => ({ lineTotal: l.lineTotal }))
      );

      await tx
        .update(salesOrders)
        .set({ subtotal, totalAmount, updatedAt: new Date() })
        .where(eq(salesOrders.id, req.params.id as string));

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'sales_order_line.updated',
        entityType: 'sales_order_line',
        entityId: row.id,
        previousState,
        newState: { ...newState, lineTotal },
        metadata: { source: 'sales-orders.lines.update', soNumber: order.soNumber },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── DELETE /sales-orders/:id/lines/:lineId ─────────────────────────
salesOrdersRouter.delete('/:id/lines/:lineId', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const auditContext = getRequestAuditContext(req);
    const order = await findOrderOrThrow(req.params.id as string, req);

    if (!['draft', 'confirmed'].includes(order.status as string)) {
      throw new AppError(409, `Cannot delete lines from order in "${order.status}" status`);
    }

    const existingLine = await db.query.salesOrderLines.findFirst({
      where: and(
        eq(salesOrderLines.id, req.params.lineId as string),
        eq(salesOrderLines.salesOrderId, req.params.id as string),
        eq(salesOrderLines.tenantId, req.user!.tenantId),
      ),
    });
    if (!existingLine) {
      throw new AppError(404, 'Sales order line not found');
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(salesOrderLines)
        .where(and(
          eq(salesOrderLines.id, req.params.lineId as string),
          eq(salesOrderLines.tenantId, req.user!.tenantId),
        ));

      // Recalculate order totals
      const allLines = await tx
        .select({ lineTotal: salesOrderLines.lineTotal })
        .from(salesOrderLines)
        .where(eq(salesOrderLines.salesOrderId, req.params.id as string));

      const { subtotal, totalAmount } = computeOrderTotals(
        allLines.map(l => ({ lineTotal: l.lineTotal }))
      );

      await tx
        .update(salesOrders)
        .set({ subtotal, totalAmount, updatedAt: new Date() })
        .where(eq(salesOrders.id, req.params.id as string));

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'sales_order_line.deleted',
        entityType: 'sales_order_line',
        entityId: existingLine.id,
        previousState: {
          salesOrderId: existingLine.salesOrderId,
          partId: existingLine.partId,
          lineNumber: existingLine.lineNumber,
          quantityOrdered: existingLine.quantityOrdered,
          unitPrice: existingLine.unitPrice,
          lineTotal: existingLine.lineTotal,
        },
        metadata: { source: 'sales-orders.lines.delete', soNumber: order.soNumber },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });
    });

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});
