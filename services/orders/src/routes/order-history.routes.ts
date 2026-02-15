import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, desc, asc, inArray } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest, AuditContext } from '@arda/auth-utils';
import { getEventBus } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';

const log = createLogger('order-history');

export const orderHistoryRouter = Router();

const {
  purchaseOrders,
  purchaseOrderLines,
  workOrders,
  workOrderRoutings,
  transferOrders,
  transferOrderLines,
  receipts,
  receiptLines,
  receivingExceptions,
  orderIssues,
  orderIssueResolutionSteps,
  orderNotes,
  auditLog,
} = schema;

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

// ─── Validation Schemas ──────────────────────────────────────────────

const orderTypeEnum = z.enum(['purchase_order', 'work_order', 'transfer_order']);

const orderDetailParamsSchema = z.object({
  orderType: orderTypeEnum,
  orderId: z.string().uuid(),
});

const orderHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  orderType: orderTypeEnum.optional(),
  issueStatus: z.enum(['open', 'in_progress', 'waiting_vendor', 'resolved', 'closed', 'escalated']).optional(),
  hasIssues: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  search: z.string().max(200).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

const createIssueSchema = z.object({
  orderId: z.string().uuid(),
  orderType: orderTypeEnum,
  category: z.enum([
    'wrong_items', 'wrong_quantity', 'damaged', 'late_delivery',
    'quality_defect', 'pricing_discrepancy', 'missing_documentation', 'other',
  ]),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  assignedToUserId: z.string().uuid().optional(),
  relatedReceiptId: z.string().uuid().optional(),
  relatedExceptionId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateIssueStatusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'waiting_vendor', 'resolved', 'closed', 'escalated']),
  description: z.string().optional(),
});

const addResolutionStepSchema = z.object({
  actionType: z.enum([
    'contact_vendor', 'return_initiated', 'credit_requested', 'credit_received',
    'replacement_ordered', 'reorder', 'accept_as_is', 'escalated', 'note_added', 'status_changed',
  ]),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const addNoteSchema = z.object({
  orderId: z.string().uuid(),
  orderType: orderTypeEnum,
  content: z.string().min(1),
});

const issueListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['open', 'in_progress', 'waiting_vendor', 'resolved', 'closed', 'escalated']).optional(),
  category: z.enum([
    'wrong_items', 'wrong_quantity', 'damaged', 'late_delivery',
    'quality_defect', 'pricing_discrepancy', 'missing_documentation', 'other',
  ]).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  orderId: z.string().uuid().optional(),
  orderType: orderTypeEnum.optional(),
});

// ─── GET /detail/:orderType/:orderId — Rich order detail ──────────

