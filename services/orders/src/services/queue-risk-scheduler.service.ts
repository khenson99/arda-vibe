import { and, eq } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import { createLogger } from '@arda/config';
import { runQueueRiskScanForTenant } from '../routes/order-queue.routes.js';

const log = createLogger('queue-risk-scheduler');

export interface QueueRiskSchedulerOptions {
  enabled: boolean;
  intervalMinutes: number;
  lookbackDays: number;
  minRiskLevel: 'medium' | 'high';
  limit: number;
}

export interface QueueRiskSchedulerHandle {
  runOnce: () => Promise<void>;
  stop: () => void;
}

export function startQueueRiskScheduler(
  options: QueueRiskSchedulerOptions
): QueueRiskSchedulerHandle {
  if (!options.enabled) {
    log.info('Queue risk scheduler disabled');
    return {
      runOnce: async () => undefined,
      stop: () => undefined,
    };
  }

  const intervalMs = Math.max(1, options.intervalMinutes) * 60 * 1000;
  let isRunning = false;

  const runOnce = async () => {
    if (isRunning) {
      log.warn('Skipping queue risk scan; previous run still in progress');
      return;
    }

    isRunning = true;
    try {
      const tenants = await db
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(and(eq(schema.tenants.isActive, true)));

      if (tenants.length === 0) {
        log.info('Queue risk scan skipped: no active tenants');
        return;
      }

      let totalRisks = 0;
      let totalEvents = 0;

      for (const tenant of tenants) {
        try {
          const result = await runQueueRiskScanForTenant({
            tenantId: tenant.id,
            lookbackDays: options.lookbackDays,
            limit: options.limit,
            minRiskLevel: options.minRiskLevel,
            emitEvents: true,
          });

          totalRisks += result.totalRisks;
          totalEvents += result.emittedRiskEvents;
        } catch (error) {
          log.error({ error, tenantId: tenant.id }, 'Queue risk scan failed for tenant');
        }
      }

      log.info(
        {
          tenantCount: tenants.length,
          totalRisks,
          totalEvents,
          lookbackDays: options.lookbackDays,
          minRiskLevel: options.minRiskLevel,
        },
        'Queue risk scan completed'
      );
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  log.info(
    {
      intervalMinutes: options.intervalMinutes,
      lookbackDays: options.lookbackDays,
      minRiskLevel: options.minRiskLevel,
      limit: options.limit,
    },
    'Queue risk scheduler started'
  );

  return {
    runOnce,
    stop: () => clearInterval(timer),
  };
}

