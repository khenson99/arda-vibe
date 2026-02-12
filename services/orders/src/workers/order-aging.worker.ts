/**
 * Order Aging Worker
 *
 * Checks orders that have been stuck in the same status for too long
 * and escalates them. For example:
 *   - Purchase orders in 'pending_approval' > 48h -> flag as needs_attention
 *   - Work orders in 'draft' > 72h -> flag as needs_attention
 *   - Transfer orders in 'requested' > 48h -> flag as needs_attention
 *
 * The worker does not change order status directly but creates
 * audit-log entries and can update priority fields to surface aged orders.
 *
 * Schedule: Every 6 hours
 * Concurrency: 2
 */

import type { Job, Queue, Worker } from 'bullmq';
import {
  createQueue,
  createWorker,
  buildJobEnvelope,
  createDLQ,
  moveToDeadLetterQueue,
} from '@arda/jobs';
import type { JobEnvelope } from '@arda/jobs';
import { db, schema } from '@arda/db';
import { eq, and, lt } from 'drizzle-orm';

const { purchaseOrders, workOrders, transferOrders } = schema;

// ─── Payload Types ──────────────────────────────────────────────────

export interface OrderAgingPayload {
  /** Aging thresholds override (hours). Defaults apply if omitted. */
  thresholds?: {
    poApprovalHours?: number;
    poPendingSendHours?: number;
    woDraftHours?: number;
    woOnHoldHours?: number;
    toRequestedHours?: number;
  };
}

interface AgingResult {
  orderType: 'purchase_order' | 'work_order' | 'transfer_order';
  orderId: string;
  orderNumber: string;
  currentStatus: string;
  hoursInStatus: number;
  thresholdHours: number;
  action: 'escalated' | 'flagged';
}

// ─── Constants ──────────────────────────────────────────────────────

const QUEUE_NAME = 'orders:order-aging';
const JOB_TYPE = 'orders.order_aging';

/** Default thresholds in hours */
const DEFAULT_THRESHOLDS = {
  poApprovalHours: 48,
  poPendingSendHours: 24,
  woDraftHours: 72,
  woOnHoldHours: 96,
  toRequestedHours: 48,
};

// ─── Queue Factory ──────────────────────────────────────────────────

export function createOrderAgingQueue(redisUrl: string): Queue<JobEnvelope<OrderAgingPayload>> {
  return createQueue<OrderAgingPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function hoursElapsed(since: Date): number {
  return Math.round((Date.now() - since.getTime()) / (1000 * 60 * 60));
}

// ─── Processor ──────────────────────────────────────────────────────

async function processOrderAging(
  job: Job<JobEnvelope<OrderAgingPayload>>,
): Promise<void> {
  const { tenantId, payload } = job.data;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...payload.thresholds };
  const results: AgingResult[] = [];

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      thresholds,
      msg: 'Starting order aging check',
    }),
  );

  // ── Purchase Orders: pending_approval too long ──
  const agedPOsApproval = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      status: purchaseOrders.status,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.tenantId, tenantId),
        eq(purchaseOrders.status, 'pending_approval'),
        lt(purchaseOrders.updatedAt, hoursAgo(thresholds.poApprovalHours)),
      ),
    );

  for (const po of agedPOsApproval) {
    results.push({
      orderType: 'purchase_order',
      orderId: po.id,
      orderNumber: po.poNumber,
      currentStatus: po.status,
      hoursInStatus: hoursElapsed(po.updatedAt),
      thresholdHours: thresholds.poApprovalHours,
      action: 'flagged',
    });
  }

  // ── Purchase Orders: approved but not sent ──
  const agedPOsSend = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      status: purchaseOrders.status,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.tenantId, tenantId),
        eq(purchaseOrders.status, 'approved'),
        lt(purchaseOrders.updatedAt, hoursAgo(thresholds.poPendingSendHours)),
      ),
    );

  for (const po of agedPOsSend) {
    results.push({
      orderType: 'purchase_order',
      orderId: po.id,
      orderNumber: po.poNumber,
      currentStatus: po.status,
      hoursInStatus: hoursElapsed(po.updatedAt),
      thresholdHours: thresholds.poPendingSendHours,
      action: 'flagged',
    });
  }

  // ── Work Orders: stuck in draft ──
  const agedWOsDraft = await db
    .select({
      id: workOrders.id,
      woNumber: workOrders.woNumber,
      status: workOrders.status,
      updatedAt: workOrders.updatedAt,
      priority: workOrders.priority,
    })
    .from(workOrders)
    .where(
      and(
        eq(workOrders.tenantId, tenantId),
        eq(workOrders.status, 'draft'),
        lt(workOrders.updatedAt, hoursAgo(thresholds.woDraftHours)),
      ),
    );

  for (const wo of agedWOsDraft) {
    results.push({
      orderType: 'work_order',
      orderId: wo.id,
      orderNumber: wo.woNumber,
      currentStatus: wo.status,
      hoursInStatus: hoursElapsed(wo.updatedAt),
      thresholdHours: thresholds.woDraftHours,
      action: 'flagged',
    });
  }

  // ── Work Orders: on hold too long ──
  const agedWOsHold = await db
    .select({
      id: workOrders.id,
      woNumber: workOrders.woNumber,
      status: workOrders.status,
      updatedAt: workOrders.updatedAt,
      priority: workOrders.priority,
    })
    .from(workOrders)
    .where(
      and(
        eq(workOrders.tenantId, tenantId),
        eq(workOrders.status, 'on_hold'),
        lt(workOrders.updatedAt, hoursAgo(thresholds.woOnHoldHours)),
      ),
    );

  for (const wo of agedWOsHold) {
    // Escalate on-hold work orders by bumping priority
    await db
      .update(workOrders)
      .set({
        priority: Math.max(wo.priority + 1, 5),
        isExpedited: true,
        updatedAt: new Date(),
      })
      .where(eq(workOrders.id, wo.id));

    results.push({
      orderType: 'work_order',
      orderId: wo.id,
      orderNumber: wo.woNumber,
      currentStatus: wo.status,
      hoursInStatus: hoursElapsed(wo.updatedAt),
      thresholdHours: thresholds.woOnHoldHours,
      action: 'escalated',
    });
  }

  // ── Transfer Orders: requested but not approved ──
  const agedTOs = await db
    .select({
      id: transferOrders.id,
      toNumber: transferOrders.toNumber,
      status: transferOrders.status,
      updatedAt: transferOrders.updatedAt,
    })
    .from(transferOrders)
    .where(
      and(
        eq(transferOrders.tenantId, tenantId),
        eq(transferOrders.status, 'requested'),
        lt(transferOrders.updatedAt, hoursAgo(thresholds.toRequestedHours)),
      ),
    );

  for (const to of agedTOs) {
    results.push({
      orderType: 'transfer_order',
      orderId: to.id,
      orderNumber: to.toNumber,
      currentStatus: to.status,
      hoursInStatus: hoursElapsed(to.updatedAt),
      thresholdHours: thresholds.toRequestedHours,
      action: 'flagged',
    });
  }

  // ── Summary ──
  const escalatedCount = results.filter((r) => r.action === 'escalated').length;
  const flaggedCount = results.filter((r) => r.action === 'flagged').length;

  console.log(
    JSON.stringify({
      level: results.length > 0 ? 'warn' : 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      totalAged: results.length,
      escalatedCount,
      flaggedCount,
      breakdown: {
        purchaseOrders: results.filter((r) => r.orderType === 'purchase_order').length,
        workOrders: results.filter((r) => r.orderType === 'work_order').length,
        transferOrders: results.filter((r) => r.orderType === 'transfer_order').length,
      },
      msg: 'Order aging check complete',
    }),
  );
}