orderHistoryRouter.get('/detail/:orderType/:orderId', async (req: AuthRequest, res, next) => {
  try {
    const params = orderDetailParamsSchema.parse(req.params);
    const tenantId = req.user!.tenantId;

    // 1. Fetch the order itself + lines
    const orderData = await fetchOrderWithLines(params.orderType, params.orderId, tenantId);

    // 2. Fetch audit timeline (status transitions and other events)
    const entityType = params.orderType;
    const timeline = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.entityType, entityType),
          eq(auditLog.entityId, params.orderId),
        ),
      )
      .orderBy(asc(auditLog.timestamp))
      .limit(200);

    // 3. Fetch receipts and their lines for this order
    const orderReceipts = await db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.tenantId, tenantId),
          eq(receipts.orderId, params.orderId),
        ),
      )
      .orderBy(desc(receipts.createdAt));

    let receiptDetails: Array<Record<string, unknown>> = [];
    if (orderReceipts.length > 0) {
      const receiptIds = orderReceipts.map((r) => r.id);
      const allReceiptLines = await db
        .select()
        .from(receiptLines)
        .where(
          and(
            eq(receiptLines.tenantId, tenantId),
            inArray(receiptLines.receiptId, receiptIds),
          ),
        );

      const allExceptions = await db
        .select()
        .from(receivingExceptions)
        .where(
          and(
            eq(receivingExceptions.tenantId, tenantId),
            inArray(receivingExceptions.receiptId, receiptIds),
          ),
        );

      receiptDetails = orderReceipts.map((receipt) => ({
        ...receipt,
        lines: allReceiptLines.filter((rl) => rl.receiptId === receipt.id),
        exceptions: allExceptions.filter((ex) => ex.receiptId === receipt.id),
      }));
    }

    // 4. Fetch issues and their resolution steps
    const issues = await db
      .select()
      .from(orderIssues)
      .where(
        and(
          eq(orderIssues.tenantId, tenantId),
          eq(orderIssues.orderId, params.orderId),
        ),
      )
      .orderBy(desc(orderIssues.createdAt));

    let issueDetails: Array<Record<string, unknown>> = [];
    if (issues.length > 0) {
      const issueIds = issues.map((i) => i.id);
      const allSteps = await db
        .select()
        .from(orderIssueResolutionSteps)
        .where(
          and(
            eq(orderIssueResolutionSteps.tenantId, tenantId),
            inArray(orderIssueResolutionSteps.issueId, issueIds),
          ),
        )
        .orderBy(asc(orderIssueResolutionSteps.createdAt));

      issueDetails = issues.map((issue) => ({
        ...issue,
        resolutionSteps: allSteps.filter((s) => s.issueId === issue.id),
      }));
    }

    // 5. Fetch notes
    const notes = await db
      .select()
      .from(orderNotes)
      .where(
        and(
          eq(orderNotes.tenantId, tenantId),
          eq(orderNotes.orderId, params.orderId),
        ),
      )
      .orderBy(desc(orderNotes.createdAt));

    res.json({
      data: {
        order: orderData,
        timeline,
        receipts: receiptDetails,
        issues: issueDetails,
        notes,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid parameters'));
    }
    next(error);
  }
});

// ─── GET / — Order history with filters ────────────────────────────

orderHistoryRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = orderHistoryQuerySchema.parse(req.query);
    const tenantId = req.user!.tenantId;
    const offset = (query.page - 1) * query.limit;

    // Build a unified order list by querying each order type and merging
    const results: Array<Record<string, unknown>> = [];
    let totalCount = 0;

    const orderTypes = query.orderType
      ? [query.orderType]
      : ['purchase_order', 'work_order', 'transfer_order'] as const;

    for (const ot of orderTypes) {
      const { items, total } = await fetchOrderList(ot, tenantId, query, offset);
      results.push(...items);
      totalCount += total;
    }

    // Sort merged results by updatedAt desc
    results.sort((a, b) => {
      const aTime = new Date(a.updatedAt as string).getTime();
      const bTime = new Date(b.updatedAt as string).getTime();
      return bTime - aTime;
    });

    // If querying all types, we need to re-paginate the merged result
    const paginatedResults = query.orderType
      ? results
      : results.slice(0, query.limit);

    res.json({
      data: paginatedResults,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / query.limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── POST /issues — Create an issue ───────────────────────────────

orderHistoryRouter.post('/issues', async (req: AuthRequest, res, next) => {
  try {
    const payload = createIssueSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);

    // Verify the order exists
    await verifyOrderExists(payload.orderType, payload.orderId, tenantId);

    const [issue] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(orderIssues)
        .values({
          tenantId,
          orderId: payload.orderId,
          orderType: payload.orderType,
          category: payload.category,
          priority: payload.priority,
          status: 'open',
          title: payload.title,
          description: payload.description || null,
          reportedByUserId: userId,
          assignedToUserId: payload.assignedToUserId || null,
          relatedReceiptId: payload.relatedReceiptId || null,
          relatedExceptionId: payload.relatedExceptionId || null,
          metadata: payload.metadata || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      // Add initial resolution step
      await tx
        .insert(orderIssueResolutionSteps)
        .values({
          tenantId,
          issueId: created.id,
          actionType: 'note_added',
          description: `Issue created: ${payload.title}`,
          performedByUserId: userId,
          metadata: { category: payload.category, priority: payload.priority },
          createdAt: new Date(),
        });

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'order_issue.created',
        entityType: 'order_issue',
        entityId: created.id,
        previousState: null,
        newState: {
          status: 'open',
          category: payload.category,
          priority: payload.priority,
          title: payload.title,
          orderId: payload.orderId,
          orderType: payload.orderType,
        },
        metadata: {
          source: 'order-history.create_issue',
          orderId: payload.orderId,
          orderType: payload.orderType,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return [created];
    });

    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.issue_created',
        tenantId,
        issueId: issue.id,
        orderId: payload.orderId,
        orderType: payload.orderType,
        category: payload.category,
        priority: payload.priority,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err, issueId: issue.id }, 'Failed to publish issue created event');
    }

    res.status(201).json({ data: issue });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Validation error'));
    }
    next(error);
  }
});

