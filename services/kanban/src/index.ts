import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, createLogger, getCorsOrigins } from '@arda/config';

const log = createLogger('kanban');
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { authMiddleware } from '@arda/auth-utils';
import { loopsRouter } from './routes/loops.routes.js';
import { cardsRouter } from './routes/cards.routes.js';
import { scanRouter } from './routes/scan.routes.js';
import { velocityRouter } from './routes/velocity.routes.js';
import { printJobsRouter } from './routes/print-jobs.routes.js';
import { lifecycleRouter } from './routes/lifecycle.routes.js';
import { errorHandler } from './middleware/error-handler.js';

const app = express();

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
    service: 'kanban',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// Public scan endpoint (gateway allows /scan/* without auth)
app.use('/scan', scanRouter);

// Authenticated routes
app.use(authMiddleware);
app.use('/loops', loopsRouter);
app.use('/cards', cardsRouter);
app.use('/velocity', velocityRouter);
app.use('/print-jobs', printJobsRouter);
app.use('/lifecycle', lifecycleRouter);

app.use(errorHandler);

const PORT = config.PORT || config.KANBAN_SERVICE_PORT;
const server = app.listen(PORT, () => {
  log.info({ port: PORT }, 'Kanban service started');
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
