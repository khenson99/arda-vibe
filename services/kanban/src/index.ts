import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, createLogger } from '@arda/config';
import { correlationMiddleware, getCorrelationId } from '@arda/observability';

const log = createLogger('kanban');
import { db, onAuditWritten } from '@arda/db';
import { sql } from 'drizzle-orm';
import { authMiddleware } from '@arda/auth-utils';
import { setupAuditEventPublishing, userActivityMiddleware } from '@arda/events';
import { loopsRouter } from './routes/loops.routes.js';
import { cardsRouter } from './routes/cards.routes.js';
import { scanRouter } from './routes/scan.routes.js';
import { velocityRouter } from './routes/velocity.routes.js';
import { printJobsRouter } from './routes/print-jobs.routes.js';
import { lifecycleRouter } from './routes/lifecycle.routes.js';
import { cardTemplatesRouter } from './routes/card-templates.routes.js';
import { reloWisaRouter } from './routes/relowisa.routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { initScanDedupeManager, getScanDedupeManager } from './services/card-lifecycle.service.js';

// Wire up audit.created event publishing for all writeAuditEntry calls
setupAuditEventPublishing('kanban', onAuditWritten, getCorrelationId);

const app = express();

app.use(helmet());
app.use(cors({ origin: config.APP_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(correlationMiddleware('kanban'));

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
    service: 'kanban',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// Public scan endpoint (gateway allows /scan/* without auth)
app.use('/scan', scanRouter);

// Authenticated routes
app.use(authMiddleware);
app.use(userActivityMiddleware('kanban', getCorrelationId));
app.use('/loops', loopsRouter);
app.use('/loops', reloWisaRouter);
app.use('/cards', cardsRouter);
app.use('/velocity', velocityRouter);
app.use('/print-jobs', printJobsRouter);
app.use('/lifecycle', lifecycleRouter);
app.use('/card-templates', cardTemplatesRouter);

app.use(errorHandler);

const PORT = config.PORT || config.KANBAN_SERVICE_PORT;
const server = app.listen(PORT, () => {
  log.info({ port: PORT }, 'Kanban service started');

  // Initialize scan deduplication manager (non-blocking)
  if (config.REDIS_URL) {
    try {
      initScanDedupeManager(config.REDIS_URL);
    } catch (err) {
      log.warn({ err }, 'Failed to initialize ScanDedupeManager — dedupe disabled');
    }
  }
});

// ─── Graceful Shutdown ───────────────────────────────────────────────
async function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down gracefully');

  // Shutdown dedupe manager (closes Redis connection)
  try {
    await getScanDedupeManager()?.shutdown();
  } catch (err) {
    log.warn({ err }, 'Error shutting down ScanDedupeManager');
  }

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
