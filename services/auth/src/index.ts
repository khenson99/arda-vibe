import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, createLogger } from '@arda/config';

const log = createLogger('auth');
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { authRouter, handleGoogleLinkCallback } from './routes/auth.routes.js';
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
// Compatibility aliases for Google OAuth callbacks.
// These ensure callback URLs continue working across gateway/direct-host setups.
app.get('/api/auth/google/callback', handleGoogleLinkCallback);
app.get('/api/auth/google/link/callback', handleGoogleLinkCallback);
app.get('/auth/google/callback', handleGoogleLinkCallback);
app.get('/auth/google/link/callback', handleGoogleLinkCallback);

app.use('/auth', authRouter);
app.use('/api/auth', authRouter);
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
