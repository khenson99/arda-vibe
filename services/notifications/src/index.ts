import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, createLogger } from '@arda/config';
import { correlationMiddleware, getCorrelationId } from '@arda/observability';
import { db, onAuditWritten } from '@arda/db';
import { sql } from 'drizzle-orm';
import { getEventBus, setupAuditEventPublishing, userActivityMiddleware } from '@arda/events';
import { authMiddleware } from '@arda/auth-utils';
import { notificationsRouter } from './routes/notifications.routes.js';
import { preferencesRouter } from './routes/preferences.routes.js';
import { unsubscribeRouter } from './routes/unsubscribe.routes.js';
import { gmailOauthRouter } from './routes/gmail-oauth.routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { startEventListener } from './services/event-listener.js';
import { createEmailQueue, createEmailWorker } from './workers/email-queue.worker.js';
import {
  createRetentionCleanupQueue,
  createRetentionCleanupWorker,
  scheduleRetentionCleanupJob,
} from './workers/retention-cleanup.worker.js';
import {
  createBounceRateMonitorQueue,
  createBounceRateMonitorWorker,
  scheduleBounceRateMonitorJob,
} from './workers/bounce-rate-monitor.worker.js';

const log = createLogger('notifications');

// Wire up audit.created event publishing for all writeAuditEntry calls
setupAuditEventPublishing('notifications', onAuditWritten, getCorrelationId);

const app = express();

app.use(helmet());
app.use(cors({ origin: config.APP_URL, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(correlationMiddleware('notifications'));

// ─── Health Check ─────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    await db.execute(sql`SELECT 1`);
    checks.database = 'ok';
  } catch {
    checks.database = 'down';
    healthy = false;
  }

  try {
    const eventBus = getEventBus(config.REDIS_URL);
    const redisPing = await eventBus.ping();
    checks.redis = redisPing ? 'ok' : 'down';
    if (!redisPing) healthy = false;
  } catch {
    checks.redis = 'down';
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'notifications',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// Public routes — no auth required (token-based verification)
app.use('/notifications', unsubscribeRouter);

// Authenticated routes — behind auth via the API gateway
app.use(authMiddleware);
app.use(userActivityMiddleware('notifications', getCorrelationId));
app.use('/notifications', notificationsRouter);
app.use('/preferences', preferencesRouter);
app.use('/gmail', gmailOauthRouter);

app.use(errorHandler);

const PORT = config.PORT || config.NOTIFICATIONS_SERVICE_PORT;
const server = app.listen(PORT, () => {
  log.info({ port: PORT }, 'Notifications service started');
});

// Start email queue and worker
const emailQueue = createEmailQueue(config.REDIS_URL);
const emailWorker = createEmailWorker(config.REDIS_URL);

// Start retention cleanup queue, worker, and schedule
const retentionCleanupQueue = createRetentionCleanupQueue(config.REDIS_URL);
const retentionCleanupWorker = createRetentionCleanupWorker(config.REDIS_URL);
scheduleRetentionCleanupJob(retentionCleanupQueue).catch((err) => {
  log.error({ err }, 'Failed to schedule retention cleanup job');
});

// Start bounce rate monitor queue, worker, and schedule
const bounceRateMonitorQueue = createBounceRateMonitorQueue(config.REDIS_URL);
const bounceRateMonitorWorker = createBounceRateMonitorWorker(config.REDIS_URL);
scheduleBounceRateMonitorJob(bounceRateMonitorQueue).catch((err) => {
  log.error({ err }, 'Failed to schedule bounce rate monitor job');
});

// Start event listener with dispatch context
startEventListener(config.REDIS_URL, { emailQueue }).catch((err) => {
  log.error({ err }, 'Failed to start event listener');
  process.exit(1);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  log.info({ signal }, 'Shutting down gracefully');

  const forceShutdownTimer = setTimeout(() => {
    log.fatal('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();

  await new Promise<void>((resolve) => {
    server.close(() => {
      log.info('HTTP server closed');
      resolve();
    });
  });

  try {
    await emailWorker.close();
    await emailQueue.close();
    log.info('Email queue and worker closed');
  } catch {
    // Queue/worker may not be fully initialized
  }

  try {
    await retentionCleanupWorker.close();
    await retentionCleanupQueue.close();
    log.info('Retention cleanup queue and worker closed');
  } catch {
    // Queue/worker may not be fully initialized
  }

  try {
    await bounceRateMonitorWorker.close();
    await bounceRateMonitorQueue.close();
    log.info('Bounce rate monitor queue and worker closed');
  } catch {
    // Queue/worker may not be fully initialized
  }

  try {
    const eventBus = getEventBus(config.REDIS_URL);
    await eventBus.shutdown();
    log.info('Event bus closed');
  } catch {
    // EventBus may not be initialized
  }

  clearTimeout(forceShutdownTimer);
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM').catch((err) => {
    log.error({ err }, 'Graceful shutdown failed');
    process.exit(1);
  });
});
process.on('SIGINT', () => {
  void shutdown('SIGINT').catch((err) => {
    log.error({ err }, 'Graceful shutdown failed');
    process.exit(1);
  });
});

export default app;
