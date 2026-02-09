import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, createLogger } from '@arda/config';

const log = createLogger('orders');
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { authMiddleware } from '@arda/auth-utils';
import { purchaseOrdersRouter } from './routes/purchase-orders.routes.js';
import { workOrdersRouter } from './routes/work-orders.routes.js';
import { workCentersRouter } from './routes/work-centers.routes.js';
import { transferOrdersRouter } from './routes/transfer-orders.routes.js';
import { orderQueueRouter } from './routes/order-queue.routes.js';
import { auditRouter } from './routes/audit.routes.js';
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
    service: 'orders',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// Routes — all are behind auth via the API gateway
app.use(authMiddleware);
app.use('/purchase-orders', purchaseOrdersRouter);
app.use('/work-orders', workOrdersRouter);
app.use('/work-centers', workCentersRouter);
app.use('/transfer-orders', transferOrdersRouter);
app.use('/queue', orderQueueRouter);
app.use('/audit', auditRouter);

app.use(errorHandler);

const PORT = config.PORT || config.ORDERS_SERVICE_PORT;
const server = app.listen(PORT, () => {
  log.info({ port: PORT }, 'Orders service started');
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
