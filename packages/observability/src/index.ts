/**
 * @arda/observability — Observability framework
 *
 * Provides error tracking (Sentry), metrics (Prometheus),
 * request correlation, and structured logging for all Arda services.
 */

// Sentry
export {
  initSentry,
  captureException,
  addBreadcrumb,
  setUser,
  flushSentry,
  isSentryInitialized,
  _resetSentry,
  type SentryOptions,
} from './sentry.js';

// Metrics
export {
  httpRequestDuration,
  activeConnections,
  httpRequestsTotal,
  httpRequestSize,
  jobProcessingDuration,
  dbQueryDuration,
  metricsMiddleware,
  metricsEndpoint,
  getRegistry,
  resetMetrics,
} from './metrics.js';

// Correlation
export {
  correlationMiddleware,
  getCorrelationContext,
  getCorrelationId,
  getCorrelationHeaders,
  CORRELATION_HEADER,
  SERVICE_HEADER,
  type CorrelationContext,
} from './correlation.js';

// Logging
export {
  createCorrelatedLogger,
  requestLoggingMiddleware,
  type CorrelatedLoggerOptions,
} from './logging.js';

// Express integration
export {
  setupObservability,
  addObservabilityErrorHandler,
  getServiceLogger,
  type ObservabilityOptions,
} from './express-setup.js';
