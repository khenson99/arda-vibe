import { Router } from 'express';
import { z } from 'zod';
import { eq, and, ilike, sql } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest, AuditContext } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

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
const { suppliers, supplierParts } = schema;

/** Escape LIKE/ILIKE metacharacters so user input is treated literally. */
function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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
});

// ─── GET /suppliers ───────────────────────────────────────────────────
suppliersRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const search = req.query.search as string | undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    const conditions = [eq(suppliers.tenantId, tenantId), eq(suppliers.isActive, true)];
    if (search) {
      const escaped = escapeLike(search);
      conditions.push(
        sql`(${ilike(suppliers.name, `%${escaped}%`)} OR ${ilike(suppliers.code, `%${escaped}%`)})`
      );
    }

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [data, countResult] = await Promise.all([
      db.select().from(suppliers).where(whereClause).limit(pageSize).offset(offset).orderBy(suppliers.name),
      db.select({ count: sql<number>`count(*)` }).from(suppliers).where(whereClause),
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

// ─── GET /suppliers/:id ──────────────────────────────────────────────
suppliersRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const supplier = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, req.params.id as string), eq(suppliers.tenantId, req.user!.tenantId)),
      with: {
        supplierParts: { with: { part: true } },
      },
    });
    if (!supplier) throw new AppError(404, 'Supplier not found');
    res.json(supplier);
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
