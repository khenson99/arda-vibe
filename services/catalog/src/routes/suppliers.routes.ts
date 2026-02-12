import { Router } from 'express';
import { z } from 'zod';
import { eq, and, ilike, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

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

    const [created] = await db.insert(suppliers).values({ ...input, tenantId }).returning();
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
    const [updated] = await db
      .update(suppliers)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(suppliers.id, req.params.id as string), eq(suppliers.tenantId, req.user!.tenantId)))
      .returning();

    if (!updated) throw new AppError(404, 'Supplier not found');
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

    const [created] = await db
      .insert(supplierParts)
      .values({
        tenantId,
        supplierId: req.params.id as string,
        ...input,
      })
      .returning();

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});
