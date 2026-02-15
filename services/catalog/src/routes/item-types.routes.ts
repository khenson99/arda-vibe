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

function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export const itemTypesRouter = Router();
const { itemTypes, itemSubtypes } = schema;

const createSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  description: z.string().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sortOrder: z.number().int().default(0),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: z.string().min(1).max(50).optional(),
  description: z.string().nullable().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

// ─── GET /item-types ────────────────────────────────────────────────
itemTypesRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const search = req.query.search as string | undefined;
    const includeInactive = req.query.includeInactive === 'true';
    const includeSubtypes = req.query.includeSubtypes === 'true';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));

    const conditions = [eq(itemTypes.tenantId, tenantId)];
    if (!includeInactive) {
      conditions.push(eq(itemTypes.isActive, true));
    }
    if (search) {
      const escaped = escapeLike(search);
      conditions.push(
        sql`(${ilike(itemTypes.name, `%${escaped}%`)} OR ${ilike(itemTypes.code, `%${escaped}%`)})`
      );
    }

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    if (includeSubtypes) {
      // Use relational query to include subtypes
      const data = await db.query.itemTypes.findMany({
        where: whereClause,
        with: { subtypes: true },
        orderBy: [itemTypes.sortOrder, itemTypes.name],
        limit: pageSize,
        offset,
      });

      const countResult = await db.select({ count: sql<number>`count(*)` }).from(itemTypes).where(whereClause);
      const total = Number(countResult[0]?.count ?? 0);
      res.json({
        data,
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      });
      return;
    }

    const [data, countResult] = await Promise.all([
      db.select().from(itemTypes).where(whereClause).limit(pageSize).offset(offset).orderBy(itemTypes.sortOrder, itemTypes.name),
      db.select({ count: sql<number>`count(*)` }).from(itemTypes).where(whereClause),
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

// ─── GET /item-types/:id ────────────────────────────────────────────
itemTypesRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const row = await db.query.itemTypes.findFirst({
      where: and(eq(itemTypes.id, req.params.id as string), eq(itemTypes.tenantId, tenantId)),
      with: { subtypes: true },
    });
    if (!row) throw new AppError(404, 'Item type not found');
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// ─── POST /item-types ───────────────────────────────────────────────
itemTypesRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(itemTypes)
        .values({ ...input, tenantId })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'item_type.created',
        entityType: 'item_type',
        entityId: row.id,
        newState: { name: row.name, code: row.code, colorHex: row.colorHex },
        metadata: { source: 'item-types.create' },
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

// ─── PATCH /item-types/:id ──────────────────────────────────────────
itemTypesRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const input = updateSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.itemTypes.findFirst({
      where: and(eq(itemTypes.id, req.params.id as string), eq(itemTypes.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Item type not found');

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(itemTypes)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(itemTypes.id, req.params.id as string), eq(itemTypes.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'item_type.updated',
        entityType: 'item_type',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'item-types.update', itemTypeName: row.name },
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

// ─── DELETE /item-types/:id (soft delete) ───────────────────────────
itemTypesRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.itemTypes.findFirst({
      where: and(eq(itemTypes.id, req.params.id as string), eq(itemTypes.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Item type not found');
    if (!existing.isActive) throw new AppError(400, 'Item type is already deactivated');

    const deactivated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(itemTypes)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(itemTypes.id, req.params.id as string), eq(itemTypes.tenantId, tenantId)))
        .returning();

      // Also deactivate subtypes under this type
      await tx
        .update(itemSubtypes)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(itemSubtypes.itemTypeId, row.id), eq(itemSubtypes.tenantId, tenantId)));

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'item_type.deactivated',
        entityType: 'item_type',
        entityId: row.id,
        previousState: { isActive: true },
        newState: { isActive: false },
        metadata: { source: 'item-types.deactivate', itemTypeName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(deactivated);
  } catch (err) {
    next(err);
  }
});

// ─── Item Subtypes (nested under item types) ────────────────────────

const createSubtypeSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  description: z.string().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sortOrder: z.number().int().default(0),
});

const updateSubtypeSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: z.string().min(1).max(50).optional(),
  description: z.string().nullable().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

// ─── GET /item-types/:typeId/subtypes ───────────────────────────────
itemTypesRouter.get('/:typeId/subtypes', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const typeId = req.params.typeId as string;
    const includeInactive = req.query.includeInactive === 'true';

    const conditions = [
      eq(itemSubtypes.tenantId, tenantId),
      eq(itemSubtypes.itemTypeId, typeId),
    ];
    if (!includeInactive) {
      conditions.push(eq(itemSubtypes.isActive, true));
    }

    const data = await db.select().from(itemSubtypes).where(and(...conditions)).orderBy(itemSubtypes.sortOrder, itemSubtypes.name);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── POST /item-types/:typeId/subtypes ──────────────────────────────
itemTypesRouter.post('/:typeId/subtypes', async (req: AuthRequest, res, next) => {
  try {
    const input = createSubtypeSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const typeId = req.params.typeId as string;
    const auditContext = getRequestAuditContext(req);

    // Verify parent type exists and belongs to tenant
    const parentType = await db.query.itemTypes.findFirst({
      where: and(eq(itemTypes.id, typeId), eq(itemTypes.tenantId, tenantId)),
    });
    if (!parentType) throw new AppError(404, 'Item type not found');

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(itemSubtypes)
        .values({ ...input, itemTypeId: typeId, tenantId })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'item_subtype.created',
        entityType: 'item_subtype',
        entityId: row.id,
        newState: { name: row.name, code: row.code, itemTypeId: typeId, colorHex: row.colorHex },
        metadata: { source: 'item-types.subtypes.create', parentTypeName: parentType.name },
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

// ─── PATCH /item-types/:typeId/subtypes/:id ─────────────────────────
itemTypesRouter.patch('/:typeId/subtypes/:id', async (req: AuthRequest, res, next) => {
  try {
    const input = updateSubtypeSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const subtypeId = req.params.id as string;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.itemSubtypes.findFirst({
      where: and(eq(itemSubtypes.id, subtypeId), eq(itemSubtypes.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Item subtype not found');

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(itemSubtypes)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(itemSubtypes.id, subtypeId), eq(itemSubtypes.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'item_subtype.updated',
        entityType: 'item_subtype',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'item-types.subtypes.update', subtypeName: row.name },
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

// ─── DELETE /item-types/:typeId/subtypes/:id (soft delete) ──────────
itemTypesRouter.delete('/:typeId/subtypes/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const subtypeId = req.params.id as string;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.itemSubtypes.findFirst({
      where: and(eq(itemSubtypes.id, subtypeId), eq(itemSubtypes.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Item subtype not found');
    if (!existing.isActive) throw new AppError(400, 'Item subtype is already deactivated');

    const deactivated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(itemSubtypes)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(itemSubtypes.id, subtypeId), eq(itemSubtypes.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'item_subtype.deactivated',
        entityType: 'item_subtype',
        entityId: row.id,
        previousState: { isActive: true },
        newState: { isActive: false },
        metadata: { source: 'item-types.subtypes.deactivate', subtypeName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(deactivated);
  } catch (err) {
    next(err);
  }
});
