import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from '@arda/config';
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { authMiddleware } from '@arda/auth-utils';
import { partsRouter } from './routes/parts.routes.js';
import { suppliersRouter } from './routes/suppliers.routes.js';
import { bomRouter } from './routes/bom.routes.js';
import { categoriesRouter } from './routes/categories.routes.js';
import { errorHandler } from './middleware/error-handler.js';

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

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'catalog',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// Routes — all are behind auth via the API gateway
app.use(authMiddleware);
app.use('/parts', partsRouter);
app.use('/suppliers', suppliersRouter);
app.use('/bom', bomRouter);
app.use('/categories', categoriesRouter);

app.use(errorHandler);

const PORT = config.CATALOG_SERVICE_PORT;
const server = app.listen(PORT, () => {
  console.log(`[catalog-service] Running on port ${PORT}`);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`[catalog-service] ${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('[catalog-service] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[catalog-service] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
