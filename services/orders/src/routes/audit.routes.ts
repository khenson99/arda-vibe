import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { requireRole } from '@arda/auth-utils';
import { createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import {
  ASYNC_THRESHOLD,
  createExportJob,
  getExportJobStatus,
  getExportJobFile,
  processExportJob,
} from '../services/audit-export-job.service.js';
import type { ExportJobFilters } from '../services/audit-export-job.service.js';

const log = createLogger('audit-export-routes');

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

// ─── GET /integrity-check — Hash-chain verification (tenant_admin) ───

const GENESIS_SENTINEL = 'GENESIS';
const INTEGRITY_BATCH_SIZE = 500;

/**
 * Recompute the SHA-256 hash for an audit entry using the same canonical
 * format as writeAuditEntry in @arda/db. This ensures the integrity check
 * verifies against the exact same algorithm that produced the hashes.
 *
 * Format: tenant_id|sequence_number|action|entity_type|entity_id|timestamp|previous_hash
 */
function recomputeHash(entry: {
  tenantId: string;
  sequenceNumber: number;
  action: string;
  entityType: string;
  entityId: string | null;
  timestamp: Date;
  previousHash: string | null;
}): string {
  const prevHash = entry.previousHash ?? GENESIS_SENTINEL;
  const entityId = entry.entityId ?? '';
  const payload = [
    entry.tenantId,
    entry.sequenceNumber.toString(),
    entry.action,
    entry.entityType,
    entityId,
    entry.timestamp.toISOString(),
    prevHash,
  ].join('|');

  return createHash('sha256').update(payload).digest('hex');
}

interface IntegrityViolation {
  entryId: string;
  sequenceNumber: number;
  type: 'hash_mismatch' | 'chain_break' | 'sequence_gap' | 'pending_hash';
  expected?: string;
  actual?: string;
}

auditRouter.get('/integrity-check', requireRole('tenant_admin'), async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const violations: IntegrityViolation[] = [];
    let totalChecked = 0;
    let pendingCount = 0;
    let lastSequence = 0;
    let lastHash: string | null = null;
    let hasMore = true;
    let batchOffset = 0;

    while (hasMore) {
      const batch = await db
        .select({
          id: schema.auditLog.id,
          tenantId: schema.auditLog.tenantId,
          action: schema.auditLog.action,
          entityType: schema.auditLog.entityType,
          entityId: schema.auditLog.entityId,
          timestamp: schema.auditLog.timestamp,
          hashChain: schema.auditLog.hashChain,
          previousHash: schema.auditLog.previousHash,
          sequenceNumber: schema.auditLog.sequenceNumber,
        })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.tenantId, tenantId))
        .orderBy(asc(schema.auditLog.sequenceNumber))
        .limit(INTEGRITY_BATCH_SIZE)
        .offset(batchOffset);

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const entry of batch) {
        totalChecked++;

        // Skip 'PENDING' entries (legacy inserts before writeAuditEntry migration)
        if (entry.hashChain === 'PENDING') {
          pendingCount++;
          lastSequence = entry.sequenceNumber;
          lastHash = null; // Chain resets after PENDING entries
          continue;
        }

        // Check for sequence gaps
        if (lastSequence > 0 && entry.sequenceNumber !== lastSequence + 1) {
          violations.push({
            entryId: entry.id,
            sequenceNumber: entry.sequenceNumber,
            type: 'sequence_gap',
            expected: String(lastSequence + 1),
            actual: String(entry.sequenceNumber),
          });
        }

        // Verify chain link: entry.previousHash should match the last verified hash
        if (lastHash !== null && entry.previousHash !== lastHash) {
          violations.push({
            entryId: entry.id,
            sequenceNumber: entry.sequenceNumber,
            type: 'chain_break',
            expected: lastHash,
            actual: entry.previousHash ?? 'null',
          });
        }

        // Recompute and verify the hash
        const expected = recomputeHash({
          tenantId: entry.tenantId,
          sequenceNumber: entry.sequenceNumber,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          timestamp: entry.timestamp,
          previousHash: entry.previousHash,
        });

        if (entry.hashChain !== expected) {
          violations.push({
            entryId: entry.id,
            sequenceNumber: entry.sequenceNumber,
            type: 'hash_mismatch',
            expected,
            actual: entry.hashChain,
          });
        }

        lastSequence = entry.sequenceNumber;
        lastHash = entry.hashChain;
      }

      batchOffset += INTEGRITY_BATCH_SIZE;
      if (batch.length < INTEGRITY_BATCH_SIZE) {
        hasMore = false;
      }
    }

    res.json({
      data: {
        totalChecked,
        pendingCount,
        violationCount: violations.length,
        valid: violations.length === 0,
        violations: violations.slice(0, 100), // Cap violations to avoid huge responses
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /export — Audit log export (sync for small, async for large) ──

const exportRequestSchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  actorName: z.string().max(200).optional(),
  entityName: z.string().max(200).optional(),
  search: z.string().max(200).optional(),
  includeArchived: z.boolean().optional().default(false),
});

/**
 * Generate CSV from audit entries.
 */
function generateCsv(entries: Record<string, unknown>[]): string {
  if (entries.length === 0) return '';

  const headers = Object.keys(entries[0]);
  const headerLine = headers.join(',');
  const rows = entries.map((entry) =>
    headers
      .map((h) => {
        const val = entry[h];
        if (val === null || val === undefined) return '';
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(','),
  );
  return [headerLine, ...rows].join('\n');
}

/**
 * Generate JSON export from audit entries.
 */
function generateJsonExport(entries: unknown[]): string {
  return JSON.stringify({ entries, exportedAt: new Date().toISOString(), count: entries.length }, null, 2);
}

/**
 * Compute SHA-256 checksum of export data.
 */
function computeExportChecksum(data: string | Buffer): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? data : data)
    .digest('hex');
}

/**
 * Fetch audit entries using the shared filter logic.
 */
async function fetchAuditEntries(
  tenantId: string,
  filters: AuditFilters,
): Promise<unknown[]> {
  const conditions = buildAuditConditions(tenantId, filters);
  const joinUsers = needsUserJoin(filters);

  if (joinUsers) {
    const rawRows = await db
      .select()
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.auditLog.userId, schema.users.id))
      .where(and(...conditions))
      .orderBy(desc(schema.auditLog.timestamp));
    return rawRows.map((r) => r.audit_log);
  }

  return db
    .select()
    .from(schema.auditLog)
    .where(and(...conditions))
    .orderBy(desc(schema.auditLog.timestamp));
}

