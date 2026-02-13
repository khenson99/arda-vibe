import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, schema, writeAuditEntry } from '@arda/db';
import { eq, and, desc, sql, inArray, gte, lte } from 'drizzle-orm';
import type { AuditContext } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

function getRequestAuditContext(req: Request): AuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded as string | undefined)?.split(',')[0]?.trim();
  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
  return {
    userId: req.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

export const notificationsRouter = Router();

// Query validation schemas
const listQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  type: z.string().optional(),
  types: z.string().optional(), // CSV of types
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// GET / — List notifications for current user
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;

    const queryParams = listQuerySchema.parse(req.query);

    // Build conditions array — Drizzle v0.39 doesn't support chaining multiple .where()
    const conditions = [
      eq(schema.notifications.tenantId, tenantId),
      eq(schema.notifications.userId, userId),
    ];

    if (queryParams.unreadOnly) {
      conditions.push(eq(schema.notifications.isRead, false));
    }

    // Single type filter (legacy)
    if (queryParams.type) {
      conditions.push(eq(schema.notifications.type, queryParams.type as (typeof schema.notificationTypeEnum.enumValues)[number]));
    }

    // Multiple types filter (CSV)
    if (queryParams.types) {
      const typesList = queryParams.types.split(',').map(t => t.trim()) as Array<(typeof schema.notificationTypeEnum.enumValues)[number]>;
      conditions.push(inArray(schema.notifications.type, typesList));
    }

    // Date range filters
    if (queryParams.startDate) {
      conditions.push(gte(schema.notifications.createdAt, new Date(queryParams.startDate)));
    }

    if (queryParams.endDate) {
      conditions.push(lte(schema.notifications.createdAt, new Date(queryParams.endDate)));
    }

    // Priority filter (using metadata field)
    if (queryParams.priority) {
      conditions.push(sql`${schema.notifications.metadata}->>'priority' = ${queryParams.priority}`);
    }

    // Get total count matching the filter
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(and(...conditions));

    const totalCount = countResult[0]?.count || 0;

    // Get paginated results
    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(and(...conditions))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(queryParams.limit as number)
      .offset(queryParams.offset as number);

    res.json({
      data: notifications,
      count: notifications.length,
      totalCount
    });
  } catch (err) {
    next(err);
  }
});

// GET /unread-count — Get unread count for current user
notificationsRouter.get('/unread-count', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;

    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.tenantId, tenantId),
          eq(schema.notifications.userId, userId),
          eq(schema.notifications.isRead, false)
        )
      );

    const count = result[0]?.count || 0;
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/read — Mark single notification as read
notificationsRouter.patch('/:id/read', async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;

    // Verify ownership before updating
    const notification = await db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.id, id),
          eq(schema.notifications.tenantId, tenantId),
          eq(schema.notifications.userId, userId)
        )
      );

    if (!notification.length) {
      throw new AppError(404, 'Notification not found', 'NOT_FOUND');
    }

    const updated = await db
      .update(schema.notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.id, id),
          eq(schema.notifications.tenantId, tenantId),
          eq(schema.notifications.userId, userId)
        )
      )
      .returning();

    res.json({ data: updated[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/unread — Mark single notification as unread
notificationsRouter.patch('/:id/unread', async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;

    // Verify ownership before updating
    const notification = await db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.id, id),
          eq(schema.notifications.tenantId, tenantId),
          eq(schema.notifications.userId, userId)
        )
      );

    if (!notification.length) {
      throw new AppError(404, 'Notification not found', 'NOT_FOUND');
    }

    const updated = await db
      .update(schema.notifications)
      .set({ isRead: false, readAt: null })
      .where(
        and(
          eq(schema.notifications.id, id),
          eq(schema.notifications.tenantId, tenantId),
          eq(schema.notifications.userId, userId)
        )
      )
      .returning();

    res.json({ data: updated[0] });
  } catch (err) {
    next(err);
  }
});

// POST /mark-all-read — Mark all unread notifications as read
notificationsRouter.post('/mark-all-read', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;

    await db
      .update(schema.notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.tenantId, tenantId),
          eq(schema.notifications.userId, userId),
          eq(schema.notifications.isRead, false)
        )
      );

    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — Delete a notification (dismissal)
notificationsRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    // Verify ownership before deleting
    const notification = await db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.id, id),
          eq(schema.notifications.tenantId, tenantId),
          eq(schema.notifications.userId, userId)
        )
      );

    if (!notification.length) {
      throw new AppError(404, 'Notification not found', 'NOT_FOUND');
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(schema.notifications)
        .where(
          and(
            eq(schema.notifications.id, id),
            eq(schema.notifications.tenantId, tenantId),
            eq(schema.notifications.userId, userId)
          )
        );

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'notification.dismissed',
        entityType: 'notification',
        entityId: id,
        previousState: {
          type: notification[0].type,
          isRead: notification[0].isRead,
        },
        metadata: { source: 'notifications.dismiss', notificationType: notification[0].type },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });
    });

    res.json({ message: 'Notification deleted' });
  } catch (err) {
    next(err);
  }
});
