import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
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

export const categoriesRouter = Router();
const { partCategories } = schema;

// ─── GET /categories ─────────────────────────────────────────────────
categoriesRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const categories = await db.query.partCategories.findMany({
      where: eq(partCategories.tenantId, req.user!.tenantId),
      orderBy: partCategories.sortOrder,
    });
    res.json(categories);
  } catch (err) {
    next(err);
  }
});

// ─── POST /categories ────────────────────────────────────────────────
categoriesRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const input = z
      .object({
        name: z.string().min(1).max(255),
        parentCategoryId: z.string().uuid().optional(),
        description: z.string().optional(),
        sortOrder: z.number().int().default(0),
      })
      .parse(req.body);

    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(partCategories)
        .values({ ...input, tenantId })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'category.created',
        entityType: 'category',
        entityId: row.id,
        newState: {
          name: row.name,
          parentCategoryId: row.parentCategoryId,
          sortOrder: row.sortOrder,
        },
        metadata: { source: 'categories.create' },
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

// ─── PATCH /categories/:id ───────────────────────────────────────────
categoriesRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const input = z
      .object({
        name: z.string().min(1).max(255).optional(),
        parentCategoryId: z.string().uuid().nullable().optional(),
        description: z.string().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body);

    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    // Read prior state before mutation
    const existing = await db.query.partCategories.findFirst({
      where: and(eq(partCategories.id, req.params.id as string), eq(partCategories.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Category not found');

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
        .update(partCategories)
        .set({ ...input, updatedAt: new Date() })
        .where(
          and(eq(partCategories.id, req.params.id as string), eq(partCategories.tenantId, tenantId))
        )
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'category.updated',
        entityType: 'category',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'categories.update', categoryName: row.name },
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
