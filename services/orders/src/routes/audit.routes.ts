import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

export const auditRouter = Router();

// ─── Validation Schemas ──────────────────────────────────────────────

const baseAuditFilterSchema = z.object({
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  actorName: z.string().max(200).optional(),
  entityName: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .default('false'),
});

const listAuditQuerySchema = baseAuditFilterSchema.extend({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const summaryAuditQuerySchema = baseAuditFilterSchema.extend({
  granularity: z.enum(['day', 'week']).default('day'),
});

const entityHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .default('false'),
});

type AuditFilters = z.infer<typeof baseAuditFilterSchema>;

// ─── Query Helpers ───────────────────────────────────────────────────

function buildAuditConditions(tenantId: string, filters: AuditFilters) {
  const conditions: ReturnType<typeof eq>[] = [eq(schema.auditLog.tenantId, tenantId)];

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
  if (filters.actorName) {
    // LEFT JOIN with users is handled at the query level; this adds the ILIKE condition.
    // The join attaches actor_name as: first_name || ' ' || last_name
    conditions.push(
      sql`(${schema.users.firstName} || ' ' || ${schema.users.lastName}) ILIKE ${'%' + filters.actorName + '%'}`
    );
  }
  if (filters.entityName) {
    // Search across JSONB metadata text representation for entity name fields
    conditions.push(
      sql`CAST(${schema.auditLog.metadata} AS TEXT) ILIKE ${'%' + filters.entityName + '%'}`
    );
  }
  if (filters.search) {
    // General text search across action, entity_type, and metadata
    const term = '%' + filters.search + '%';
    conditions.push(
      sql`(
        ${schema.auditLog.action} ILIKE ${term}
        OR ${schema.auditLog.entityType} ILIKE ${term}
        OR CAST(${schema.auditLog.metadata} AS TEXT) ILIKE ${term}
      )`
    );
  }

  return conditions;
}

/**
 * Whether any filter requires a LEFT JOIN with auth.users.
 */
function needsUserJoin(filters: AuditFilters): boolean {
  return !!filters.actorName;
}

// ─── GET / — Paginated audit list with advanced filters ──────────────

auditRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const parsed = listAuditQuerySchema.parse(req.query);
    const { page, limit, includeArchived, ...filterFields } = parsed;
    const offset = (page - 1) * limit;
    const filters: AuditFilters = { ...filterFields, includeArchived };
    const conditions = buildAuditConditions(tenantId, filters);
    const joinUsers = needsUserJoin(filters);

    if (includeArchived) {
      // Use raw SQL UNION ALL to combine live + archive data
      const { rows, total } = await queryWithArchiveUnion(tenantId, filters, conditions, joinUsers, limit, offset);
      res.json({
        data: rows,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
      return;
    }

    // Standard Drizzle query (no UNION needed)
    let countResult: { count: number } | undefined;
    let rows: unknown[];

    if (joinUsers) {
      // actorName filter requires LEFT JOIN with auth.users
      [countResult] = await (db
        .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
        .from(schema.auditLog)
        .leftJoin(schema.users, eq(schema.auditLog.userId, schema.users.id))
        .where(and(...conditions)) as any);

      const rawRows = await db
        .select()
        .from(schema.auditLog)
        .leftJoin(schema.users, eq(schema.auditLog.userId, schema.users.id))
        .where(and(...conditions))
        .orderBy(desc(schema.auditLog.timestamp))
        .limit(limit)
        .offset(offset);

      // Drizzle returns { audit_log: {...}, users: {...} } shape; flatten to audit row.
      rows = rawRows.map((r) => r.audit_log);
    } else {
      [countResult] = await db
        .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
        .from(schema.auditLog)
        .where(and(...conditions));

      rows = await db
        .select()
        .from(schema.auditLog)
        .where(and(...conditions))
        .orderBy(desc(schema.auditLog.timestamp))
        .limit(limit)
        .offset(offset);
    }

    const total = countResult?.count ?? 0;
    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── GET /summary — Unchanged response contract ─────────────────────

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
      includeArchived: false,
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

// ─── GET /actions — Tenant-scoped distinct action values ─────────────

auditRouter.get('/actions', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const rows = await db
      .selectDistinct({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.tenantId, tenantId))
      .orderBy(asc(schema.auditLog.action));

    res.json({ data: rows.map((r) => r.action) });
  } catch (error) {
    next(error);
  }
});

// ─── GET /entity-types — Tenant-scoped distinct entity types ─────────

