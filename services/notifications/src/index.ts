import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, createLogger } from '@arda/config';
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { getEventBus } from '@arda/events';
import { authMiddleware } from '@arda/auth-utils';
import { notificationsRouter } from './routes/notifications.routes.js';
import { deliveriesRouter } from './routes/deliveries.routes.js';
import { preferencesRouter } from './routes/preferences.routes.js';
import { unsubscribeRouter } from './routes/unsubscribe.routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { startEventListener } from './services/event-listener.js';
import { createEmailQueue, createEmailWorker } from './workers/email-queue.worker.js';

const log = createLogger('notifications');

const app = express();

app.use(helmet());
app.use(cors({ origin: config.APP_URL, credentials: true }));
app.use(express.json({ limit: '5mb' }));

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
app.use('/notifications', notificationsRouter);
app.use('/notifications', deliveriesRouter);
app.use('/preferences', preferencesRouter);

app.use(errorHandler);

const PORT = config.PORT || config.NOTIFICATIONS_SERVICE_PORT;
const server = app.listen(PORT, () => {
  log.info({ port: PORT }, 'Notifications service started');
});

// Start email queue and worker
const emailQueue = createEmailQueue(config.REDIS_URL);
const emailWorker = createEmailWorker(config.REDIS_URL);

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
