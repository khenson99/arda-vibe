import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, createLogger } from '@arda/config';
import { correlationMiddleware, getCorrelationId } from '@arda/observability';

const log = createLogger('catalog');
import { db, onAuditWritten } from '@arda/db';
import { sql } from 'drizzle-orm';
import { authMiddleware } from '@arda/auth-utils';
import { setupAuditEventPublishing, userActivityMiddleware } from '@arda/events';
import { partsRouter } from './routes/parts.routes.js';
import { suppliersRouter } from './routes/suppliers.routes.js';
import { facilitiesRouter } from './routes/facilities.routes.js';
import { bomRouter } from './routes/bom.routes.js';
import { categoriesRouter } from './routes/categories.routes.js';
import { supplierPerformanceRouter } from './routes/supplier-performance.routes.js';
import { departmentsRouter } from './routes/departments.routes.js';
import { itemTypesRouter } from './routes/item-types.routes.js';
import { useCasesRouter } from './routes/use-cases.routes.js';
import { visibilityRouter } from './routes/visibility.routes.js';
import { errorHandler } from './middleware/error-handler.js';

// Wire up audit.created event publishing for all writeAuditEntry calls
setupAuditEventPublishing('catalog', onAuditWritten, getCorrelationId);

const app = express();

app.use(helmet());
app.use(cors({ origin: config.APP_URL, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(correlationMiddleware('catalog'));

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
app.use(userActivityMiddleware('catalog', getCorrelationId));
app.use('/parts', partsRouter);
app.use('/suppliers', suppliersRouter);
app.use('/facilities', facilitiesRouter);
app.use('/bom', bomRouter);
app.use('/categories', categoriesRouter);
app.use('/supplier-performance', supplierPerformanceRouter);
app.use('/departments', departmentsRouter);
app.use('/item-types', itemTypesRouter);
app.use('/use-cases', useCasesRouter);
app.use('/visibility', visibilityRouter);

app.use(errorHandler);

const PORT = config.PORT || config.CATALOG_SERVICE_PORT;
const server = app.listen(PORT, () => {
  log.info({ port: PORT }, 'Catalog service started');
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
