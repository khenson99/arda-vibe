import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from '@arda/config';
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { authRouter } from './routes/auth.routes.js';
import { tenantRouter } from './routes/tenant.routes.js';
import { errorHandler } from './middleware/error-handler.js';

const app = express();

// ─── Global Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: config.APP_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));

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

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'auth',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ─── Routes ───────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/tenants', tenantRouter);

// ─── Error Handler ────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────
const PORT = config.AUTH_SERVICE_PORT;
const server = app.listen(PORT, () => {
  console.log(`[auth-service] Running on port ${PORT}`);
  console.log(`[auth-service] Environment: ${config.NODE_ENV}`);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`[auth-service] ${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('[auth-service] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[auth-service] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
