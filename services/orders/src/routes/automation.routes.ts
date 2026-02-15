/**
 * Automation Routes
 *
 * REST API endpoints for managing the TCAAF automation pipeline.
 * Provides DLQ inspection/replay, kill switch, idempotency management,
 * decision audit queries, and health checks.
 */

import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import { config } from '@arda/config';
import { listDLQEntries, replayFromDLQ, createDLQ } from '@arda/jobs';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';
import { AutomationOrchestrator } from '../services/automation/index.js';
import {
  createAutomationQueue,
  type AutomationWorkerPayload,
} from '../workers/automation.worker.js';
import { autoCreateTransferOrder } from '../services/kanban-transfer-automation.service.js';

export const automationRouter = Router();

// ─── Lazy Singletons ──────────────────────────────────────────────────
// These are created on first use so the router module can be imported
// without requiring Redis to be available at import time.

let _orchestrator: AutomationOrchestrator | null = null;

function getOrchestrator(): AutomationOrchestrator {
  if (!_orchestrator) {
    _orchestrator = new AutomationOrchestrator(config.REDIS_URL);
  }
  return _orchestrator;
}

// ─── Schemas ──────────────────────────────────────────────────────────

const killSwitchSchema = z.object({
  action: z.enum(['activate', 'deactivate']),
  tenantId: z.string().uuid().optional(),
});

const dlqListSchema = z.object({
  start: z.coerce.number().int().min(0).default(0),
  end: z.coerce.number().int().min(0).default(100),
});

const decisionQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  decision: z.enum(['allowed', 'denied', 'escalated']).optional(),
  actionType: z.string().max(100).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

// ─── DLQ Endpoints ────────────────────────────────────────────────────

/**
 * GET /automation/dlq
 *
 * List entries in the automation dead letter queue.
 */
automationRouter.get('/dlq', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const { start, end } = dlqListSchema.parse(req.query);

    const dlq = createDLQ('orders:automation', config.REDIS_URL);
    const entries = await listDLQEntries(dlq, start, end);
    await dlq.close();

    // Filter to this tenant's entries
    const tenantEntries = entries.filter(
      (entry) => entry.job?.tenantId === tenantId,
    );

    res.json({ data: tenantEntries, total: tenantEntries.length });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

/**
 * POST /automation/dlq/:jobId/replay
 *
 * Replay a specific DLQ entry back to the automation queue.
 * Optionally clears the idempotency key first.
 */
automationRouter.post('/dlq/:jobId/replay', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const jobId = req.params.jobId as string;
    if (!jobId) throw new AppError(400, 'Job ID is required');

    const clearIdempotency = req.body?.clearIdempotency === true;

    const dlq = createDLQ('orders:automation', config.REDIS_URL);
    const queue = createAutomationQueue(config.REDIS_URL);

    // Optionally clear the idempotency key before replay
    if (clearIdempotency) {
      const orchestrator = getOrchestrator();
      // The DLQ job ID is prefixed with 'dlq:', strip it to get the original key
      const originalKey = jobId.startsWith('dlq:') ? jobId.slice(4) : jobId;
      await orchestrator.clearIdempotencyKey(originalKey);
    }

    await replayFromDLQ<AutomationWorkerPayload>(queue, dlq, jobId);

    await Promise.all([dlq.close(), queue.close()]);

    res.json({ success: true, message: `Job ${jobId} replayed successfully` });
  } catch (error) {
    next(error);
  }
});

// ─── Kill Switch ──────────────────────────────────────────────────────

/**
 * POST /automation/kill-switch
 *
 * Activate or deactivate the automation kill switch.
 * Can target a specific tenant or act globally.
 */
