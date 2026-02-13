import { Router } from 'express';
import { z } from 'zod';
import { db, schema } from '@arda/db';
import { eq, and, desc, sql, gte, lte } from 'drizzle-orm';
import { createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';

const log = createLogger('deliveries');

export const deliveriesRouter = Router();

// ─── Query Validation ─────────────────────────────────────────────────
const listDeliveriesQuerySchema = z.object({
  notificationId: z.string().optional(),
  userId: z.string().optional(),
  channel: z.enum(['in_app', 'email', 'webhook']).optional(),
  status: z.enum(['pending', 'sent', 'delivered', 'failed', 'bounced']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// ─── GET /deliveries — List delivery records with filters + RBAC ──────
deliveriesRouter.get('/deliveries', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;
    const role = req.user!.role;
    const isAdmin = role === 'tenant_admin';

    const query = listDeliveriesQuerySchema.parse(req.query);

    // Build filter conditions — always enforce tenant isolation
    const conditions = [
      eq(schema.notificationDeliveries.tenantId, tenantId),
    ];

    // RBAC: regular users can only see their own deliveries
    if (!isAdmin) {
      conditions.push(eq(schema.notificationDeliveries.userId, userId));
    } else if (query.userId) {
      // Admin can filter by specific user
      conditions.push(eq(schema.notificationDeliveries.userId, query.userId));
    }

    if (query.notificationId) {
      conditions.push(eq(schema.notificationDeliveries.notificationId, query.notificationId));
    }

    if (query.channel) {
      conditions.push(eq(schema.notificationDeliveries.channel, query.channel));
    }

    if (query.status) {
      conditions.push(eq(schema.notificationDeliveries.status, query.status));
    }

    if (query.from) {
      conditions.push(gte(schema.notificationDeliveries.createdAt, new Date(query.from)));
    }

    if (query.to) {
      conditions.push(lte(schema.notificationDeliveries.createdAt, new Date(query.to)));
    }

    // Count total matching records
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.notificationDeliveries)
      .where(and(...conditions));

    const total = Number(countResult[0]?.count ?? 0);

    // Paginated results
    const offset = (query.page - 1) * query.pageSize;
    const deliveries = await db
      .select({
        id: schema.notificationDeliveries.id,
        notificationId: schema.notificationDeliveries.notificationId,
        userId: schema.notificationDeliveries.userId,
        channel: schema.notificationDeliveries.channel,
        status: schema.notificationDeliveries.status,
        provider: schema.notificationDeliveries.provider,
        providerMessageId: schema.notificationDeliveries.providerMessageId,
        attemptCount: schema.notificationDeliveries.attemptCount,
        lastAttemptAt: schema.notificationDeliveries.lastAttemptAt,
        lastError: schema.notificationDeliveries.lastError,
        deliveredAt: schema.notificationDeliveries.deliveredAt,
        createdAt: schema.notificationDeliveries.createdAt,
      })
      .from(schema.notificationDeliveries)
      .where(and(...conditions))
      .orderBy(desc(schema.notificationDeliveries.createdAt))
      .limit(query.pageSize)
      .offset(offset);

    log.debug({ tenantId, userId, filters: query, total }, 'Listed deliveries');

    res.json({
      data: deliveries,
      pagination: {
        total,
        page: query.page,
        pageSize: query.pageSize,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /:notificationId/deliveries — Deliveries for a notification ──
deliveriesRouter.get('/:notificationId/deliveries', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;
    const role = req.user!.role;
    const isAdmin = role === 'tenant_admin';
    const notificationId = req.params.notificationId;

    // First, verify the notification exists and belongs to this tenant
    const [notification] = await db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.id, notificationId),
          eq(schema.notifications.tenantId, tenantId),
        )
      );

    if (!notification) {
      throw new AppError(404, 'Notification not found', 'NOT_FOUND');
    }

    // RBAC: regular users can only see deliveries for their own notifications
    if (!isAdmin && notification.userId !== userId) {
      throw new AppError(404, 'Notification not found', 'NOT_FOUND');
    }

    // Fetch all deliveries for this notification
    const deliveries = await db
      .select({
        id: schema.notificationDeliveries.id,
        notificationId: schema.notificationDeliveries.notificationId,
        userId: schema.notificationDeliveries.userId,
        channel: schema.notificationDeliveries.channel,
        status: schema.notificationDeliveries.status,
        provider: schema.notificationDeliveries.provider,
        providerMessageId: schema.notificationDeliveries.providerMessageId,
        attemptCount: schema.notificationDeliveries.attemptCount,
        lastAttemptAt: schema.notificationDeliveries.lastAttemptAt,
        lastError: schema.notificationDeliveries.lastError,
        deliveredAt: schema.notificationDeliveries.deliveredAt,
        createdAt: schema.notificationDeliveries.createdAt,
      })
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.notificationId, notificationId),
          eq(schema.notificationDeliveries.tenantId, tenantId),
        )
      )
      .orderBy(desc(schema.notificationDeliveries.createdAt));

    log.debug({ tenantId, notificationId, count: deliveries.length }, 'Listed notification deliveries');

    res.json({ data: deliveries });
  } catch (err) {
    next(err);
  }
});
