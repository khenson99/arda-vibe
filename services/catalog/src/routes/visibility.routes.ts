import { Router } from 'express';
import { z } from 'zod';
import { eq, and, ilike, sql, isNull, asc, desc } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest, AuditContext } from '@arda/auth-utils';
import { requireRole } from '@arda/auth-utils';
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

export const visibilityRouter = Router();
const { productVisibility, parts } = schema;

const canAccess = requireRole('ecommerce_director');

const VISIBILITY_STATES = ['visible', 'hidden', 'coming_soon', 'discontinued'] as const;

// ─── Validation ───────────────────────────────────────────────────────
const updateVisibilitySchema = z.object({
  visibilityState: z.enum(VISIBILITY_STATES).optional(),
  displayName: z.string().max(255).optional(),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  displayPrice: z.number().nonnegative().optional(),
  displayOrder: z.number().int().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const batchUpdateSchema = z.object({
  partIds: z.array(z.string().uuid()).min(1).max(100),
  visibilityState: z.enum(VISIBILITY_STATES),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
  visibilityState: z.enum(VISIBILITY_STATES).optional(),
  search: z.string().optional(),
  sortBy: z.enum(['displayOrder', 'displayName', 'updatedAt']).default('displayOrder'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

// ─── GET /visibility ──────────────────────────────────────────────────
visibilityRouter.get('/', canAccess, async (req: AuthRequest, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const tenantId = req.user!.tenantId;
    const offset = (query.page - 1) * query.pageSize;

    const conditions = [eq(productVisibility.tenantId, tenantId)];

    if (query.visibilityState) {
      conditions.push(eq(productVisibility.visibilityState, query.visibilityState));
    }

    if (query.search) {
      const escaped = escapeLike(query.search);
      conditions.push(
        sql`(${ilike(productVisibility.displayName, `%${escaped}%`)} OR ${ilike(parts.partNumber, `%${escaped}%`)} OR ${ilike(parts.name, `%${escaped}%`)})`
      );
    }

    const whereClause = and(...conditions);

    const orderColumn =
      query.sortBy === 'displayName' ? productVisibility.displayName
      : query.sortBy === 'updatedAt' ? productVisibility.updatedAt
      : productVisibility.displayOrder;
    const orderFn = query.sortOrder === 'desc' ? desc : asc;

    const [data, countResult] = await Promise.all([
      db
        .select({
          id: productVisibility.id,
          tenantId: productVisibility.tenantId,
          partId: productVisibility.partId,
          visibilityState: productVisibility.visibilityState,
          displayName: productVisibility.displayName,
          shortDescription: productVisibility.shortDescription,
          longDescription: productVisibility.longDescription,
          displayPrice: productVisibility.displayPrice,
          displayOrder: productVisibility.displayOrder,
          publishedAt: productVisibility.publishedAt,
          unpublishedAt: productVisibility.unpublishedAt,
          metadata: productVisibility.metadata,
          updatedByUserId: productVisibility.updatedByUserId,
          createdAt: productVisibility.createdAt,
          updatedAt: productVisibility.updatedAt,
          partNumber: parts.partNumber,
          partName: parts.name,
          imageUrl: parts.imageUrl,
          unitPrice: parts.unitPrice,
          isSellable: parts.isSellable,
          isActive: parts.isActive,
        })
        .from(productVisibility)
        .innerJoin(parts, eq(productVisibility.partId, parts.id))
        .where(whereClause)
        .orderBy(orderFn(orderColumn))
        .limit(query.pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(productVisibility)
        .innerJoin(parts, eq(productVisibility.partId, parts.id))
        .where(whereClause),
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

// ─── GET /visibility/health ───────────────────────────────────────────
visibilityRouter.get('/health', canAccess, async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;

    // Find sellable parts with issues
    const [missingImage, missingPrice, inactiveButSellable] = await Promise.all([
      // Sellable parts without an image
      db
        .select({
          partId: parts.id,
          partNumber: parts.partNumber,
          partName: parts.name,
        })
        .from(parts)
        .where(
          and(
            eq(parts.tenantId, tenantId),
            eq(parts.isSellable, true),
            eq(parts.isActive, true),
            isNull(parts.imageUrl)
          )
        ),

      // Sellable parts without a price
      db
        .select({
          partId: parts.id,
          partNumber: parts.partNumber,
          partName: parts.name,
        })
        .from(parts)
        .where(
          and(
            eq(parts.tenantId, tenantId),
            eq(parts.isSellable, true),
            eq(parts.isActive, true),
            isNull(parts.unitPrice)
          )
        ),

      // Inactive parts that are still marked sellable
      db
        .select({
          partId: parts.id,
          partNumber: parts.partNumber,
          partName: parts.name,
        })
        .from(parts)
        .where(
          and(
            eq(parts.tenantId, tenantId),
            eq(parts.isSellable, true),
            eq(parts.isActive, false)
          )
        ),
    ]);

    const totalIssues = missingImage.length + missingPrice.length + inactiveButSellable.length;

    res.json({
      healthy: totalIssues === 0,
      totalIssues,
      issues: {
        missingImage: { count: missingImage.length, parts: missingImage },
        missingPrice: { count: missingPrice.length, parts: missingPrice },
        inactiveButSellable: { count: inactiveButSellable.length, parts: inactiveButSellable },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /visibility/:partId ──────────────────────────────────────────
visibilityRouter.get('/:partId', canAccess, async (req: AuthRequest, res, next) => {
  try {
    const partId = req.params.partId as string;
    const tenantId = req.user!.tenantId;

    const [row] = await db
      .select({
        id: productVisibility.id,
        tenantId: productVisibility.tenantId,
        partId: productVisibility.partId,
        visibilityState: productVisibility.visibilityState,
        displayName: productVisibility.displayName,
        shortDescription: productVisibility.shortDescription,
        longDescription: productVisibility.longDescription,
        displayPrice: productVisibility.displayPrice,
        displayOrder: productVisibility.displayOrder,
        publishedAt: productVisibility.publishedAt,
        unpublishedAt: productVisibility.unpublishedAt,
        metadata: productVisibility.metadata,
        updatedByUserId: productVisibility.updatedByUserId,
        createdAt: productVisibility.createdAt,
        updatedAt: productVisibility.updatedAt,
        partNumber: parts.partNumber,
        partName: parts.name,
        imageUrl: parts.imageUrl,
        unitPrice: parts.unitPrice,
        isSellable: parts.isSellable,
      })
      .from(productVisibility)
      .innerJoin(parts, eq(productVisibility.partId, parts.id))
      .where(
        and(
          eq(productVisibility.tenantId, tenantId),
          eq(productVisibility.partId, partId)
        )
      );

    if (!row) {
      throw new AppError(404, 'Visibility record not found for this part');
    }

    res.json(row);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /visibility/:partId ────────────────────────────────────────
visibilityRouter.patch('/:partId', canAccess, async (req: AuthRequest, res, next) => {
  try {
    const partId = req.params.partId as string;
    const tenantId = req.user!.tenantId;
    const input = updateVisibilitySchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);

    if (Object.keys(input).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    const updated = await db.transaction(async (tx) => {
      // Fetch existing record
      const [existing] = await tx
        .select()
        .from(productVisibility)
        .where(
          and(
            eq(productVisibility.tenantId, tenantId),
            eq(productVisibility.partId, partId)
          )
        );

      if (!existing) {
        throw new AppError(404, 'Visibility record not found for this part');
      }

      // Build update payload
      const now = new Date();
      const updateData: Record<string, unknown> = {
        ...input,
        updatedByUserId: req.user!.sub,
        updatedAt: now,
      };

      // Handle displayPrice conversion to string for numeric column
      if (input.displayPrice !== undefined) {
        updateData.displayPrice = String(input.displayPrice);
      }

      // Set publishedAt when first transitioning to 'visible'
      if (input.visibilityState === 'visible' && !existing.publishedAt) {
        updateData.publishedAt = now;
      }

      // Set unpublishedAt when transitioning away from 'visible'
      if (
        input.visibilityState &&
        input.visibilityState !== 'visible' &&
        existing.visibilityState === 'visible'
      ) {
        updateData.unpublishedAt = now;
      }

      const [row] = await tx
        .update(productVisibility)
        .set(updateData)
        .where(
          and(
            eq(productVisibility.tenantId, tenantId),
            eq(productVisibility.partId, partId)
          )
        )
        .returning();

      // Build field-level diff for audit
      const previousState: Record<string, unknown> = {};
      const newState: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        previousState[key] = (existing as Record<string, unknown>)[key];
        newState[key] = (input as Record<string, unknown>)[key];
      }

      await writeAuditEntry(tx, {
        tenantId,
        userId: req.user!.sub,
        action: 'product_visibility.updated',
        entityType: 'product_visibility',
        entityId: row.id,
        previousState,
        newState,
        metadata: { partId, partNumber: row.displayName },
        ...auditContext,
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

// ─── POST /visibility/batch ───────────────────────────────────────────
visibilityRouter.post('/batch', canAccess, async (req: AuthRequest, res, next) => {
  try {
    const { partIds, visibilityState } = batchUpdateSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);
    const now = new Date();

    const results = await db.transaction(async (tx) => {
      const updated: Array<Record<string, unknown>> = [];

      for (const partId of partIds) {
        // Fetch existing
        const [existing] = await tx
          .select()
          .from(productVisibility)
          .where(
            and(
              eq(productVisibility.tenantId, tenantId),
              eq(productVisibility.partId, partId)
            )
          );

        if (!existing) {
          // Skip parts that don't have visibility records
          continue;
        }

        if (existing.visibilityState === visibilityState) {
          // No change needed
          updated.push(existing);
          continue;
        }

        const updateData: Record<string, unknown> = {
          visibilityState,
          updatedByUserId: req.user!.sub,
          updatedAt: now,
        };

        // Set publishedAt when first transitioning to 'visible'
        if (visibilityState === 'visible' && !existing.publishedAt) {
          updateData.publishedAt = now;
        }

        // Set unpublishedAt when transitioning away from 'visible'
        if (visibilityState !== 'visible' && existing.visibilityState === 'visible') {
          updateData.unpublishedAt = now;
        }

        const [row] = await tx
          .update(productVisibility)
          .set(updateData)
          .where(
            and(
              eq(productVisibility.tenantId, tenantId),
              eq(productVisibility.partId, partId)
            )
          )
          .returning();

        await writeAuditEntry(tx, {
          tenantId,
          userId: req.user!.sub,
          action: 'product_visibility.updated',
          entityType: 'product_visibility',
          entityId: row.id,
          previousState: { visibilityState: existing.visibilityState },
          newState: { visibilityState },
          metadata: { partId, batchUpdate: true },
          ...auditContext,
        });

        updated.push(row);
      }

      return updated;
    });

    res.json({
      updated: results.length,
      data: results,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});
