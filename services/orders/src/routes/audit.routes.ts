import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

export const auditRouter = Router();

const baseAuditFilterSchema = z.object({
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

const listAuditQuerySchema = baseAuditFilterSchema.extend({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const summaryAuditQuerySchema = baseAuditFilterSchema.extend({
  granularity: z.enum(['day', 'week']).default('day'),
});

type AuditFilters = z.infer<typeof baseAuditFilterSchema>;

function buildAuditConditions(tenantId: string, filters: AuditFilters) {
  const conditions: any[] = [eq(schema.auditLog.tenantId, tenantId)];

  if (filters.action) {
    conditions.push(eq(schema.auditLog.action, filters.action));
  }
  if (filters.entityType) {
    conditions.push(eq(schema.auditLog.entityType, filters.entityType));
  }
  if (filters.entityId) {
    conditions.push(eq(schema.auditLog.entityId, filters.entityId));
  }
  if (filters.userId) {
    conditions.push(eq(schema.auditLog.userId, filters.userId));
  }
  if (filters.dateFrom) {
    conditions.push(sql`${schema.auditLog.timestamp} >= ${new Date(filters.dateFrom)}`);
  }
  if (filters.dateTo) {
    conditions.push(sql`${schema.auditLog.timestamp} <= ${new Date(filters.dateTo)}`);
  }

  return conditions;
}

auditRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const { page, limit, action, entityType, entityId, userId, dateFrom, dateTo } =
      listAuditQuerySchema.parse(req.query);

    const offset = (page - 1) * limit;
    const conditions = buildAuditConditions(tenantId, {
      action,
      entityType,
      entityId,
      userId,
      dateFrom,
      dateTo,
    });

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

auditRouter.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const { action, entityType, entityId, userId, dateFrom, dateTo, granularity } =
      summaryAuditQuerySchema.parse(req.query);

    const conditions = buildAuditConditions(tenantId, {
      action,
      entityType,
      entityId,
      userId,
      dateFrom,
      dateTo,
    });

    const [totalResult] = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(schema.auditLog)
      .where(and(...conditions));

    const byAction = await db
      .select({
        action: schema.auditLog.action,
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(schema.auditLog)
      .where(and(...conditions))
      .groupBy(schema.auditLog.action)
      .orderBy(asc(schema.auditLog.action));

    const byEntityType = await db
      .select({
        entityType: schema.auditLog.entityType,
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(schema.auditLog)
      .where(and(...conditions))
      .groupBy(schema.auditLog.entityType)
      .orderBy(asc(schema.auditLog.entityType));

    const timeBucketExpr =
      granularity === 'week'
        ? sql`date_trunc('week', ${schema.auditLog.timestamp})`
        : sql`date_trunc('day', ${schema.auditLog.timestamp})`;

    const timeLabelExpr =
      granularity === 'week'
        ? sql<string>`to_char(${timeBucketExpr}, 'IYYY-"W"IW')`
        : sql<string>`to_char(${timeBucketExpr}, 'YYYY-MM-DD')`;

    const byTimeBucket = await db
      .select({
        bucket: timeLabelExpr,
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(schema.auditLog)
      .where(and(...conditions))
      .groupBy(timeBucketExpr)
      .orderBy(asc(timeBucketExpr));

    const statusExpr = sql<string>`COALESCE(${schema.auditLog.newState} ->> 'status', 'unknown')`;
    const statusChangeConditions = [
      ...conditions,
      sql`${schema.auditLog.action} LIKE ${'%status_changed'}`,
    ];

    const statusTransitionRows = await db
      .select({
        status: statusExpr,
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(schema.auditLog)
      .where(and(...statusChangeConditions))
      .groupBy(statusExpr)
      .orderBy(asc(statusExpr));

    const topActions = [...byAction]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const statusTransitionFunnel = [...statusTransitionRows].sort((a, b) => b.count - a.count);

    const summaryEnd = dateTo ? new Date(dateTo) : new Date();
    const currentWindowStart = new Date(summaryEnd);
    currentWindowStart.setUTCDate(currentWindowStart.getUTCDate() - 7);
    const previousWindowStart = new Date(currentWindowStart);
    previousWindowStart.setUTCDate(previousWindowStart.getUTCDate() - 7);

    const currentWindowConditions = [
      ...conditions,
      sql`${schema.auditLog.timestamp} > ${currentWindowStart}`,
      sql`${schema.auditLog.timestamp} <= ${summaryEnd}`,
    ];
    const previousWindowConditions = [
      ...conditions,
      sql`${schema.auditLog.timestamp} > ${previousWindowStart}`,
      sql`${schema.auditLog.timestamp} <= ${currentWindowStart}`,
    ];

    const currentWindowByAction = await db
      .select({
        action: schema.auditLog.action,
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(schema.auditLog)
      .where(and(...currentWindowConditions))
      .groupBy(schema.auditLog.action);

    const previousWindowByAction = await db
      .select({
        action: schema.auditLog.action,
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(schema.auditLog)
      .where(and(...previousWindowConditions))
      .groupBy(schema.auditLog.action);

    const currentCounts = new Map(currentWindowByAction.map((row) => [row.action, row.count]));
    const previousCounts = new Map(previousWindowByAction.map((row) => [row.action, row.count]));
    const actionKeys = new Set([...currentCounts.keys(), ...previousCounts.keys()]);

    const recentAnomalies = Array.from(actionKeys)
      .map((actionName) => {
        const currentCount = currentCounts.get(actionName) ?? 0;
        const previousCount = previousCounts.get(actionName) ?? 0;
        const delta = currentCount - previousCount;

        if (delta <= 0) return null;

        const percentChange =
          previousCount === 0 ? null : Math.round((delta / previousCount) * 100);
        const spikeFromZero = previousCount === 0 && currentCount >= 5;
        const acceleratedGrowth =
          previousCount > 0 && delta >= 3 && delta / previousCount >= 0.5;

        if (!spikeFromZero && !acceleratedGrowth) {
          return null;
        }

        const severity: 'high' | 'medium' =
          previousCount === 0 || (percentChange !== null && percentChange >= 200)
            ? 'high'
            : 'medium';

        return {
          action: actionName,
          currentCount,
          previousCount,
          delta,
          percentChange,
          severity,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.delta - a.delta || b.currentCount - a.currentCount)
      .slice(0, 5);

    res.json({
      data: {
        total: totalResult?.count ?? 0,
        byAction,
        byEntityType,
        byTimeBucket,
        topActions,
        statusTransitionFunnel,
        recentAnomalies,
      },
      filters: {
        action,
        entityType,
        entityId,
        userId,
        dateFrom,
        dateTo,
        granularity,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});