automationRouter.post('/kill-switch', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const { action, tenantId: targetTenantId } = killSwitchSchema.parse(req.body);

    // Non-admin users can only toggle their own tenant's kill switch
    const effectiveTenantId = targetTenantId ?? tenantId;

    const orchestrator = getOrchestrator();

    if (action === 'activate') {
      await orchestrator.activateKillSwitch(effectiveTenantId);
    } else {
      await orchestrator.deactivateKillSwitch(effectiveTenantId);
    }

    res.json({
      success: true,
      killSwitch: {
        action,
        tenantId: effectiveTenantId,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

/**
 * GET /automation/kill-switch
 *
 * Check the current kill switch status.
 */
automationRouter.get('/kill-switch', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const orchestrator = getOrchestrator();
    const isActive = await orchestrator.isKillSwitchActive(tenantId);

    res.json({ active: isActive, tenantId });
  } catch (error) {
    next(error);
  }
});

// ─── Idempotency ─────────────────────────────────────────────────────

/**
 * DELETE /automation/idempotency/:key
 *
 * Clear an idempotency key to allow re-execution.
 * Typically used before replaying a DLQ entry.
 */
automationRouter.delete('/idempotency/:key', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const key = req.params.key as string;
    if (!key) throw new AppError(400, 'Idempotency key is required');

    const orchestrator = getOrchestrator();
    const cleared = await orchestrator.clearIdempotencyKey(key);

    res.json({ success: true, cleared, key });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /automation/idempotency/:key
 *
 * Check the status of an idempotency key.
 */
automationRouter.get('/idempotency/:key', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const key = req.params.key as string;
    if (!key) throw new AppError(400, 'Idempotency key is required');

    const orchestrator = getOrchestrator();
    const status = await orchestrator.checkIdempotencyKey(key);

    res.json({ key, ...status });
  } catch (error) {
    next(error);
  }
});

// ─── Decisions ───────────────────────────────────────────────────────

/**
 * GET /automation/decisions
 *
 * Query automation decision audit records.
 */
automationRouter.get('/decisions', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const { page, limit, decision, actionType, dateFrom, dateTo } =
      decisionQuerySchema.parse(req.query);

    const offset = (page - 1) * limit;

    const conditions: unknown[] = [
      eq(schema.auditLog.tenantId, tenantId),
      eq(schema.auditLog.entityType, 'automation_decision'),
    ];

    if (decision) {
      conditions.push(eq(schema.auditLog.action, `automation:${decision}`));
    }

    if (actionType) {
      conditions.push(
        sql`${schema.auditLog.newState}::jsonb ->> 'actionType' = ${actionType}`,
      );
    }

    if (dateFrom) {
      conditions.push(
        sql`${schema.auditLog.timestamp} >= ${new Date(dateFrom)}`,
      );
    }

    if (dateTo) {
      conditions.push(
        sql`${schema.auditLog.timestamp} <= ${new Date(dateTo)}`,
      );
    }

    const [countResult] = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(schema.auditLog)
      .where(and(...(conditions as any[])));

    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(...(conditions as any[])))
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

// ─── Transfer Trigger ──────────────────────────────────────────────────

const transferTriggerSchema = z.object({
  cardId: z.string().uuid(),
});

/**
 * POST /automation/transfer-trigger
 *
 * Trigger transfer-order creation from a triggered kanban card.
 * Idempotent: if the card already has a linked TO, returns the existing link.
 */
automationRouter.post('/transfer-trigger', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const { cardId } = transferTriggerSchema.parse(req.body);

    const result = await autoCreateTransferOrder({
      tenantId,
      cardId,
      userId: req.user!.sub,
    });

    res.status(201).json({
      success: true,
      transferOrderId: result.transferOrderId,
      toNumber: result.toNumber,
      cardId: result.cardId,
      loopId: result.loopId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// ─── Health ──────────────────────────────────────────────────────────

/**
 * GET /automation/health
 *
 * Health check for the automation subsystem.
 */
automationRouter.get('/health', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Unauthorized');

    const orchestrator = getOrchestrator();
    const health = await orchestrator.healthCheck();

    const isHealthy = health.redis;

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'ok' : 'degraded',
      subsystem: 'automation',
      ...health,
    });
  } catch (error) {
    next(error);
  }
});
