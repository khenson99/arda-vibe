import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config, serviceUrls, createLogger } from '@arda/config';
import { authMiddleware } from '@arda/auth-utils';
import { getEventBus } from '@arda/events';

const log = createLogger('api-gateway');
import { db } from '@arda/db';
import { sql } from 'drizzle-orm';
import { itemsCompatRouter } from './routes/items-compat.routes.js';
import { kanbanCompatRouter } from './routes/kanban-compat.routes.js';
import { setupProxies } from './routes/proxy.js';
import { requestLogger } from './middleware/request-logger.js';
import { setupWebSocket } from './ws/socket-handler.js';

const app = express();

const allowedCorsOrigins = (config.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!allowedCorsOrigins.includes(config.APP_URL)) {
  allowedCorsOrigins.push(config.APP_URL);
}

// Trust the first proxy (Railway's reverse proxy) for correct client IPs
app.set('trust proxy', 1);

// ─── Global Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedCorsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use(limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many authentication attempts, please try again later' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);

// Logging
app.use(requestLogger);

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
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ─── Service Proxies ──────────────────────────────────────────────────
app.use('/api/items', express.json({ limit: '2mb' }), authMiddleware, itemsCompatRouter);
app.use('/api/kanban/loops', express.json({ limit: '2mb' }), authMiddleware, kanbanCompatRouter);
setupProxies(app);

// ─── 404 Handler ──────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Start Server ─────────────────────────────────────────────────────
const PORT = config.PORT || config.API_GATEWAY_PORT;
const server = createServer(app);

// Setup WebSocket handler (Socket.IO on /socket.io)
const io = setupWebSocket(server, config.REDIS_URL);

server.listen(PORT, () => {
  log.info({ port: PORT, services: serviceUrls }, 'API gateway started');
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

  await Promise.all([
    new Promise<void>((resolve) => {
      server.close(() => {
        log.info('HTTP server closed');
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      io.close(() => {
        log.info('WebSocket server closed');
        resolve();
      });
    }),
  ]);

  try {
    const eventBus = getEventBus(config.REDIS_URL);
    await eventBus.shutdown();
    log.info('Event bus closed');
  } catch {
    // EventBus may not have been initialized if no websocket consumers connected.
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