/**
 * Count audit entries matching the given filters (for threshold check).
 */
async function countAuditEntries(
  tenantId: string,
  filters: AuditFilters,
): Promise<number> {
  const conditions = buildAuditConditions(tenantId, filters);
  const joinUsers = needsUserJoin(filters);

  let countResult: { count: number } | undefined;

  if (joinUsers) {
    [countResult] = await (db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(schema.auditLog)
      .leftJoin(schema.users, eq(schema.auditLog.userId, schema.users.id))
      .where(and(...conditions)) as any);
  } else {
    [countResult] = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(schema.auditLog)
      .where(and(...conditions));
  }

  return countResult?.count ?? 0;
}

auditRouter.post('/export', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub;
    if (!tenantId || !userId) {
      throw new AppError(401, 'Unauthorized');
    }

    const parsed = exportRequestSchema.parse(req.body);
    const { format, includeArchived, ...filterFields } = parsed;

    const filters: AuditFilters = {
      ...filterFields,
      includeArchived,
    };

    // Count matching rows to determine sync vs async path
    const estimatedRows = await countAuditEntries(tenantId, filters);

    if (estimatedRows >= ASYNC_THRESHOLD) {
      // ── Async path: create job and return 202 ──────────────────
      const jobResult = createExportJob(
        tenantId,
        userId,
        format,
        filters as ExportJobFilters,
        estimatedRows,
      );

      log.info(
        { jobId: jobResult.jobId, tenantId, estimatedRows, format },
        'Async export job created',
      );

      // Kick off processing in background (fire-and-forget)
      const jobFilters = { ...filters };
      setImmediate(() => {
        processExportJob(
          jobResult.jobId,
          () => fetchAuditEntries(tenantId, jobFilters),
          async (entries) => {
            let data: string;
            if (format === 'csv') {
              data = generateCsv(entries as Record<string, unknown>[]);
            } else {
              data = generateJsonExport(entries);
            }
            const checksum = computeExportChecksum(data);
            return { data, checksum };
          },
        ).catch((err) => {
          log.error(
            { jobId: jobResult.jobId, error: (err as Error).message },
            'Background export processing error',
          );
        });
      });

      res.status(202).json(jobResult);
      return;
    }

    // ── Sync path: export immediately for smaller result sets ──────
    const entries = await fetchAuditEntries(tenantId, filters);

    let data: string;
    let contentType: string;
    let fileExtension: string;

    if (format === 'csv') {
      data = generateCsv(entries as Record<string, unknown>[]);
      contentType = 'text/csv';
      fileExtension = 'csv';
    } else {
      data = generateJsonExport(entries);
      contentType = 'application/json';
      fileExtension = 'json';
    }

    const checksum = computeExportChecksum(data);

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-export-${new Date().toISOString().slice(0, 10)}.${fileExtension}"`,
    );
    res.setHeader('X-Export-Checksum', checksum);
    res.setHeader('X-Export-Row-Count', String(entries.length));
    res.send(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid export parameters'));
    }
    next(error);
  }
});

