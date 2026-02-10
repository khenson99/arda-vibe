/**
 * @arda/observability — Express integration helpers
 *
 * One-call setup for all observability middleware (Sentry, correlation IDs,
 * structured logging, Prometheus metrics) and a companion function to
 * register error handlers + the /metrics endpoint AFTER routes.
 *
 * -----------------------------------------------------------------------
 * Usage in a service's index.ts:
 *
 *   import express from 'express';
 *   import { setupObservability, addObservabilityErrorHandler } from '@arda/observability';
 *
 *   const app = express();
 *
 *   // 1. Call BEFORE any routes — installs correlation, logging, and metrics middleware
 *   setupObservability(app, {
 *     serviceName: 'kanban',
 *     sentryDsn: process.env.SENTRY_DSN,
 *   });
 *
 *   // 2. Register your routes
 *   app.use('/api/boards', boardRoutes);
 *
 *   // 3. Call AFTER all routes — installs Sentry error handler + /metrics endpoint
 *   addObservabilityErrorHandler(app);
 *
 *   app.listen(8080);
 *
 * -----------------------------------------------------------------------
 * Getting a logger:
 *
 *   import { getServiceLogger } from '@arda/observability';
 *   const logger = getServiceLogger('kanban');
 *   logger.info('Board created');
 *
 * -----------------------------------------------------------------------
 */

import type { Express, Request, Response, NextFunction } from 'express';
import type { Logger } from 'pino';

import { initSentry, captureException, isSentryInitialized } from './sentry.js';
import { correlationMiddleware } from './correlation.js';
import { createCorrelatedLogger, requestLoggingMiddleware } from './logging.js';
import { metricsMiddleware, metricsEndpoint } from './metrics.js';

/**
 * Options for {@link setupObservability}.
 */
export interface ObservabilityOptions {
  /** Unique name of the calling service (e.g. 'orders', 'kanban') */
  serviceName: string;
  /** Sentry DSN — if omitted or empty, Sentry initialization is skipped */
  sentryDsn?: string;
  /** Deployment environment (defaults to NODE_ENV or 'development') */
  environment?: string;
  /** Pino log level override (defaults to 'info' in prod, 'debug' otherwise) */
  logLevel?: string;
  /** Sentry traces sample rate 0-1 (default: 0.1) */
  tracesSampleRate?: number;
}

/**
 * Install all observability middleware on an Express app.
 *
 * Call this **before** registering any routes so that every request
 * gets a correlation ID, structured logging, and metric tracking.
 *
 * @param app  - Express application instance
 * @param opts - Configuration options
 * @returns A Pino logger configured for the service (same as {@link getServiceLogger})
 */
export function setupObservability(app: Express, opts: ObservabilityOptions): Logger {
  const environment = opts.environment ?? process.env.NODE_ENV ?? 'development';

  // --- Sentry (skip gracefully if no DSN) ---
  if (opts.sentryDsn) {
    initSentry({
      dsn: opts.sentryDsn,
      service: opts.serviceName,
      environment,
      tracesSampleRate: opts.tracesSampleRate,
    });
  }

  // --- Correlation IDs ---
  app.use(correlationMiddleware(opts.serviceName));

  // --- Structured request logging ---
  const logger = createCorrelatedLogger({
    service: opts.serviceName,
    level: opts.logLevel,
    environment,
  });
  app.use(requestLoggingMiddleware(logger));

  // --- Prometheus request metrics ---
  app.use(metricsMiddleware());

  return logger;
}

/**
 * Install error handlers and the Prometheus scrape endpoint.
 *
 * Call this **after** all routes have been registered so the Sentry
 * error handler can capture unhandled errors thrown from route handlers.
 *
 * @param app - Express application instance
 */
export function addObservabilityErrorHandler(app: Express): void {
  // --- Sentry error handler (only if Sentry was initialized) ---
  if (isSentryInitialized()) {
    // Express error-handling middleware requires the 4-param signature
    app.use((err: Error, _req: Request, _res: Response, next: NextFunction) => {
      captureException(err);
      next(err);
    });
  }

  // --- Prometheus metrics endpoint (unauthenticated — scraped by Prometheus) ---
  app.get('/metrics', metricsEndpoint());
}

/**
 * Create a correlated Pino logger for a given service.
 *
 * Convenience wrapper around {@link createCorrelatedLogger} that uses
 * sensible defaults (NODE_ENV-based log level, automatic correlation
 * ID injection via AsyncLocalStorage).
 *
 * @param serviceName - Name of the service
 * @param level       - Optional log level override
 * @returns A configured Pino logger instance
 */
export function getServiceLogger(serviceName: string, level?: string): Logger {
  return createCorrelatedLogger({
    service: serviceName,
    level,
    environment: process.env.NODE_ENV,
  });
}
