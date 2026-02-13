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

export const partsRouter = Router();
const { parts } = schema;

/** Escape LIKE/ILIKE metacharacters so user input is treated literally. */
function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ─── Validation ───────────────────────────────────────────────────────
const createPartSchema = z.object({
  partNumber: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  type: z.enum(['raw_material', 'component', 'subassembly', 'finished_good', 'consumable', 'packaging', 'other']).default('component'),
  uom: z.enum(['each', 'box', 'case', 'pallet', 'kg', 'lb', 'meter', 'foot', 'liter', 'gallon', 'roll', 'sheet', 'pair', 'set', 'other']).default('each'),
  unitCost: z.string().optional(),
  unitPrice: z.string().optional(),
  weight: z.string().optional(),
  upcBarcode: z.string().max(50).optional(),
  manufacturerPartNumber: z.string().max(100).optional(),
  imageUrl: z.string().url().optional(),
  orderMechanism: z.string().trim().max(30).optional(),
  location: z.string().trim().max(255).optional(),
  minQty: z.number().int().nonnegative().optional(),
  minQtyUnit: z.string().trim().max(50).optional(),
  orderQty: z.number().int().nonnegative().optional(),
  orderQtyUnit: z.string().trim().max(50).optional(),
  primarySupplierName: z.string().trim().max(255).optional(),
  primarySupplierLink: z.string().trim().max(2048).optional(),
  itemNotes: z.string().optional(),
  glCode: z.string().trim().max(100).optional(),
  itemSubtype: z.string().trim().max(100).optional(),
  specifications: z.record(z.string()).optional(),
  isSellable: z.boolean().default(false),
});

const updatePartSchema = createPartSchema.partial();

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  type: z.string().optional(),
  isSellable: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional(),
});

// ─── GET /parts ───────────────────────────────────────────────────────
partsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const tenantId = req.user!.tenantId;
    const offset = (query.page - 1) * query.pageSize;

    const conditions = [eq(parts.tenantId, tenantId)];
    if (query.search) {
      const escaped = escapeLike(query.search);
      conditions.push(
        sql`(${ilike(parts.partNumber, `%${escaped}%`)} OR ${ilike(parts.name, `%${escaped}%`)})`
      );
    }
    if (query.categoryId) conditions.push(eq(parts.categoryId, query.categoryId));
    if (query.type) conditions.push(eq(parts.type, query.type as (typeof schema.partTypeEnum.enumValues)[number]));
    if (query.isSellable !== undefined) conditions.push(eq(parts.isSellable, query.isSellable));
    if (query.isActive !== undefined) conditions.push(eq(parts.isActive, query.isActive));
    else conditions.push(eq(parts.isActive, true)); // default to active only

    const whereClause = and(...conditions);

    const [data, countResult] = await Promise.all([
      db.select().from(parts).where(whereClause).limit(query.pageSize).offset(offset).orderBy(parts.partNumber),
      db.select({ count: sql<number>`count(*)` }).from(parts).where(whereClause),
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

// ─── GET /parts/:id ──────────────────────────────────────────────────
partsRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const part = await db.query.parts.findFirst({
      where: and(
        eq(parts.id, req.params.id as string),
        eq(parts.tenantId, req.user!.tenantId)
      ),
      with: {
        category: true,
        supplierParts: { with: { supplier: true } },
        bomChildren: { with: { childPart: true } },
      },
    });

    if (!part) {
      throw new AppError(404, 'Part not found');
    }

    res.json(part);
  } catch (err) {
    next(err);
  }
});

// ─── POST /parts ──────────────────────────────────────────────────────
partsRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const input = createPartSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    // Check for duplicate part number within tenant
    const existing = await db.query.parts.findFirst({
      where: and(eq(parts.tenantId, tenantId), eq(parts.partNumber, input.partNumber)),
    });
    if (existing) {
      throw new AppError(409, `Part number "${input.partNumber}" already exists`, 'DUPLICATE_PART_NUMBER');
    }

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(parts)
        .values({ ...input, tenantId })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'part.created',
        entityType: 'part',
        entityId: row.id,
        newState: {
          partNumber: row.partNumber,
          name: row.name,
          type: row.type,
          uom: row.uom,
          categoryId: row.categoryId,
          isActive: row.isActive,
        },
        metadata: { source: 'parts.create' },
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

// ─── PATCH /parts/:id ────────────────────────────────────────────────
partsRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const input = updatePartSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    // Verify the part exists and belongs to this tenant
    const existing = await db.query.parts.findFirst({
      where: and(eq(parts.id, req.params.id as string), eq(parts.tenantId, tenantId)),
    });
    if (!existing) {
      throw new AppError(404, 'Part not found');
    }

    // If changing part number, check for duplicates
    if (input.partNumber && input.partNumber !== existing.partNumber) {
      const duplicate = await db.query.parts.findFirst({
        where: and(eq(parts.tenantId, tenantId), eq(parts.partNumber, input.partNumber)),
      });
      if (duplicate) {
        throw new AppError(409, `Part number "${input.partNumber}" already exists`, 'DUPLICATE_PART_NUMBER');
      }
    }

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
        .update(parts)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(parts.id, req.params.id as string), eq(parts.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'part.updated',
        entityType: 'part',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'parts.update', partNumber: row.partNumber },
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

// ─── DELETE /parts/:id (soft delete) ─────────────────────────────────
partsRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const updated = await db.transaction(async (tx) => {
      // Read prior state before mutation
      const [existing] = await tx
        .select()
        .from(parts)
        .where(and(eq(parts.id, req.params.id as string), eq(parts.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        throw new AppError(404, 'Part not found');
      }

      const [row] = await tx
        .update(parts)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(parts.id, req.params.id as string), eq(parts.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'part.deactivated',
        entityType: 'part',
        entityId: row.id,
        previousState: { isActive: true },
        newState: { isActive: false },
        metadata: { source: 'parts.deactivate', partNumber: existing.partNumber },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json({ message: 'Part deactivated', id: updated.id });
  } catch (err) {
    next(err);
  }
});