// ─── GET /export/:jobId — Poll async export job status ───────────────

auditRouter.get('/export/:jobId', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const jobId = req.params.jobId as string;

    // Validate jobId is a UUID
    const uuidSchema = z.string().uuid();
    const parseResult = uuidSchema.safeParse(jobId);
    if (!parseResult.success) {
      throw new AppError(400, 'Invalid job ID format');
    }

    const status = getExportJobStatus(jobId, tenantId);

    if (!status) {
      throw new AppError(404, 'Export job not found');
    }

    res.json(status);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid parameters'));
    }
    next(error);
  }
});

// ─── GET /export/:jobId/download — Download completed export artifact ─

auditRouter.get('/export/:jobId/download', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const jobId = req.params.jobId as string;

    const uuidSchema = z.string().uuid();
    const parseResult = uuidSchema.safeParse(jobId);
    if (!parseResult.success) {
      throw new AppError(400, 'Invalid job ID format');
    }

    const fileInfo = getExportJobFile(jobId, tenantId);

    if (!fileInfo) {
      throw new AppError(404, 'Export file not found or not ready');
    }

    const contentTypes: Record<string, string> = {
      csv: 'text/csv',
      json: 'application/json',
      pdf: 'application/pdf',
    };

    res.setHeader('Content-Type', contentTypes[fileInfo.format] || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-export-${jobId}.${fileInfo.format}"`,
    );
    if (fileInfo.checksum) {
      res.setHeader('X-Export-Checksum', fileInfo.checksum);
    }

    const stream = createReadStream(fileInfo.filePath);
    stream.pipe(res);
  } catch (error) {
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
 * UNION ALL query combining audit_log + audit_log_archive with pagination.
 * actorName filter is not supported in archive UNION queries (archive has no
 * user join — actor names come from live data).
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

  // Archive uses the same base filters (excluding actorName which requires a JOIN)
  const archiveFilters = { ...filters, actorName: undefined };
  const { fragment: archiveWhere, params: archiveParams } = buildRawWhereClause(
    tenantId, archiveFilters, 'a'
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
