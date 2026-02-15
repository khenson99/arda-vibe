import { Router } from 'express';
import { z } from 'zod';
import { eq, and, ilike, sql, desc, asc, inArray } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest, AuditContext } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';
import {
  calculateLeadTimeDays,
  isOnTimeDelivery,
  computeGrade,
  safeAverage,
} from '../services/supplier-performance.service.js';

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

export const suppliersRouter = Router();
const { suppliers, supplierParts, purchaseOrders, purchaseOrderLines, inventoryLedger } = schema;

const CLOSED_PO_STATUSES = ['received', 'closed', 'cancelled'] as const;
const COMPLETED_STATUSES = ['received', 'closed'] as const;

/** Escape LIKE/ILIKE metacharacters so user input is treated literally. */
function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseOptionalBoolean(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new AppError(400, `Invalid ${field}; expected true or false`);
}

// Allowed sort fields for supplier list
const SORT_FIELDS = ['name', 'code', 'createdAt', 'updatedAt', 'contactName', 'city', 'country'] as const;
type SortField = typeof SORT_FIELDS[number];

function getSortColumn(field: SortField) {
  switch (field) {
    case 'name': return suppliers.name;
    case 'code': return suppliers.code;
    case 'createdAt': return suppliers.createdAt;
    case 'updatedAt': return suppliers.updatedAt;
    case 'contactName': return suppliers.contactName;
    case 'city': return suppliers.city;
    case 'country': return suppliers.country;
  }
}

const createSupplierSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().max(50).optional(),
  contactName: z.string().max(255).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(50).optional(),
  recipient: z.string().max(255).optional(),
  recipientEmail: z.string().email().optional(),
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(100).default('US'),
  website: z.string().url().optional(),
  notes: z.string().optional(),
  statedLeadTimeDays: z.number().int().positive().optional(),
  paymentTerms: z.string().max(100).optional(),
  shippingTerms: z.string().max(100).optional(),
  orderMethods: z.array(z.string().max(50)).max(20).optional(),
});

