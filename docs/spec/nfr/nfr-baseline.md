# Non-Functional Requirements Baseline

> **Document**: NFR Baseline v1.0
> **Status**: Draft
> **Last Updated**: 2026-02-08
> **Owner**: Platform Team
> **Related Issues**: #28, #39, #40

---

## Table of Contents

1. [Performance](#1-performance)
2. [Reliability](#2-reliability)
3. [Security](#3-security)
4. [Accessibility](#4-accessibility)
5. [Scalability](#5-scalability)
6. [Observability](#6-observability)
7. [NFR Validation Matrix](#7-nfr-validation-matrix)

---

## 1. Performance

### NFR-PERF-001: API Response Time

| Attribute | Value |
|---|---|
| **Metric** | Server-side request duration measured from request received to response sent |
| **Target (MVP)** | p50 < 100ms, p95 < 300ms, p99 < 1s |
| **Target (Post-MVP)** | p50 < 50ms, p95 < 200ms, p99 < 500ms |
| **Measurement** | Prometheus `http_request_duration_seconds` histogram per service |
| **Validation** | k6 load test with 100 concurrent virtual users for 5 minutes; assert percentile thresholds |
| **Exclusions** | File upload/download endpoints, report generation, data export endpoints |
| **Owner** | Backend Team (all 6 services) |

### NFR-PERF-002: Page Load Time

| Attribute | Value |
|---|---|
| **Metric** | Core Web Vitals measured via Lighthouse and real-user monitoring |
| **Target (MVP)** | First Contentful Paint (FCP) < 1.5s, Largest Contentful Paint (LCP) < 2.5s |
| **Target (Post-MVP)** | FCP < 1.0s, LCP < 2.0s, Cumulative Layout Shift (CLS) < 0.1 |
| **Measurement** | Lighthouse CI in CI/CD pipeline; Sentry Performance monitoring in production |
| **Validation** | Lighthouse CI assertions on every PR merge to main; weekly Lighthouse audit report |
| **Conditions** | Measured on 4G throttled connection (Lighthouse default), empty cache |
| **Owner** | Frontend Team (apps/web) |

### NFR-PERF-003: WebSocket Event Delivery

| Attribute | Value |
|---|---|
| **Metric** | Time from event emission (service publish to Redis) to client receipt (browser `onmessage`) |
| **Target (MVP)** | < 500ms end-to-end for 95th percentile |
| **Target (Post-MVP)** | < 200ms end-to-end for 95th percentile |
| **Measurement** | Custom timing: event includes `emittedAt` timestamp; client records `receivedAt`; difference reported to Sentry |
| **Validation** | Integration test: emit 1000 events over 60s, verify 95th percentile delivery time |
| **Owner** | Backend Team (notifications service, api-gateway WebSocket proxy) |

### NFR-PERF-004: Database Query Time

| Attribute | Value |
|---|---|
| **Metric** | Query execution time measured via Drizzle query logger / pg_stat_statements |
| **Target (MVP)** | < 50ms for indexed single-row lookups, < 200ms for aggregation queries |
| **Target (Post-MVP)** | < 30ms indexed lookups, < 100ms aggregations |
| **Measurement** | Drizzle custom logger wrapping query execution; `pg_stat_statements` extension for production |
| **Validation** | Explain-analyze on all query patterns; integration test assertions on query timing |
| **Slow Query Threshold** | Log warning at > 200ms, log error at > 1s |
| **Owner** | Data Team (packages/db) |

### NFR-PERF-005: Concurrent User Capacity

| Attribute | Value |
|---|---|
| **Metric** | Number of simultaneous authenticated users maintaining < p95 300ms API response |
| **Target (MVP)** | 100 concurrent users per tenant, 1000 total across all tenants |
| **Target (Post-MVP)** | 500 per tenant, 5000 total |
| **Measurement** | k6 load test simulating realistic user journeys (browse catalog, manage orders, use kanban) |
| **Validation** | Weekly load test in staging; capacity validated before each major release |
| **Owner** | Platform Team |

### NFR-PERF-006: Background Job Throughput

| Attribute | Value |
|---|---|
| **Metric** | Jobs processed per minute by BullMQ workers |
| **Target (MVP)** | 500 jobs/min sustained, < 30s queue wait time at p95 |
| **Target (Post-MVP)** | 2000 jobs/min sustained, < 10s queue wait time at p95 |
| **Measurement** | BullMQ built-in metrics; Prometheus exporter for queue depth, processing time, failure rate |
| **Validation** | Load test: enqueue 5000 jobs, measure drain time and error rate |
| **Owner** | Backend Team (orders service, notifications service) |

---

## 2. Reliability

### NFR-REL-001: Service Uptime

| Attribute | Value |
|---|---|
| **Metric** | Percentage of time services respond to health checks successfully |
| **Target (MVP)** | 99.5% monthly uptime (allows ~3.6 hours downtime/month) |
| **Target (Post-MVP)** | 99.9% monthly uptime (allows ~43 minutes downtime/month) |
| **Measurement** | External uptime monitor (e.g., Better Uptime, Checkly) pinging `/health` every 30s |
| **Validation** | Monthly uptime report; alert when error budget < 50% remaining |
| **Maintenance Windows** | Excluded from uptime calculation if announced 24h in advance |
| **Owner** | Platform Team |

### NFR-REL-002: Recovery Time Objective (RTO)

| Attribute | Value |
|---|---|
| **Metric** | Time from incident detection to full service restoration |
| **Target (MVP)** | < 30 minutes |
| **Target (Post-MVP)** | < 15 minutes |
| **Measurement** | Incident response timestamps in post-mortem reports |
| **Validation** | Quarterly disaster recovery drill; simulate database failover, Redis restart, service crash |
| **Runbook** | Documented in `docs/runbooks/disaster-recovery.md` |
| **Owner** | Platform Team |

### NFR-REL-003: Recovery Point Objective (RPO)

| Attribute | Value |
|---|---|
| **Metric** | Maximum acceptable data loss measured in time |
| **Target (MVP)** | < 5 minutes (continuous WAL archiving for PostgreSQL) |
| **Target (Post-MVP)** | < 1 minute (streaming replication) |
| **Measurement** | Gap between last committed transaction and recovery point after failover test |
| **Validation** | Monthly backup restoration test; verify data integrity post-restore |
| **Owner** | Data Team |

### NFR-REL-004: Zero Data Loss for Critical Records

| Attribute | Value |
|---|---|
| **Metric** | Audit log entries and financial records must never be lost or corrupted |
| **Target** | Zero data loss — applies to both MVP and post-MVP |
| **Scope** | `audit.audit_logs` table, all `orders.*` financial tables, `billing.*` tables |
| **Measurement** | Checksums on audit log inserts; reconciliation job comparing event count vs audit row count |
| **Validation** | Integration test: crash service mid-transaction, verify audit record either committed or absent (no partial writes) |
| **Owner** | Backend Team (orders service), Data Team |

### NFR-REL-005: Redis Degradation Resilience

| Attribute | Value |
|---|---|
| **Metric** | Services remain functional (degraded mode) when Redis is unavailable |
| **Target** | All services respond to API requests within 2x normal latency when Redis is down |
| **Degraded Behavior** | WebSocket events queued in-memory (bounded buffer, 1000 events max); rate limiting falls back to in-process token bucket; BullMQ jobs paused until reconnect |
| **Measurement** | Integration test: stop Redis, verify API endpoints still respond; verify reconnection and queue drain on Redis restart |
| **Validation** | Chaos test: kill Redis for 5 minutes during load test; verify no 500 errors on core API endpoints |
| **Owner** | Backend Team |

### NFR-REL-006: Database Connection Resilience

| Attribute | Value |
|---|---|
| **Metric** | Service recovery after database connection pool exhaustion |
| **Target** | Recover within 30s of connections becoming available; no permanent connection leaks |
| **Mechanism** | Connection pool with min=2, max=20; idle timeout=30s; connection retry with exponential backoff |
| **Measurement** | Pool metrics exposed via Prometheus: active, idle, waiting, total connections |
| **Validation** | Load test exceeding pool capacity; verify graceful queuing and recovery |
| **Owner** | Data Team (packages/db) |

---

## 3. Security

### NFR-SEC-001: Authentication Coverage

| Attribute | Value |
|---|---|
| **Metric** | Percentage of API endpoints requiring valid JWT authentication |
| **Target** | 100% of endpoints authenticated, with explicit allowlist for public endpoints |
| **Public Endpoints** | `/health`, `/scan/:id` (GET only), `/api/auth/login`, `/api/auth/register`, `/api/auth/refresh`, `/api/auth/forgot-password` |
| **Measurement** | Automated route audit script that compares registered routes against auth middleware |
| **Validation** | CI check: route scanner fails build if unauthenticated endpoint not in allowlist |
| **Owner** | Backend Team (auth service, api-gateway) |

### NFR-SEC-002: Token Security

| Attribute | Value |
|---|---|
| **Metric** | JWT token configuration adhering to security best practices |
| **Target** | Access token: 15 min TTL. Refresh token: 7 day TTL. Tokens signed with RS256 (post-MVP) or HS256 (MVP). Refresh tokens stored in HttpOnly, Secure, SameSite=Strict cookies |
| **Measurement** | Unit test: verify token expiry, decode payload, confirm no sensitive data in payload |
| **Validation** | Security audit: verify token cannot be reused after expiry; verify refresh rotation (old refresh token invalidated on use) |
| **Owner** | Backend Team (auth service) |

### NFR-SEC-003: Password Security

| Attribute | Value |
|---|---|
| **Metric** | Password hashing strength and policy enforcement |
| **Target** | bcrypt with minimum 10 salt rounds; passwords minimum 8 characters, must include uppercase, lowercase, number |
| **Measurement** | Unit test: verify hash timing > 100ms (confirms adequate rounds); verify password policy rejection |
| **Validation** | Attempt login with common passwords; verify rate limiting prevents brute force |
| **Owner** | Backend Team (auth service) |

### NFR-SEC-004: Tenant Isolation

| Attribute | Value |
|---|---|
| **Metric** | All database queries scoped by `tenantId`; no cross-tenant data access possible |
| **Target** | 100% of queries include tenant scope; verified by automated query analysis |
| **Measurement** | Drizzle query interceptor that logs/rejects queries missing `tenantId` WHERE clause in non-system tables |
| **Validation** | Integration test: authenticate as tenant A, attempt to read tenant B data, verify 403/404; automated SQL analysis in CI |
| **Owner** | Data Team, Backend Team (all services) |

### NFR-SEC-005: Rate Limiting

| Attribute | Value |
|---|---|
| **Metric** | Request rate limits per client/endpoint category |
| **Target** | Standard endpoints: 100 req/min per IP. Auth endpoints: 30 req/min per IP. Scan endpoints: 10 req/min per IP |
| **Measurement** | Rate limiter middleware with Redis-backed sliding window; metrics exported to Prometheus |
| **Validation** | Integration test: exceed rate limit, verify 429 response with Retry-After header |
| **Owner** | Backend Team (api-gateway) |

### NFR-SEC-006: CORS Policy

| Attribute | Value |
|---|---|
| **Metric** | Cross-origin requests restricted to authorized origins |
| **Target** | Only `APP_URL` environment variable origin allowed; no wildcard `*` in production |
| **Measurement** | Automated test: send request with unauthorized Origin header, verify rejection |
| **Validation** | Security audit; browser DevTools verification in staging |
| **Owner** | Backend Team (api-gateway) |

### NFR-SEC-007: Input Validation

| Attribute | Value |
|---|---|
| **Metric** | All API inputs validated before processing |
| **Target** | 100% of endpoints have Zod schema validation on request body, query params, and path params |
| **Measurement** | CI check: route scanner verifies every route handler has validation middleware |
| **Validation** | Fuzz testing with malformed inputs; verify no unvalidated data reaches business logic |
| **Owner** | Backend Team (all services) |

### NFR-SEC-008: SQL Injection Prevention

| Attribute | Value |
|---|---|
| **Metric** | Zero SQL injection vulnerabilities |
| **Target** | All database queries use Drizzle ORM parameterized queries; no raw SQL string concatenation |
| **Measurement** | Static analysis: grep for `sql.raw`, `sql.unsafe`, string template literals in query context |
| **Validation** | OWASP ZAP scan; manual penetration test on auth and search endpoints |
| **Owner** | Data Team, Backend Team |

### NFR-SEC-009: OWASP Top 10 Compliance

| Attribute | Value |
|---|---|
| **Metric** | No critical or high vulnerabilities from OWASP Top 10 categories |
| **Target** | Pass OWASP ZAP baseline scan with zero high/critical findings |
| **Categories** | A01:Broken Access Control, A02:Cryptographic Failures, A03:Injection, A04:Insecure Design, A05:Security Misconfiguration, A06:Vulnerable Components, A07:Auth Failures, A08:Data Integrity, A09:Logging Failures, A10:SSRF |
| **Measurement** | OWASP ZAP automated scan in CI; `npm audit` for dependency vulnerabilities |
| **Validation** | Pre-launch security audit; quarterly OWASP ZAP scan |
| **Owner** | Platform Team, Security Lead |

### NFR-SEC-010: Dependency Security

| Attribute | Value |
|---|---|
| **Metric** | No known critical/high CVEs in production dependencies |
| **Target** | Zero critical CVEs; high CVEs remediated within 7 days |
| **Measurement** | `npm audit` in CI pipeline; GitHub Dependabot alerts |
| **Validation** | CI fails on critical audit findings; weekly dependency review |
| **Owner** | Platform Team |

---

## 4. Accessibility

### NFR-A11Y-001: WCAG 2.1 AA Compliance

| Attribute | Value |
|---|---|
| **Metric** | Conformance to WCAG 2.1 Level AA success criteria |
| **Target (MVP)** | All critical user flows pass Level AA (login, catalog browse, order management, kanban) |
| **Target (Post-MVP)** | Full application Level AA compliance |
| **Measurement** | axe-core automated scan in CI; manual testing with screen readers |
| **Validation** | Lighthouse Accessibility score >= 90; zero axe-core violations on critical pages |
| **Owner** | Frontend Team |

### NFR-A11Y-002: Keyboard Navigation

| Attribute | Value |
|---|---|
| **Metric** | All interactive elements reachable and operable via keyboard |
| **Target** | Tab order follows logical reading order; focus indicators visible; no keyboard traps |
| **Measurement** | Manual testing: complete all critical flows using only keyboard |
| **Validation** | QA checklist for each feature: login, navigation, forms, modals, drag-and-drop (with keyboard alternative) |
| **Owner** | Frontend Team |

### NFR-A11Y-003: Screen Reader Compatibility

| Attribute | Value |
|---|---|
| **Metric** | All content and interactive elements announced correctly by screen readers |
| **Target** | ARIA labels on all interactive elements; landmark regions defined; dynamic content changes announced via live regions |
| **Measurement** | Testing with VoiceOver (macOS) and NVDA (Windows) |
| **Validation** | Screen reader testing on critical flows before each release |
| **Owner** | Frontend Team |

### NFR-A11Y-004: Color Contrast

| Attribute | Value |
|---|---|
| **Metric** | Text color contrast ratio against background |
| **Target** | Minimum 4.5:1 for normal text, 3:1 for large text (18px+ or 14px+ bold) |
| **Measurement** | axe-core contrast checks; Figma plugin contrast analysis |
| **Validation** | CI: axe-core fails build on contrast violations; design review checklist |
| **Owner** | Frontend Team, Design |

---

## 5. Scalability

### NFR-SCALE-001: Horizontal Service Scaling

| Attribute | Value |
|---|---|
| **Metric** | Services scale horizontally without code changes |
| **Target** | Each service runs as stateless container; 2+ replicas in production |
| **Mechanism** | Docker containers on Railway; no local file system state; JWT auth (no sticky sessions) |
| **Measurement** | Deploy 3 replicas per service; verify round-robin load balancing works correctly |
| **Validation** | Scale test: increase replicas from 1 to 3 under load; verify zero errors during scale-up |
| **Owner** | Platform Team |

### NFR-SCALE-002: Database Connection Pooling

| Attribute | Value |
|---|---|
| **Metric** | Efficient PostgreSQL connection usage across service replicas |
| **Target** | Connection pool per service replica: min=2, max=20; total connections < PostgreSQL max_connections (default 100) |
| **Mechanism** | Drizzle ORM with `postgres.js` connection pooling; connection limits per service configured via environment variables |
| **Measurement** | `pg_stat_activity` monitoring; Prometheus metrics for pool utilization |
| **Validation** | Load test: verify connection count stays within limits; verify queries queue rather than fail when pool exhausted |
| **Owner** | Data Team |

### NFR-SCALE-003: Redis Pub/Sub Scalability

| Attribute | Value |
|---|---|
| **Metric** | Event throughput and subscriber scalability |
| **Target (MVP)** | 1000 events/sec publish throughput; 100 concurrent WebSocket subscribers |
| **Target (Post-MVP)** | 10,000 events/sec; 1000 subscribers (requires Redis Cluster or managed Redis) |
| **Measurement** | Redis `INFO` stats; custom publish/subscribe latency metrics |
| **Validation** | Load test: publish 1000 events/sec for 5 minutes; verify all subscribers receive all events |
| **Owner** | Backend Team (events package, notifications service) |

### NFR-SCALE-004: Stateless Service Design

| Attribute | Value |
|---|---|
| **Metric** | No server-side session state; all state in JWT, database, or Redis |
| **Target** | Zero in-memory user state between requests |
| **Measurement** | Code audit: grep for global mutable state, in-memory caches without TTL |
| **Validation** | Kill and restart any service replica; verify next request succeeds without re-authentication |
| **Owner** | Backend Team |

### NFR-SCALE-005: Multi-Tenant Data Isolation at Scale

| Attribute | Value |
|---|---|
| **Metric** | Query performance does not degrade as tenant count increases |
| **Target** | Query time remains within NFR-PERF-004 targets with 100 tenants and 1M rows per tenant |
| **Mechanism** | Composite indexes on `(tenant_id, <primary_filter>)` for all tenant-scoped tables |
| **Measurement** | Benchmark queries against test database with simulated scale data |
| **Validation** | Load test with 50 concurrent tenants each running typical query patterns |
| **Owner** | Data Team |

---

## 6. Observability

### NFR-OBS-001: Structured Logging

| Attribute | Value |
|---|---|
| **Metric** | All service logs in structured JSON format with consistent fields |
| **Target** | Every log entry includes: `timestamp`, `level`, `service`, `requestId`, `tenantId` (if applicable), `message` |
| **Measurement** | Log format validation in CI; log aggregation in production (Railway logs or external) |
| **Validation** | Parse 1000 random log lines; verify 100% valid JSON with required fields |
| **Owner** | Backend Team (all services) |

### NFR-OBS-002: Error Tracking

| Attribute | Value |
|---|---|
| **Metric** | All unhandled errors captured with context |
| **Target** | Sentry integration on all services and frontend; error grouped by type; alert on new error types |
| **Measurement** | Sentry dashboard: error count, unique issues, resolution time |
| **Validation** | Trigger known error; verify appears in Sentry within 30s with full stack trace and request context |
| **Owner** | Platform Team |

### NFR-OBS-003: Metrics Collection

| Attribute | Value |
|---|---|
| **Metric** | Business and infrastructure metrics available for dashboarding |
| **Target** | Prometheus metrics endpoint (`/metrics`) on every service; Grafana dashboards for key metrics |
| **Key Metrics** | Request rate, error rate, latency percentiles, active connections, queue depth, cache hit rate |
| **Measurement** | Grafana dashboard shows all key metrics with < 30s delay |
| **Validation** | Load test: verify metrics accurately reflect actual traffic patterns |
| **Owner** | Platform Team |

### NFR-OBS-004: Health Checks

| Attribute | Value |
|---|---|
| **Metric** | Every service exposes health check endpoint with dependency status |
| **Target** | `/health` returns 200 with `{ status, version, uptime, dependencies: { db, redis, ... } }` |
| **Measurement** | External monitor polling every 30s; alert on 3 consecutive failures |
| **Validation** | Stop database; verify `/health` returns degraded status; verify alert fires |
| **Owner** | Backend Team (all services) |

---

## 7. NFR Validation Matrix

Summary of how each NFR category will be validated:

| Category | Automated CI | Load Test | Manual Audit | Monitoring | Frequency |
|---|---|---|---|---|---|
| Performance | Lighthouse CI | k6 weekly | - | Sentry, Prometheus | Continuous |
| Reliability | - | Chaos test quarterly | DR drill quarterly | Uptime monitor | Continuous |
| Security | Route audit, npm audit, ZAP | - | Pen test pre-launch | Dependabot | Per-PR + quarterly |
| Accessibility | axe-core | - | Screen reader test | - | Per-PR + per-release |
| Scalability | - | Scale test monthly | Architecture review | Pool/connection metrics | Monthly |
| Observability | Log format check | - | Dashboard review | Self-monitoring | Per-PR + weekly |

---

## Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-02-08 | Product Lane Agent | Initial baseline |
