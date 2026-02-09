import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, createLogger, getCorsOrigins } from '@arda/config';

const log = createLogger('auth');
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { authRouter } from './routes/auth.routes.js';
import { tenantRouter } from './routes/tenant.routes.js';
import { errorHandler } from './middleware/error-handler.js';

const app = express();

// ─── Global Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: getCorsOrigins(), credentials: true }));
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
const PORT = config.PORT || config.AUTH_SERVICE_PORT;
const server = app.listen(PORT, () => {
  log.info({ port: PORT, env: config.NODE_ENV }, 'Auth service started');
});

// ─── Graceful Shutdown ───────────────────────────────────────────────
function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down gracefully');
  server.close(() => {
    log.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    log.fatal('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
