import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

export const auditRouter = Router();

const listAuditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

auditRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const { page, limit, action, entityType, entityId, userId, dateFrom, dateTo } =
      listAuditQuerySchema.parse(req.query);

    const offset = (page - 1) * limit;
    const conditions: any[] = [eq(schema.auditLog.tenantId, tenantId)];

    if (action) {
      conditions.push(eq(schema.auditLog.action, action));
    }
    if (entityType) {
      conditions.push(eq(schema.auditLog.entityType, entityType));
    }
    if (entityId) {
      conditions.push(eq(schema.auditLog.entityId, entityId));
    }
    if (userId) {
      conditions.push(eq(schema.auditLog.userId, userId));
    }
    if (dateFrom) {
      conditions.push(sql`${schema.auditLog.timestamp} >= ${new Date(dateFrom)}`);
    }
    if (dateTo) {
      conditions.push(sql`${schema.auditLog.timestamp} <= ${new Date(dateTo)}`);
    }

    const [countResult] = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(schema.auditLog)
      .where(and(...conditions));

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(...conditions))
      .orderBy(desc(schema.auditLog.timestamp))
      .limit(limit)
      .offset(offset);

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total: countResult?.count ?? 0,
        pages: Math.ceil((countResult?.count ?? 0) / limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});
