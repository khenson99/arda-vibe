import { Router } from 'express';
import { z } from 'zod';
import { eq, and, gte, lte, lt, sql, desc } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import { requireRole, type AuthRequest, type AuditContext } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

const { demandSignals } = schema;

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

// ─── Validation Schemas ─────────────────────────────────────────────

const signalTypeValues = [
  'sales_order',
  'forecast',
  'reorder_point',
  'safety_stock',
  'seasonal',
  'manual',
] as const;

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
  partId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional(),
  signalType: z.enum(signalTypeValues).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  unfulfilled: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sortBy: z.enum(['demandDate', 'createdAt', 'quantityDemanded']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const createSignalSchema = z.object({
  partId: z.string().uuid(),
  facilityId: z.string().uuid(),
  signalType: z.enum(signalTypeValues),
  quantityDemanded: z.number().int().min(1),
  demandDate: z.string().datetime(),
  salesOrderId: z.string().uuid().optional(),
  salesOrderLineId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSignalSchema = z.object({
  quantityFulfilled: z.number().int().min(0).optional(),
  triggeredKanbanCardId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const summaryQuerySchema = z.object({
  facilityId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  signalType: z.enum(signalTypeValues).optional(),
});

const analyticsRangeQuerySchema = z.object({
  rangeDays: z.enum(['7', '30', '90']).default('30').transform((v) => Number(v)),
  signalType: z.enum(signalTypeValues).optional(),
  partId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional(),
});

const analyticsTopProductsQuerySchema = analyticsRangeQuerySchema.extend({
  limit: z.coerce.number().min(1).max(50).default(10),
});

const analyticsTrendsQuerySchema = analyticsRangeQuerySchema.extend({
  granularity: z.enum(['daily', 'weekly']).default('daily'),
});

function computeWindow(rangeDays: number) {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - rangeDays * 86_400_000);
  return { startDate, endDate };
}

// ─── RBAC ────────────────────────────────────────────────────────────
// inventory_manager, purchasing_manager, production_manager, salesperson, ecommerce_director
// (tenant_admin is implicitly allowed by requireRole)
const canRead = requireRole('inventory_manager', 'purchasing_manager', 'production_manager', 'salesperson', 'ecommerce_director');
const canWrite = requireRole('inventory_manager', 'purchasing_manager', 'salesperson');
const canDirectorRead = requireRole('ecommerce_director');

export const demandSignalsRouter = Router();

// ─── GET / — List demand signals ────────────────────────────────────
demandSignalsRouter.get('/', canRead, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const query = listQuerySchema.parse(req.query);
    const { page, pageSize, sortBy, sortOrder } = query;

    const conditions = [eq(demandSignals.tenantId, tenantId)];

    if (query.partId) {
      conditions.push(eq(demandSignals.partId, query.partId));
    }
    if (query.facilityId) {
      conditions.push(eq(demandSignals.facilityId, query.facilityId));
    }
    if (query.signalType) {
      conditions.push(eq(demandSignals.signalType, query.signalType));
    }
    if (query.dateFrom) {
      conditions.push(gte(demandSignals.demandDate, new Date(query.dateFrom)));
    }
    if (query.dateTo) {
      conditions.push(lte(demandSignals.demandDate, new Date(query.dateTo)));
    }
    if (query.unfulfilled) {
      conditions.push(sql`${demandSignals.quantityFulfilled} < ${demandSignals.quantityDemanded}`);
    }

    const whereClause = and(...conditions);

    const sortColumn =
      sortBy === 'demandDate'
        ? demandSignals.demandDate
        : sortBy === 'quantityDemanded'
          ? demandSignals.quantityDemanded
          : demandSignals.createdAt;

    const orderFn = sortOrder === 'asc' ? sql`${sortColumn} ASC` : desc(sortColumn);

    const [countResult, data] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(demandSignals)
        .where(whereClause),
      db
        .select()
        .from(demandSignals)
        .where(whereClause)
        .orderBy(orderFn)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    const totalCount = countResult[0]?.count ?? 0;

    res.json({
      data,
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /summary — Demand aggregation by part ──────────────────────
demandSignalsRouter.get('/summary', canRead, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const query = summaryQuerySchema.parse(req.query);

    const conditions = [eq(demandSignals.tenantId, tenantId)];

    if (query.facilityId) {
      conditions.push(eq(demandSignals.facilityId, query.facilityId));
    }
    if (query.signalType) {
      conditions.push(eq(demandSignals.signalType, query.signalType));
    }
    if (query.dateFrom) {
      conditions.push(gte(demandSignals.demandDate, new Date(query.dateFrom)));
    }
    if (query.dateTo) {
      conditions.push(lte(demandSignals.demandDate, new Date(query.dateTo)));
    }

    const whereClause = and(...conditions);

    const summary = await db
      .select({
        partId: demandSignals.partId,
        facilityId: demandSignals.facilityId,
        signalType: demandSignals.signalType,
        totalDemanded: sql<number>`sum(${demandSignals.quantityDemanded})`,
        totalFulfilled: sql<number>`sum(${demandSignals.quantityFulfilled})`,
        signalCount: sql<number>`count(*)`,
        unfulfilledCount: sql<number>`count(*) FILTER (WHERE ${demandSignals.quantityFulfilled} < ${demandSignals.quantityDemanded})`,
        earliestDemandDate: sql<string>`min(${demandSignals.demandDate})`,
        latestDemandDate: sql<string>`max(${demandSignals.demandDate})`,
      })
      .from(demandSignals)
      .where(whereClause)
      .groupBy(demandSignals.partId, demandSignals.facilityId, demandSignals.signalType)
      .orderBy(sql`sum(${demandSignals.quantityDemanded}) DESC`);

    res.json({ data: summary });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /analytics/signals — Director demand aggregation ───────────
demandSignalsRouter.get('/analytics/signals', canDirectorRead, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { rangeDays } = query;
    const { startDate, endDate } = computeWindow(rangeDays);

    const conditions = [
      eq(demandSignals.tenantId, tenantId),
      gte(demandSignals.demandDate, startDate),
      lte(demandSignals.demandDate, endDate),
    ];

    if (query.signalType) {
      conditions.push(eq(demandSignals.signalType, query.signalType));
    }
    if (query.partId) {
      conditions.push(eq(demandSignals.partId, query.partId));
    }
    if (query.facilityId) {
      conditions.push(eq(demandSignals.facilityId, query.facilityId));
    }

    const whereClause = and(...conditions);

    const data = await db
      .select({
        partId: demandSignals.partId,
        signalType: demandSignals.signalType,
        totalDemanded: sql<number>`sum(${demandSignals.quantityDemanded})`,
        totalFulfilled: sql<number>`sum(${demandSignals.quantityFulfilled})`,
        unfulfilledQuantity: sql<number>`sum(${demandSignals.quantityDemanded} - ${demandSignals.quantityFulfilled})`,
        signalCount: sql<number>`count(*)`,
      })
      .from(demandSignals)
      .where(whereClause)
      .groupBy(demandSignals.partId, demandSignals.signalType)
      .orderBy(sql`sum(${demandSignals.quantityDemanded}) DESC`);

    res.json({
      data,
      meta: {
        rangeDays,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /analytics/top-products — Director top demand products ─────
demandSignalsRouter.get('/analytics/top-products', canDirectorRead, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const query = analyticsTopProductsQuerySchema.parse(req.query);
    const { rangeDays, limit } = query;
    const { startDate, endDate } = computeWindow(rangeDays);
    const previousStartDate = new Date(startDate.getTime() - rangeDays * 86_400_000);

    const currentConditions = [
      eq(demandSignals.tenantId, tenantId),
      gte(demandSignals.demandDate, startDate),
      lte(demandSignals.demandDate, endDate),
    ];
    const previousConditions = [
      eq(demandSignals.tenantId, tenantId),
      gte(demandSignals.demandDate, previousStartDate),
      lt(demandSignals.demandDate, startDate),
    ];

    if (query.signalType) {
      currentConditions.push(eq(demandSignals.signalType, query.signalType));
      previousConditions.push(eq(demandSignals.signalType, query.signalType));
    }
    if (query.partId) {
      currentConditions.push(eq(demandSignals.partId, query.partId));
      previousConditions.push(eq(demandSignals.partId, query.partId));
    }
    if (query.facilityId) {
      currentConditions.push(eq(demandSignals.facilityId, query.facilityId));
      previousConditions.push(eq(demandSignals.facilityId, query.facilityId));
    }

    const [currentRows, previousRows] = await Promise.all([
      db
        .select({
          partId: demandSignals.partId,
          totalDemanded: sql<number>`sum(${demandSignals.quantityDemanded})`,
          signalCount: sql<number>`count(*)`,
        })
        .from(demandSignals)
        .where(and(...currentConditions))
        .groupBy(demandSignals.partId)
        .orderBy(sql`sum(${demandSignals.quantityDemanded}) DESC`),
      db
        .select({
          partId: demandSignals.partId,
          totalDemanded: sql<number>`sum(${demandSignals.quantityDemanded})`,
        })
        .from(demandSignals)
        .where(and(...previousConditions))
        .groupBy(demandSignals.partId),
    ]);

    const previousByPart = new Map<string, number>(
      previousRows.map((row) => [row.partId, row.totalDemanded ?? 0]),
    );

    const data = currentRows
      .map((row) => {
        const previousDemanded = previousByPart.get(row.partId) ?? 0;
        const demandDelta = (row.totalDemanded ?? 0) - previousDemanded;
        const trendDirection = demandDelta > 0 ? 'up' : demandDelta < 0 ? 'down' : 'flat';
        const trendPercent =
          previousDemanded > 0
            ? Number(((demandDelta / previousDemanded) * 100).toFixed(2))
            : row.totalDemanded > 0
              ? 100
              : 0;

        return {
          partId: row.partId,
          totalDemanded: row.totalDemanded ?? 0,
          signalCount: row.signalCount ?? 0,
          previousDemanded,
          demandDelta,
          trendDirection,
          trendPercent,
        };
      })
      .sort((a, b) => b.totalDemanded - a.totalDemanded)
      .slice(0, limit);

    res.json({
      data,
      meta: {
        rangeDays,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /analytics/trends — Director demand time series ────────────
demandSignalsRouter.get('/analytics/trends', canDirectorRead, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const query = analyticsTrendsQuerySchema.parse(req.query);
    const { rangeDays, granularity } = query;
    const { startDate, endDate } = computeWindow(rangeDays);

    const conditions = [
      eq(demandSignals.tenantId, tenantId),
      gte(demandSignals.demandDate, startDate),
      lte(demandSignals.demandDate, endDate),
    ];

    if (query.signalType) {
      conditions.push(eq(demandSignals.signalType, query.signalType));
    }
    if (query.partId) {
      conditions.push(eq(demandSignals.partId, query.partId));
    }
    if (query.facilityId) {
      conditions.push(eq(demandSignals.facilityId, query.facilityId));
    }

    const bucketExpr =
      granularity === 'weekly'
        ? sql`date_trunc('week', ${demandSignals.demandDate})`
        : sql`date_trunc('day', ${demandSignals.demandDate})`;

    const data = await db
      .select({
        periodStart: sql<string>`${bucketExpr}::text`,
        totalDemanded: sql<number>`sum(${demandSignals.quantityDemanded})`,
        totalFulfilled: sql<number>`sum(${demandSignals.quantityFulfilled})`,
        signalCount: sql<number>`count(*)`,
      })
      .from(demandSignals)
      .where(and(...conditions))
      .groupBy(bucketExpr)
      .orderBy(bucketExpr);

    res.json({
      data,
      meta: {
        granularity,
        rangeDays,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /:id — Get single demand signal ────────────────────────────
demandSignalsRouter.get('/:id', canRead, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;

    const [signal] = await db
      .select()
      .from(demandSignals)
      .where(and(eq(demandSignals.id, id), eq(demandSignals.tenantId, tenantId)));

    if (!signal) {
      throw new AppError(404, 'Demand signal not found');
    }

    res.json({ data: signal });
  } catch (err) {
    next(err);
  }
});

// ─── POST / — Create demand signal (manual) ─────────────────────────
demandSignalsRouter.post('/', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);
    const body = createSignalSchema.parse(req.body);

    const [signal] = await db.transaction(async (tx) => {
      const result = await tx
        .insert(demandSignals)
        .values({
          tenantId,
          partId: body.partId,
          facilityId: body.facilityId,
          signalType: body.signalType,
          quantityDemanded: body.quantityDemanded,
          demandDate: new Date(body.demandDate),
          salesOrderId: body.salesOrderId ?? null,
          salesOrderLineId: body.salesOrderLineId ?? null,
          metadata: body.metadata ?? null,
        })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'demand_signal.created',
        entityType: 'demand_signal',
        entityId: result[0].id,
        previousState: null,
        newState: {
          signalType: body.signalType,
          partId: body.partId,
          facilityId: body.facilityId,
          quantityDemanded: body.quantityDemanded,
          demandDate: body.demandDate,
        },
        metadata: { source: 'demand_signals.create' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return result;
    });

    res.status(201).json({ data: signal });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /:id — Update demand signal ──────────────────────────────
demandSignalsRouter.patch('/:id', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const id = req.params.id as string;
    const auditContext = getRequestAuditContext(req);
    const body = updateSignalSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      throw new AppError(400, 'No fields to update');
    }

    const [existing] = await db
      .select()
      .from(demandSignals)
      .where(and(eq(demandSignals.id, id), eq(demandSignals.tenantId, tenantId)));

    if (!existing) {
      throw new AppError(404, 'Demand signal not found');
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};

    if (body.quantityFulfilled !== undefined) {
      previousState.quantityFulfilled = existing.quantityFulfilled;
      newState.quantityFulfilled = body.quantityFulfilled;
      updates.quantityFulfilled = body.quantityFulfilled;

      // Auto-set fulfilledAt when fully fulfilled
      if (body.quantityFulfilled >= existing.quantityDemanded && !existing.fulfilledAt) {
        updates.fulfilledAt = new Date();
        newState.fulfilledAt = (updates.fulfilledAt as Date).toISOString();
      }
    }

    if (body.triggeredKanbanCardId !== undefined) {
      previousState.triggeredKanbanCardId = existing.triggeredKanbanCardId;
      newState.triggeredKanbanCardId = body.triggeredKanbanCardId;
      updates.triggeredKanbanCardId = body.triggeredKanbanCardId;
    }

    if (body.metadata !== undefined) {
      previousState.metadata = existing.metadata;
      newState.metadata = body.metadata;
      updates.metadata = body.metadata;
    }

    const [updated] = await db.transaction(async (tx) => {
      const result = await tx
        .update(demandSignals)
        .set(updates)
        .where(and(eq(demandSignals.id, id), eq(demandSignals.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'demand_signal.updated',
        entityType: 'demand_signal',
        entityId: id,
        previousState,
        newState,
        metadata: { source: 'demand_signals.update' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return result;
    });

    res.json({ data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});
