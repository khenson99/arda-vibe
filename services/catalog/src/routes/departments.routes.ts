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

export const departmentsRouter = Router();
const { departments } = schema;

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

// ─── GET /departments ───────────────────────────────────────────────
departmentsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const search = req.query.search as string | undefined;
    const includeInactive = req.query.includeInactive === 'true';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));

    const conditions = [eq(departments.tenantId, tenantId)];
    if (!includeInactive) {
      conditions.push(eq(departments.isActive, true));
    }
    if (search) {
      const escaped = escapeLike(search);
      conditions.push(
        sql`(${ilike(departments.name, `%${escaped}%`)} OR ${ilike(departments.code, `%${escaped}%`)})`
      );
    }

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [data, countResult] = await Promise.all([
      db.select().from(departments).where(whereClause).limit(pageSize).offset(offset).orderBy(departments.sortOrder, departments.name),
      db.select({ count: sql<number>`count(*)` }).from(departments).where(whereClause),
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

// ─── GET /departments/:id ───────────────────────────────────────────
departmentsRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const row = await db.query.departments.findFirst({
      where: and(eq(departments.id, req.params.id as string), eq(departments.tenantId, tenantId)),
    });
    if (!row) throw new AppError(404, 'Department not found');
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// ─── POST /departments ──────────────────────────────────────────────
departmentsRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(departments)
        .values({ ...input, tenantId })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'department.created',
        entityType: 'department',
        entityId: row.id,
        newState: { name: row.name, code: row.code, colorHex: row.colorHex },
        metadata: { source: 'departments.create' },
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

// ─── PATCH /departments/:id ─────────────────────────────────────────
departmentsRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const input = updateSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.departments.findFirst({
      where: and(eq(departments.id, req.params.id as string), eq(departments.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Department not found');

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(departments)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(departments.id, req.params.id as string), eq(departments.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'department.updated',
        entityType: 'department',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'departments.update', departmentName: row.name },
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

// ─── DELETE /departments/:id (soft delete) ──────────────────────────
departmentsRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.departments.findFirst({
      where: and(eq(departments.id, req.params.id as string), eq(departments.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Department not found');
    if (!existing.isActive) throw new AppError(400, 'Department is already deactivated');

    const deactivated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(departments)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(departments.id, req.params.id as string), eq(departments.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'department.deactivated',
        entityType: 'department',
        entityId: row.id,
        previousState: { isActive: true },
        newState: { isActive: false },
        metadata: { source: 'departments.deactivate', departmentName: row.name },
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