// ─── GET /issues — List issues with filters ────────────────────────

orderHistoryRouter.get('/issues', async (req: AuthRequest, res, next) => {
  try {
    const query = issueListQuerySchema.parse(req.query);
    const tenantId = req.user!.tenantId;
    const offset = (query.page - 1) * query.limit;

    const conditions: ReturnType<typeof eq>[] = [eq(orderIssues.tenantId, tenantId)];

    if (query.status) conditions.push(eq(orderIssues.status, query.status));
    if (query.category) conditions.push(eq(orderIssues.category, query.category));
    if (query.priority) conditions.push(eq(orderIssues.priority, query.priority));
    if (query.orderId) conditions.push(eq(orderIssues.orderId, query.orderId));
    if (query.orderType) conditions.push(eq(orderIssues.orderType, query.orderType));

    const [items, countResult] = await Promise.all([
      db
        .select()
        .from(orderIssues)
        .where(and(...conditions))
        .orderBy(desc(orderIssues.createdAt))
        .offset(offset)
        .limit(query.limit),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(orderIssues)
        .where(and(...conditions)),
    ]);

    res.json({
      data: items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: countResult[0].count,
        totalPages: Math.ceil(countResult[0].count / query.limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// ─── GET /issues/:issueId — Issue detail with resolution steps ─────

orderHistoryRouter.get('/issues/:issueId', async (req: AuthRequest, res, next) => {
  try {
    const issueId = req.params.issueId as string;
    const tenantId = req.user!.tenantId;

    const [issue] = await db
      .select()
      .from(orderIssues)
      .where(and(eq(orderIssues.id, issueId), eq(orderIssues.tenantId, tenantId)));

    if (!issue) {
      throw new AppError(404, 'Issue not found');
    }

    const steps = await db
      .select()
      .from(orderIssueResolutionSteps)
      .where(
        and(
          eq(orderIssueResolutionSteps.issueId, issueId),
          eq(orderIssueResolutionSteps.tenantId, tenantId),
        ),
      )
      .orderBy(asc(orderIssueResolutionSteps.createdAt));

    res.json({ data: { ...issue, resolutionSteps: steps } });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /issues/:issueId/status — Update issue status ──────────

orderHistoryRouter.patch('/issues/:issueId/status', async (req: AuthRequest, res, next) => {
  try {
    const issueId = req.params.issueId as string;
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);
    const payload = updateIssueStatusSchema.parse(req.body);

    const [updated] = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(orderIssues)
        .where(and(eq(orderIssues.id, issueId), eq(orderIssues.tenantId, tenantId)));

      if (!existing) {
        throw new AppError(404, 'Issue not found');
      }

      if (existing.status === 'closed') {
        throw new AppError(409, 'Cannot change status of a closed issue');
      }

      const now = new Date();
      const updates: Record<string, unknown> = {
        status: payload.status,
        updatedAt: now,
      };

      if (payload.status === 'resolved') {
        updates.resolvedByUserId = userId;
        updates.resolvedAt = now;
      }
      if (payload.status === 'closed') {
        updates.closedAt = now;
      }

      const [result] = await tx
        .update(orderIssues)
        .set(updates)
        .where(eq(orderIssues.id, issueId))
        .returning();

      // Add a status_changed resolution step
      await tx
        .insert(orderIssueResolutionSteps)
        .values({
          tenantId,
          issueId,
          actionType: 'status_changed',
          description: payload.description || `Status changed from ${existing.status} to ${payload.status}`,
          performedByUserId: userId,
          metadata: { fromStatus: existing.status, toStatus: payload.status },
          createdAt: now,
        });

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'order_issue.status_changed',
        entityType: 'order_issue',
        entityId: issueId,
        previousState: { status: existing.status },
        newState: { status: payload.status },
        metadata: {
          source: 'order-history.update_issue_status',
          orderId: existing.orderId,
          orderType: existing.orderType,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return [result];
    });

    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.issue_status_changed',
        tenantId,
        issueId,
        orderId: updated.orderId,
        orderType: updated.orderType,
        fromStatus: req.body.fromStatus,
        toStatus: payload.status,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err, issueId }, 'Failed to publish issue status changed event');
    }

    res.json({ data: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Validation error'));
    }
    next(error);
  }
});

// ─── POST /issues/:issueId/steps — Add resolution step ────────────

orderHistoryRouter.post('/issues/:issueId/steps', async (req: AuthRequest, res, next) => {
  try {
    const issueId = req.params.issueId as string;
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);
    const payload = addResolutionStepSchema.parse(req.body);

    const [step] = await db.transaction(async (tx) => {
      const [issue] = await tx
        .select()
        .from(orderIssues)
        .where(and(eq(orderIssues.id, issueId), eq(orderIssues.tenantId, tenantId)));

      if (!issue) {
        throw new AppError(404, 'Issue not found');
      }

      if (issue.status === 'closed') {
        throw new AppError(409, 'Cannot add steps to a closed issue');
      }

      const [created] = await tx
        .insert(orderIssueResolutionSteps)
        .values({
          tenantId,
          issueId,
          actionType: payload.actionType,
          description: payload.description || null,
          performedByUserId: userId,
          metadata: payload.metadata || null,
          createdAt: new Date(),
        })
        .returning();

      // Auto-transition to in_progress if issue is still open
      if (issue.status === 'open') {
        await tx
          .update(orderIssues)
          .set({ status: 'in_progress', updatedAt: new Date() })
          .where(eq(orderIssues.id, issueId));
      }

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'order_issue.resolution_step_added',
        entityType: 'order_issue',
        entityId: issueId,
        previousState: null,
        newState: { actionType: payload.actionType, stepId: created.id },
        metadata: {
          source: 'order-history.add_resolution_step',
          orderId: issue.orderId,
          orderType: issue.orderType,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return [created];
    });

    res.status(201).json({ data: step });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Validation error'));
    }
    next(error);
  }
});

// ─── POST /notes — Add note to an order ───────────────────────────

orderHistoryRouter.post('/notes', async (req: AuthRequest, res, next) => {
  try {
    const payload = addNoteSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);

    await verifyOrderExists(payload.orderType, payload.orderId, tenantId);

    const [note] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(orderNotes)
        .values({
          tenantId,
          orderId: payload.orderId,
          orderType: payload.orderType,
          content: payload.content,
          createdByUserId: userId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'order_note.created',
        entityType: payload.orderType,
        entityId: payload.orderId,
        previousState: null,
        newState: { noteId: created.id },
        metadata: {
          source: 'order-history.add_note',
          orderId: payload.orderId,
          orderType: payload.orderType,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return [created];
    });

    res.status(201).json({ data: note });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Validation error'));
    }
    next(error);
  }
});

// ─── Helpers ────────────────────────────────────────────────────────

async function verifyOrderExists(
  orderType: string,
  orderId: string,
  tenantId: string,
): Promise<void> {
  let exists = false;

  if (orderType === 'purchase_order') {
    const result = await db
      .select({ id: purchaseOrders.id })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.tenantId, tenantId)))
      .limit(1);
    exists = result.length > 0;
  } else if (orderType === 'work_order') {
    const result = await db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(and(eq(workOrders.id, orderId), eq(workOrders.tenantId, tenantId)))
      .limit(1);
    exists = result.length > 0;
  } else if (orderType === 'transfer_order') {
    const result = await db
      .select({ id: transferOrders.id })
      .from(transferOrders)
      .where(and(eq(transferOrders.id, orderId), eq(transferOrders.tenantId, tenantId)))
      .limit(1);
    exists = result.length > 0;
  }

  if (!exists) {
    throw new AppError(404, `${orderType.replace(/_/g, ' ')} not found`);
  }
}

