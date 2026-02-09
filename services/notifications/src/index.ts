import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from '@arda/config';
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { getEventBus } from '@arda/events';
import { authMiddleware } from '@arda/auth-utils';
import { notificationsRouter } from './routes/notifications.routes.js';
import { preferencesRouter } from './routes/preferences.routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { startEventListener } from './services/event-listener.js';

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

// Routes — all are behind auth via the API gateway
app.use(authMiddleware);
app.use('/notifications', notificationsRouter);
app.use('/preferences', preferencesRouter);

app.use(errorHandler);

const PORT = config.NOTIFICATIONS_SERVICE_PORT;
const server = app.listen(PORT, () => {
  console.log(`[notifications-service] Running on port ${PORT}`);
});

// Start event listener
startEventListener(config.REDIS_URL).catch((err) => {
  console.error('[notifications-service] Failed to start event listener:', err);
  process.exit(1);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`[notifications-service] ${signal} received, shutting down gracefully...`);

  server.close(() => {
    console.log('[notifications-service] HTTP server closed');
  });

  // Shutdown event bus (close Redis connections)
  try {
    const eventBus = getEventBus(config.REDIS_URL);
    void eventBus.shutdown().catch((err) => {
      console.error('[notifications-service] EventBus shutdown error:', err);
    });
  } catch {
    // EventBus may not be initialized
  }

  setTimeout(() => {
    console.error('[notifications-service] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