// ─── GET /suppliers ───────────────────────────────────────────────────
suppliersRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const search = req.query.search as string | undefined;
    const isActive = parseOptionalBoolean(req.query.isActive as string | undefined, 'isActive');
    const hasOpenOrders = parseOptionalBoolean(req.query.hasOpenOrders as string | undefined, 'hasOpenOrders');
    const orderMethod = typeof req.query.orderMethod === 'string'
      ? req.query.orderMethod.trim().toLowerCase()
      : undefined;
    const country = typeof req.query.country === 'string' ? req.query.country.trim() : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    // Sort parameters
    const sortByRaw = typeof req.query.sortBy === 'string' ? req.query.sortBy.trim() : 'name';
    const sortBy = (SORT_FIELDS as readonly string[]).includes(sortByRaw) ? sortByRaw as SortField : 'name';
    const sortDirection = req.query.sortDirection === 'desc' ? 'desc' : 'asc';

    const conditions = [eq(suppliers.tenantId, tenantId)];
    conditions.push(eq(suppliers.isActive, isActive ?? true));

    if (search) {
      const escaped = escapeLike(search);
      conditions.push(
        sql`(${ilike(suppliers.name, `%${escaped}%`)} OR ${ilike(suppliers.code, `%${escaped}%`)} OR ${ilike(suppliers.contactName, `%${escaped}%`)} OR ${ilike(suppliers.contactEmail, `%${escaped}%`)})`
      );
    }
    if (country) {
      conditions.push(ilike(suppliers.country, country));
    }
    if (orderMethod) {
      const hasOrderMethod = sql`EXISTS (
        SELECT 1
        FROM orders.purchase_order_lines pol
        INNER JOIN orders.purchase_orders po ON po.id = pol.purchase_order_id
        WHERE po.tenant_id = ${tenantId}
          AND po.supplier_id = ${suppliers.id}
          AND lower(pol.order_method) = ${orderMethod}
      )`;
      conditions.push(hasOrderMethod);
    }
    if (hasOpenOrders !== undefined) {
      const hasOpenPOs = sql`EXISTS (
        SELECT 1
        FROM orders.purchase_orders po
        WHERE po.tenant_id = ${tenantId}
          AND po.supplier_id = ${suppliers.id}
          AND po.status NOT IN ('received', 'closed', 'cancelled')
      )`;
      conditions.push(hasOpenOrders ? hasOpenPOs : sql`NOT (${hasOpenPOs})`);
    }

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;
    const sortCol = getSortColumn(sortBy);
    const orderFn = sortDirection === 'desc' ? desc(sortCol) : asc(sortCol);

    const [data, countResult] = await Promise.all([
      db.select().from(suppliers).where(whereClause).limit(pageSize).offset(offset).orderBy(orderFn),
      db.select({ count: sql<number>`count(*)` }).from(suppliers).where(whereClause),
    ]);

    // Enrich with summary counts if data is present
    let enrichedData = data;
    if (data.length > 0) {
      const supplierIds = data.map((s) => s.id);

      const [partCounts, openPOCounts] = await Promise.all([
        db
          .select({
            supplierId: supplierParts.supplierId,
            count: sql<number>`count(*)::int`,
          })
          .from(supplierParts)
          .where(and(
            eq(supplierParts.tenantId, tenantId),
            inArray(supplierParts.supplierId, supplierIds),
            eq(supplierParts.isActive, true),
          ))
          .groupBy(supplierParts.supplierId),
        db
          .select({
            supplierId: purchaseOrders.supplierId,
            count: sql<number>`count(*)::int`,
          })
          .from(purchaseOrders)
          .where(and(
            eq(purchaseOrders.tenantId, tenantId),
            inArray(purchaseOrders.supplierId, supplierIds),
            sql`${purchaseOrders.status} NOT IN ('received', 'closed', 'cancelled')`,
          ))
          .groupBy(purchaseOrders.supplierId),
      ]);

      const partCountMap = new Map(partCounts.map((r) => [r.supplierId, Number(r.count)]));
      const openPOMap = new Map(openPOCounts.map((r) => [r.supplierId, Number(r.count)]));

      enrichedData = data.map((s) => ({
        ...s,
        _counts: {
          linkedParts: partCountMap.get(s.id) ?? 0,
          openPurchaseOrders: openPOMap.get(s.id) ?? 0,
        },
      }));
    }

    const total = Number(countResult[0]?.count ?? 0);
    res.json({
      data: enrichedData,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /suppliers/:id ──────────────────────────────────────────────
suppliersRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const supplierId = req.params.id as string;
    const supplier = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, supplierId), eq(suppliers.tenantId, tenantId)),
      with: {
        supplierParts: { with: { part: true } },
      },
    });
    if (!supplier) throw new AppError(404, 'Supplier not found');

    const [poSummaryRows, poMethodRows, inventorySummaryRows, completedPOs] = await Promise.all([
      db
        .select({
          totalPurchaseOrders: sql<number>`count(*)::int`,
          openPurchaseOrders:
            sql<number>`count(*) FILTER (WHERE ${purchaseOrders.status} NOT IN ('received', 'closed', 'cancelled'))::int`,
        })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.supplierId, supplierId))),
      db
        .select({
          orderMethod: purchaseOrderLines.orderMethod,
          count: sql<number>`count(*)::int`,
        })
        .from(purchaseOrderLines)
        .innerJoin(
          purchaseOrders,
          and(
            eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId),
            eq(purchaseOrders.tenantId, tenantId),
            eq(purchaseOrders.supplierId, supplierId),
          )
        )
        .where(and(
          eq(purchaseOrderLines.tenantId, tenantId),
          sql`${purchaseOrderLines.orderMethod} IS NOT NULL`,
        ))
        .groupBy(purchaseOrderLines.orderMethod),
      db
        .select({
          linkedParts: sql<number>`count(distinct ${supplierParts.partId})::int`,
          facilitiesWithInventory: sql<number>`count(distinct ${inventoryLedger.facilityId})::int`,
        })
        .from(supplierParts)
        .leftJoin(
          inventoryLedger,
          and(
            eq(inventoryLedger.tenantId, tenantId),
            eq(inventoryLedger.partId, supplierParts.partId),
          )
        )
        .where(and(
          eq(supplierParts.tenantId, tenantId),
          eq(supplierParts.supplierId, supplierId),
          eq(supplierParts.isActive, true),
        )),
      // Fetch completed POs for performance grade
      db
        .select()
        .from(purchaseOrders)
        .where(and(
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.supplierId, supplierId),
          inArray(purchaseOrders.status, [...COMPLETED_STATUSES]),
        )),
    ]);

    const poSummary = poSummaryRows[0] ?? { totalPurchaseOrders: 0, openPurchaseOrders: 0 };
    const inventorySummary = inventorySummaryRows[0] ?? { linkedParts: 0, facilitiesWithInventory: 0 };
    const orderMethods = poMethodRows
      .filter((row) => typeof row.orderMethod === 'string' && row.orderMethod.length > 0)
      .map((row) => ({
        method: row.orderMethod as string,
        count: Number(row.count ?? 0),
      }));

    // Compute performance grade from completed POs
    const onTimeResults = completedPOs.map((po) =>
      isOnTimeDelivery(po.actualDeliveryDate, po.expectedDeliveryDate)
    );
    const validOnTime = onTimeResults.filter((v): v is boolean => v !== null);
    const onTimeRate = validOnTime.length > 0
      ? Math.round((validOnTime.filter(Boolean).length / validOnTime.length) * 10000) / 100
      : null;
    const qualityRate = completedPOs.length >= 3 ? 95 : null;
    const grade = computeGrade(onTimeRate, qualityRate, completedPOs.length);
    const leadTimes = completedPOs.map((po) =>
      calculateLeadTimeDays(po.sentAt, po.actualDeliveryDate)
    );

    res.json({
      ...supplier,
      performance: {
        grade,
        completedPOs: completedPOs.length,
        onTimeDeliveryRate: onTimeRate,
        avgLeadTimeDays: safeAverage(leadTimes),
      },
      links: {
        purchaseOrders: {
          total: Number(poSummary.totalPurchaseOrders ?? 0),
          open: Number(poSummary.openPurchaseOrders ?? 0),
          closed: Math.max(
            0,
            Number(poSummary.totalPurchaseOrders ?? 0) - Number(poSummary.openPurchaseOrders ?? 0),
          ),
          closedStatuses: CLOSED_PO_STATUSES,
          orderMethods,
        },
        inventory: {
          linkedParts: Number(inventorySummary.linkedParts ?? 0),
          facilitiesWithInventory: Number(inventorySummary.facilitiesWithInventory ?? 0),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /suppliers/:id/purchase-orders ─────────────────────────────
suppliersRouter.get('/:id/purchase-orders', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const supplierId = req.params.id as string;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;

    // Verify supplier exists
    const supplierExists = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, supplierId), eq(suppliers.tenantId, tenantId)),
    });
    if (!supplierExists) throw new AppError(404, 'Supplier not found');

    const conditions = [
      eq(purchaseOrders.tenantId, tenantId),
      eq(purchaseOrders.supplierId, supplierId),
    ];
    if (status) {
      conditions.push(sql`${purchaseOrders.status} = ${status}`);
    }

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [data, countResult] = await Promise.all([
      db.select({
        id: purchaseOrders.id,
        poNumber: purchaseOrders.poNumber,
        status: purchaseOrders.status,
        orderDate: purchaseOrders.orderDate,
        expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
        actualDeliveryDate: purchaseOrders.actualDeliveryDate,
        totalAmount: purchaseOrders.totalAmount,
        currency: purchaseOrders.currency,
        createdAt: purchaseOrders.createdAt,
      }).from(purchaseOrders)
        .where(whereClause)
        .limit(pageSize)
        .offset(offset)
        .orderBy(desc(purchaseOrders.createdAt)),
      db.select({ count: sql<number>`count(*)` }).from(purchaseOrders).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    res.json({
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /suppliers ─────────────────────────────────────────────────
suppliersRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const input = createSupplierSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(suppliers).values({ ...input, tenantId }).returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'supplier.created',
        entityType: 'supplier',
        entityId: row.id,
        newState: {
          name: row.name,
          code: row.code,
          contactName: row.contactName,
          contactEmail: row.contactEmail,
          orderMethods: row.orderMethods,
          isActive: row.isActive,
        },
        metadata: { source: 'suppliers.create' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
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

// ─── PATCH /suppliers/:id ────────────────────────────────────────────
suppliersRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const input = createSupplierSchema.partial().parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    // Read prior state before mutation
    const existing = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, req.params.id as string), eq(suppliers.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Supplier not found');

    // Build field-level snapshots for changed fields only
    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(suppliers)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(suppliers.id, req.params.id as string), eq(suppliers.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'supplier.updated',
        entityType: 'supplier',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'suppliers.update', supplierName: row.name },
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

// ─── DELETE /suppliers/:id (soft deactivate) ─────────────────────────
suppliersRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, req.params.id as string), eq(suppliers.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Supplier not found');

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(suppliers)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(suppliers.id, req.params.id as string), eq(suppliers.tenantId, tenantId)))
        .returning();

      await tx
        .update(supplierParts)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(
          eq(supplierParts.tenantId, tenantId),
          eq(supplierParts.supplierId, req.params.id as string),
          eq(supplierParts.isActive, true),
        ));

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'supplier.deactivated',
        entityType: 'supplier',
        entityId: row.id,
        previousState: { isActive: existing.isActive },
        newState: { isActive: false },
        metadata: { source: 'suppliers.deactivate', supplierName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST /suppliers/:id/reactivate ─────────────────────────────────
suppliersRouter.post('/:id/reactivate', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, req.params.id as string), eq(suppliers.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Supplier not found');
    if (existing.isActive) throw new AppError(400, 'Supplier is already active');

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(suppliers)
        .set({ isActive: true, updatedAt: new Date() })
        .where(and(eq(suppliers.id, req.params.id as string), eq(suppliers.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'supplier.reactivated',
        entityType: 'supplier',
        entityId: row.id,
        previousState: { isActive: false },
        newState: { isActive: true },
        metadata: { source: 'suppliers.reactivate', supplierName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST /suppliers/:id/parts — Link a part to this supplier ────────
suppliersRouter.post('/:id/parts', async (req: AuthRequest, res, next) => {
  try {
    const linkSchema = z.object({
      partId: z.string().uuid(),
      supplierPartNumber: z.string().max(100).optional(),
      unitCost: z.string().optional(),
      minimumOrderQty: z.number().int().positive().default(1),
      leadTimeDays: z.number().int().positive().optional(),
      isPrimary: z.boolean().default(false),
    });

    const input = linkSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(supplierParts)
        .values({
          tenantId,
          supplierId: req.params.id as string,
          ...input,
        })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'supplier.part_linked',
        entityType: 'supplier_part',
        entityId: row.id,
        newState: {
          supplierId: req.params.id as string,
          partId: input.partId,
          supplierPartNumber: input.supplierPartNumber,
          unitCost: input.unitCost,
          isPrimary: input.isPrimary,
        },
        metadata: { source: 'suppliers.link_part' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
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

// ─── PATCH /suppliers/:id/parts/:supplierPartId ─────────────────────
suppliersRouter.patch('/:id/parts/:supplierPartId', async (req: AuthRequest, res, next) => {
  try {
    const updateSupplierPartSchema = z.object({
      supplierPartNumber: z.string().max(100).optional(),
      unitCost: z.string().optional(),
      minimumOrderQty: z.number().int().positive().optional(),
      leadTimeDays: z.number().int().positive().optional(),
      isPrimary: z.boolean().optional(),
      isActive: z.boolean().optional(),
    });

    const input = updateSupplierPartSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const supplierId = req.params.id as string;
    const supplierPartId = req.params.supplierPartId as string;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.supplierParts.findFirst({
      where: and(
        eq(supplierParts.id, supplierPartId),
        eq(supplierParts.supplierId, supplierId),
        eq(supplierParts.tenantId, tenantId),
      ),
    });
    if (!existing) throw new AppError(404, 'Supplier part link not found');

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    if (changedFields.length === 0) {
      res.json(existing);
      return;
    }

    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(supplierParts)
        .set({ ...input, updatedAt: new Date() })
        .where(and(
          eq(supplierParts.id, supplierPartId),
          eq(supplierParts.supplierId, supplierId),
          eq(supplierParts.tenantId, tenantId),
        ))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'supplier.part_updated',
        entityType: 'supplier_part',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'suppliers.update_part', supplierId },
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

// ─── DELETE /suppliers/:id/parts/:supplierPartId (soft unlink) ──────
suppliersRouter.delete('/:id/parts/:supplierPartId', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const supplierId = req.params.id as string;
    const supplierPartId = req.params.supplierPartId as string;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.supplierParts.findFirst({
      where: and(
        eq(supplierParts.id, supplierPartId),
        eq(supplierParts.supplierId, supplierId),
        eq(supplierParts.tenantId, tenantId),
      ),
    });
    if (!existing) throw new AppError(404, 'Supplier part link not found');

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(supplierParts)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(
          eq(supplierParts.id, supplierPartId),
          eq(supplierParts.supplierId, supplierId),
          eq(supplierParts.tenantId, tenantId),
        ))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'supplier.part_unlinked',
        entityType: 'supplier_part',
        entityId: row.id,
        previousState: { isActive: existing.isActive },
        newState: { isActive: false },
        metadata: { source: 'suppliers.unlink_part', supplierId },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});