async function fetchOrderWithLines(
  orderType: string,
  orderId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  if (orderType === 'purchase_order') {
    const [po] = await db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.tenantId, tenantId)));
    if (!po) throw new AppError(404, 'Purchase order not found');

    const lines = await db
      .select()
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.purchaseOrderId, orderId),
          eq(purchaseOrderLines.tenantId, tenantId),
        ),
      )
      .orderBy(asc(purchaseOrderLines.lineNumber));

    return { ...po, orderType: 'purchase_order', lines };
  }

  if (orderType === 'work_order') {
    const [wo] = await db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.id, orderId), eq(workOrders.tenantId, tenantId)));
    if (!wo) throw new AppError(404, 'Work order not found');

    const routings = await db
      .select()
      .from(workOrderRoutings)
      .where(
        and(
          eq(workOrderRoutings.workOrderId, orderId),
          eq(workOrderRoutings.tenantId, tenantId),
        ),
      )
      .orderBy(asc(workOrderRoutings.stepNumber));

    return { ...wo, orderType: 'work_order', routingSteps: routings };
  }

  if (orderType === 'transfer_order') {
    const [to] = await db
      .select()
      .from(transferOrders)
      .where(and(eq(transferOrders.id, orderId), eq(transferOrders.tenantId, tenantId)));
    if (!to) throw new AppError(404, 'Transfer order not found');

    const lines = await db
      .select()
      .from(transferOrderLines)
      .where(
        and(
          eq(transferOrderLines.transferOrderId, orderId),
          eq(transferOrderLines.tenantId, tenantId),
        ),
      )
      .orderBy(asc(transferOrderLines.id));

    return { ...to, orderType: 'transfer_order', lines };
  }

  throw new AppError(400, 'Invalid order type');
}