auditRouter.get('/entity-types', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const rows = await db
      .selectDistinct({ entityType: schema.auditLog.entityType })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.tenantId, tenantId))
      .orderBy(asc(schema.auditLog.entityType));

    res.json({ data: rows.map((r) => r.entityType) });
  } catch (error) {
    next(error);
  }
});

// ─── GET /entity/:entityType/:entityId — Entity history ──────────────

auditRouter.get('/entity/:entityType/:entityId', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const entityType = req.params.entityType as string;
    const entityId = req.params.entityId as string;

    // Validate entityId is a UUID
    const uuidSchema = z.string().uuid();
    const parseResult = uuidSchema.safeParse(entityId);
    if (!parseResult.success) {
      throw new AppError(400, 'Invalid entity ID format');
    }

    const { page, limit, includeArchived } = entityHistoryQuerySchema.parse(req.query);
    const offset = (page - 1) * limit;

    if (includeArchived) {
      const { rows, total } = await queryEntityHistoryWithArchive(
        tenantId, entityType, entityId, limit, offset
      );
      res.json({
        data: rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
      return;
    }

    const conditions = [
      eq(schema.auditLog.tenantId, tenantId),
      eq(schema.auditLog.entityType, entityType),
      eq(schema.auditLog.entityId, entityId),
    ];

    const [countResult] = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(schema.auditLog)
      .where(and(...conditions));

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(...conditions))
      .orderBy(asc(schema.auditLog.timestamp))
      .limit(limit)
      .offset(offset);

    const total = countResult?.count ?? 0;
    res.json({
      data: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── Archive UNION Helpers ───────────────────────────────────────────

/**
 * Build a WHERE clause fragment for raw SQL queries against audit tables.
 * Returns [sqlFragment, params] for use in parameterized queries.
 */
function buildRawWhereClause(
  tenantId: string,
  filters: AuditFilters,
  tableAlias: string,
): { fragment: string; params: unknown[] } {
  const clauses: string[] = [`${tableAlias}.tenant_id = $1`];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (filters.action) {
    clauses.push(`${tableAlias}.action = $${idx}`);
    params.push(filters.action);
    idx++;
  }
  if (filters.entityType) {
    clauses.push(`${tableAlias}.entity_type = $${idx}`);
    params.push(filters.entityType);
    idx++;
  }
  if (filters.entityId) {
    clauses.push(`${tableAlias}.entity_id = $${idx}`);
    params.push(filters.entityId);
    idx++;
  }
  if (filters.userId) {
    clauses.push(`${tableAlias}.user_id = $${idx}`);
    params.push(filters.userId);
    idx++;
  }
  if (filters.dateFrom) {
    clauses.push(`${tableAlias}."timestamp" >= $${idx}`);
    params.push(new Date(filters.dateFrom));
    idx++;
  }
  if (filters.dateTo) {
    clauses.push(`${tableAlias}."timestamp" <= $${idx}`);
    params.push(new Date(filters.dateTo));
    idx++;
  }
  if (filters.entityName) {
    clauses.push(`CAST(${tableAlias}.metadata AS TEXT) ILIKE $${idx}`);
    params.push('%' + filters.entityName + '%');
    idx++;
  }
  if (filters.actorName) {
    clauses.push(
      `(u.first_name || ' ' || u.last_name) ILIKE $${idx}`
    );
    params.push('%' + filters.actorName + '%');
    idx++;
  }
  if (filters.search) {
    clauses.push(
      `(${tableAlias}.action ILIKE $${idx} OR ${tableAlias}.entity_type ILIKE $${idx} OR CAST(${tableAlias}.metadata AS TEXT) ILIKE $${idx})`
    );
    params.push('%' + filters.search + '%');
    idx++;
  }

  return { fragment: clauses.join(' AND '), params };
}

/**
 * Whether the raw SQL query needs a LEFT JOIN with auth.users.
 */
function needsRawUserJoin(filters: AuditFilters): boolean {
  return !!filters.actorName;
}

/**
 * UNION ALL query combining audit_log + audit_log_archive with pagination.
 * When actorName is supplied, both live and archive legs LEFT JOIN auth.users
 * so the filter is applied consistently.
 */
async function queryWithArchiveUnion(
  tenantId: string,
  filters: AuditFilters,
  _conditions: ReturnType<typeof eq>[],
  _joinUsers: boolean,
  limit: number,
  offset: number,
): Promise<{ rows: unknown[]; total: number }> {
  const { fragment: liveWhere, params: liveParams } = buildRawWhereClause(tenantId, filters, 'a');
  const { fragment: archiveWhere, params: archiveParams } = buildRawWhereClause(
    tenantId, filters, 'a'
  );

  // Build parameterized UNION query. Archive params are offset by live param count.
  const archiveOffset = liveParams.length;
  const reindexedArchiveWhere = archiveWhere.replace(
    /\$(\d+)/g,
    (_, n) => `$${parseInt(n) + archiveOffset}`
  );

  const allParams = [...liveParams, ...archiveParams];
  const limitIdx = allParams.length + 1;
  const offsetIdx = allParams.length + 2;
  allParams.push(limit, offset);

  // When actorName filter is active, both legs need a LEFT JOIN with auth.users
  const userJoin = needsRawUserJoin(filters)
    ? 'LEFT JOIN auth.users u ON a.user_id = u.id'
    : '';

  const countSql = `
    SELECT CAST(COUNT(*) AS INTEGER) AS count FROM (
      SELECT a.id FROM audit.audit_log a ${userJoin} WHERE ${liveWhere}
      UNION ALL
      SELECT a.id FROM audit.audit_log_archive a ${userJoin} WHERE ${reindexedArchiveWhere}
    ) combined
  `;

  const dataSql = `
    SELECT * FROM (
      SELECT a.* FROM audit.audit_log a ${userJoin} WHERE ${liveWhere}
      UNION ALL
      SELECT a.* FROM audit.audit_log_archive a ${userJoin} WHERE ${reindexedArchiveWhere}
    ) combined
    ORDER BY "timestamp" DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const [countRows, dataRows] = await Promise.all([
    db.execute(sql.raw(buildParameterizedQuery(countSql, allParams))),
    db.execute(sql.raw(buildParameterizedQuery(dataSql, allParams))),
  ]);

  const total = (countRows as any)[0]?.count ?? 0;
  return { rows: dataRows as unknown[], total };
}

/**
 * Entity history query with UNION ALL against archive table.
 */
async function queryEntityHistoryWithArchive(
  tenantId: string,
  entityType: string,
  entityId: string,
  limit: number,
  offset: number,
): Promise<{ rows: unknown[]; total: number }> {
  const filters: AuditFilters = { entityType, entityId, includeArchived: true };
  const { fragment: liveWhere, params: liveParams } = buildRawWhereClause(tenantId, filters, 'a');
  const { fragment: archiveWhere, params: archiveParams } = buildRawWhereClause(tenantId, filters, 'a');

  const archiveOffset = liveParams.length;
  const reindexedArchiveWhere = archiveWhere.replace(
    /\$(\d+)/g,
    (_, n) => `$${parseInt(n) + archiveOffset}`
  );

  const allParams = [...liveParams, ...archiveParams];
  const limitIdx = allParams.length + 1;
  const offsetIdx = allParams.length + 2;
  allParams.push(limit, offset);

  const countSql = `
    SELECT CAST(COUNT(*) AS INTEGER) AS count FROM (
      SELECT a.id FROM audit.audit_log a WHERE ${liveWhere}
      UNION ALL
      SELECT a.id FROM audit.audit_log_archive a WHERE ${reindexedArchiveWhere}
    ) combined
  `;

  const dataSql = `
    SELECT * FROM (
      SELECT a.* FROM audit.audit_log a WHERE ${liveWhere}
      UNION ALL
      SELECT a.* FROM audit.audit_log_archive a WHERE ${reindexedArchiveWhere}
    ) combined
    ORDER BY "timestamp" ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const [countRows, dataRows] = await Promise.all([
    db.execute(sql.raw(buildParameterizedQuery(countSql, allParams))),
    db.execute(sql.raw(buildParameterizedQuery(dataSql, allParams))),
  ]);

  const total = (countRows as any)[0]?.count ?? 0;
  return { rows: dataRows as unknown[], total };
}

/**
 * Convert a parameterized SQL string ($1, $2, ...) into a raw SQL string
 * with properly escaped literal values. This is needed because Drizzle's
 * sql.raw() does not support parameterized queries.
 *
 * SECURITY: All values are SQL-escaped. Strings use single-quote escaping,
 * Dates use ISO format, numbers are validated.
 */
function buildParameterizedQuery(query: string, params: unknown[]): string {
  return query.replace(/\$(\d+)/g, (_, n) => {
    const val = params[parseInt(n) - 1];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return String(val);
    if (val instanceof Date) return `'${val.toISOString()}'`;
    // Escape single quotes in string values
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}