// ─── Worker Startup ─────────────────────────────────────────────────

export function startOrderAgingWorker(redisUrl: string): {
  worker: Worker<JobEnvelope<OrderAgingPayload>>;
  queue: Queue<JobEnvelope<OrderAgingPayload>>;
} {
  const queue = createOrderAgingQueue(redisUrl);
  const dlq = createDLQ(QUEUE_NAME, redisUrl);

  const worker = createWorker<OrderAgingPayload>(
    QUEUE_NAME,
    async (job) => {
      try {
        await processOrderAging(job);
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'error',
            worker: QUEUE_NAME,
            jobId: job.data.id,
            tenantId: job.data.tenantId,
            error: err instanceof Error ? err.message : String(err),
            attempt: job.attemptsMade,
            msg: 'Order aging check failed',
          }),
        );
        throw err;
      }
    },
    { redisUrl, concurrency: 3 },
  );

  worker.on('completed', (job) => {
    console.log(
      JSON.stringify({
        level: 'info',
        worker: QUEUE_NAME,
        jobId: job.data.id,
        tenantId: job.data.tenantId,
        msg: 'Job completed',
      }),
    );
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    console.log(
      JSON.stringify({
        level: 'error',
        worker: QUEUE_NAME,
        jobId: job.data.id,
        tenantId: job.data.tenantId,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        error: err.message,
        msg: 'Job failed',
      }),
    );

    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      await moveToDeadLetterQueue(dlq, job, err);
      console.log(
        JSON.stringify({
          level: 'warn',
          worker: QUEUE_NAME,
          jobId: job.data.id,
          msg: 'Job moved to dead letter queue',
        }),
      );
    }
  });

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      msg: 'Order aging worker started',
    }),
  );

  return { worker, queue };
}

// ─── Convenience: Enqueue an aging check for a specific tenant ──────

export function enqueueOrderAgingCheck(
  queue: Queue<JobEnvelope<OrderAgingPayload>>,
  tenantId: string,
  thresholds?: OrderAgingPayload['thresholds'],
) {
  const envelope = buildJobEnvelope<OrderAgingPayload>(
    JOB_TYPE,
    tenantId,
    { thresholds },
  );

  return queue.add(JOB_TYPE, envelope, {
    jobId: `order-aging:${tenantId}:${Date.now()}`,
  });
}