async function fetchOrderList(
  orderType: 'purchase_order' | 'work_order' | 'transfer_order',
  tenantId: string,
  query: z.infer<typeof orderHistoryQuerySchema>,
  offset: number,
): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  // If filtering by issue status, we need to join with order_issues
  if (query.hasIssues || query.issueStatus) {
    return fetchOrderListWithIssueFilters(orderType, tenantId, query, offset);
  }

  if (orderType === 'purchase_order') {
    const conditions: ReturnType<typeof eq>[] = [eq(purchaseOrders.tenantId, tenantId)];
    if (query.dateFrom) conditions.push(sql`${purchaseOrders.createdAt} >= ${new Date(query.dateFrom)}`);
    if (query.dateTo) conditions.push(sql`${purchaseOrders.createdAt} <= ${new Date(query.dateTo)}`);
    if (query.search) {
      conditions.push(sql`${purchaseOrders.poNumber} ILIKE ${'%' + query.search + '%'}`);
    }

    const [items, countResult] = await Promise.all([
      db.select().from(purchaseOrders).where(and(...conditions))
        .orderBy(desc(purchaseOrders.updatedAt)).offset(offset).limit(query.limit),
      db.select({ count: sql<number>`count(*)::int` }).from(purchaseOrders).where(and(...conditions)),
    ]);

    // Count open issues per order
    const orderIds = items.map((i) => i.id);
    const issueCounts = orderIds.length > 0
      ? await db
          .select({
            orderId: orderIssues.orderId,
            openIssues: sql<number>`count(*) FILTER (WHERE ${orderIssues.status} NOT IN ('resolved', 'closed'))::int`,
            totalIssues: sql<number>`count(*)::int`,
          })
          .from(orderIssues)
          .where(and(eq(orderIssues.tenantId, tenantId), inArray(orderIssues.orderId, orderIds)))
          .groupBy(orderIssues.orderId)
      : [];

    const issueMap = new Map(issueCounts.map((ic) => [ic.orderId, ic]));

    return {
      items: items.map((item) => ({
        ...item,
        orderType: 'purchase_order',
        orderNumber: item.poNumber,
        openIssues: issueMap.get(item.id)?.openIssues ?? 0,
        totalIssues: issueMap.get(item.id)?.totalIssues ?? 0,
      })),
      total: countResult[0].count,
    };
  }

  if (orderType === 'work_order') {
    const conditions: ReturnType<typeof eq>[] = [eq(workOrders.tenantId, tenantId)];
    if (query.dateFrom) conditions.push(sql`${workOrders.createdAt} >= ${new Date(query.dateFrom)}`);
    if (query.dateTo) conditions.push(sql`${workOrders.createdAt} <= ${new Date(query.dateTo)}`);
    if (query.search) {
      conditions.push(sql`${workOrders.woNumber} ILIKE ${'%' + query.search + '%'}`);
    }

    const [items, countResult] = await Promise.all([
      db.select().from(workOrders).where(and(...conditions))
        .orderBy(desc(workOrders.updatedAt)).offset(offset).limit(query.limit),
      db.select({ count: sql<number>`count(*)::int` }).from(workOrders).where(and(...conditions)),
    ]);

    const orderIds = items.map((i) => i.id);
    const issueCounts = orderIds.length > 0
      ? await db
          .select({
            orderId: orderIssues.orderId,
            openIssues: sql<number>`count(*) FILTER (WHERE ${orderIssues.status} NOT IN ('resolved', 'closed'))::int`,
            totalIssues: sql<number>`count(*)::int`,
          })
          .from(orderIssues)
          .where(and(eq(orderIssues.tenantId, tenantId), inArray(orderIssues.orderId, orderIds)))
          .groupBy(orderIssues.orderId)
      : [];

    const issueMap = new Map(issueCounts.map((ic) => [ic.orderId, ic]));

    return {
      items: items.map((item) => ({
        ...item,
        orderType: 'work_order',
        orderNumber: item.woNumber,
        openIssues: issueMap.get(item.id)?.openIssues ?? 0,
        totalIssues: issueMap.get(item.id)?.totalIssues ?? 0,
      })),
      total: countResult[0].count,
    };
  }

  // transfer_order
  const conditions: ReturnType<typeof eq>[] = [eq(transferOrders.tenantId, tenantId)];
  if (query.dateFrom) conditions.push(sql`${transferOrders.createdAt} >= ${new Date(query.dateFrom)}`);
  if (query.dateTo) conditions.push(sql`${transferOrders.createdAt} <= ${new Date(query.dateTo)}`);
  if (query.search) {
    conditions.push(sql`${transferOrders.toNumber} ILIKE ${'%' + query.search + '%'}`);
  }

  const [items, countResult] = await Promise.all([
    db.select().from(transferOrders).where(and(...conditions))
      .orderBy(desc(transferOrders.updatedAt)).offset(offset).limit(query.limit),
    db.select({ count: sql<number>`count(*)::int` }).from(transferOrders).where(and(...conditions)),
  ]);

  const orderIds = items.map((i) => i.id);
  const issueCounts = orderIds.length > 0
    ? await db
        .select({
          orderId: orderIssues.orderId,
          openIssues: sql<number>`count(*) FILTER (WHERE ${orderIssues.status} NOT IN ('resolved', 'closed'))::int`,
          totalIssues: sql<number>`count(*)::int`,
        })
        .from(orderIssues)
        .where(and(eq(orderIssues.tenantId, tenantId), inArray(orderIssues.orderId, orderIds)))
        .groupBy(orderIssues.orderId)
    : [];

  const issueMap = new Map(issueCounts.map((ic) => [ic.orderId, ic]));

  return {
    items: items.map((item) => ({
      ...item,
      orderType: 'transfer_order',
      orderNumber: item.toNumber,
      openIssues: issueMap.get(item.id)?.openIssues ?? 0,
      totalIssues: issueMap.get(item.id)?.totalIssues ?? 0,
    })),
    total: countResult[0].count,
  };
}

async function fetchOrderListWithIssueFilters(
  orderType: 'purchase_order' | 'work_order' | 'transfer_order',
  tenantId: string,
  query: z.infer<typeof orderHistoryQuerySchema>,
  offset: number,
): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  // Get order IDs that have matching issues
  const issueConditions: ReturnType<typeof eq>[] = [
    eq(orderIssues.tenantId, tenantId),
    eq(orderIssues.orderType, orderType),
  ];
  if (query.issueStatus) {
    issueConditions.push(eq(orderIssues.status, query.issueStatus));
  }

  const matchingOrderIds = await db
    .selectDistinct({ orderId: orderIssues.orderId })
    .from(orderIssues)
    .where(and(...issueConditions));

  if (matchingOrderIds.length === 0) {
    return { items: [], total: 0 };
  }

  const ids = matchingOrderIds.map((r) => r.orderId);

  if (orderType === 'purchase_order') {
    const conditions: ReturnType<typeof eq>[] = [
      eq(purchaseOrders.tenantId, tenantId),
      inArray(purchaseOrders.id, ids),
    ];

    const [items, countResult] = await Promise.all([
      db.select().from(purchaseOrders).where(and(...conditions))
        .orderBy(desc(purchaseOrders.updatedAt)).offset(offset).limit(query.limit),
      db.select({ count: sql<number>`count(*)::int` }).from(purchaseOrders).where(and(...conditions)),
    ]);

    return {
      items: items.map((item) => ({ ...item, orderType: 'purchase_order', orderNumber: item.poNumber })),
      total: countResult[0].count,
    };
  }

  if (orderType === 'work_order') {
    const conditions: ReturnType<typeof eq>[] = [
      eq(workOrders.tenantId, tenantId),
      inArray(workOrders.id, ids),
    ];

    const [items, countResult] = await Promise.all([
      db.select().from(workOrders).where(and(...conditions))
        .orderBy(desc(workOrders.updatedAt)).offset(offset).limit(query.limit),
      db.select({ count: sql<number>`count(*)::int` }).from(workOrders).where(and(...conditions)),
    ]);

    return {
      items: items.map((item) => ({ ...item, orderType: 'work_order', orderNumber: item.woNumber })),
      total: countResult[0].count,
    };
  }

  // transfer_order
  const conditions: ReturnType<typeof eq>[] = [
    eq(transferOrders.tenantId, tenantId),
    inArray(transferOrders.id, ids),
  ];

  const [items, countResult] = await Promise.all([
    db.select().from(transferOrders).where(and(...conditions))
      .orderBy(desc(transferOrders.updatedAt)).offset(offset).limit(query.limit),
    db.select({ count: sql<number>`count(*)::int` }).from(transferOrders).where(and(...conditions)),
  ]);

  return {
    items: items.map((item) => ({ ...item, orderType: 'transfer_order', orderNumber: item.toNumber })),
    total: countResult[0].count,
  };
}
