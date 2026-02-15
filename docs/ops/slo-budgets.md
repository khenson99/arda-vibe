# SLO Budgets — Latency & Reliability Contracts

> **Version**: 1.0.0
> **Status**: Active
> **Last Updated**: 2026-02-14
> **Owner**: Platform Team
> **Review Cadence**: Monthly (first Monday)
> **Related Issues**: #284, #28, #39, #40
> **Spec Reference**: `docs/spec/nfr/nfr-baseline.md`

---

## Table of Contents

1. [Overview](#1-overview)
2. [Workflow SLOs (FR-01, FR-02, FR-03)](#2-workflow-slos)
3. [API Category SLOs](#3-api-category-slos)
4. [Error Rate Budgets](#4-error-rate-budgets)
5. [Background Job SLOs](#5-background-job-slos)
6. [WebSocket Event SLOs](#6-websocket-event-slos)
7. [Database Query SLOs](#7-database-query-slos)
8. [Measurement Points](#8-measurement-points)
9. [Prometheus Metric Label Guidance](#9-prometheus-metric-label-guidance)
10. [CI Performance Gate Contract](#10-ci-performance-gate-contract)
11. [k6 Threshold Mapping](#11-k6-threshold-mapping)
12. [Budget Ownership & Review Process](#12-budget-ownership--review-process)
13. [Revision History](#13-revision-history)

---

## 1. Overview

This document is the **single source of truth** for all latency and reliability SLO budgets in Arda V2. It codifies the performance contracts that load tests, CI gates, and production alerting enforce.

**Guiding principles:**

- SLOs are defined once here and consumed by `tests/load/thresholds.json` for k6/CI.
- Prometheus metric names and label values align with `packages/observability/src/metrics.ts`.
- Every threshold has a clear owner, measurement point, and review cadence.
- Exceeding a p95 budget in CI **fails** the performance gate. Exceeding a p99 budget produces a **warning**.

**Scope:**

| Requirement | Workflow | Description |
|---|---|---|
| **FR-01** | Catalog & Inventory | Part lookup, search, inventory queries |
| **FR-02** | Kanban Loop Management | Card transitions, queue scans, risk scans, loop operations |
| **FR-03** | Order Management | PO/WO/TO creation, order conversion, order queue listing |

---

## 2. Workflow SLOs

### FR-01: Catalog & Inventory

| Metric | p50 | p95 | p99 | Measurement |
|---|---|---|---|---|
| Part lookup (GET by ID) | < 50 ms | < 150 ms | < 500 ms | `http_request_duration_seconds{route="/api/catalog/parts/:id"}` |
| Part search (GET list) | < 100 ms | < 250 ms | < 800 ms | `http_request_duration_seconds{route="/api/catalog/parts"}` |
| Part create/update | < 100 ms | < 300 ms | < 1000 ms | `http_request_duration_seconds{route="/api/catalog/parts",method="POST\|PUT"}` |
| Inventory query | < 80 ms | < 200 ms | < 600 ms | `http_request_duration_seconds{route="/api/catalog/inventory"}` |
| Supplier lookup | < 50 ms | < 150 ms | < 500 ms | `http_request_duration_seconds{route="/api/catalog/suppliers/:id"}` |

### FR-02: Kanban Loop Management

| Metric | p50 | p95 | p99 | Measurement |
|---|---|---|---|---|
| Card transition | < 80 ms | < 200 ms | < 600 ms | `http_request_duration_seconds{route="/api/kanban/cards/:id/transition"}` |
| Queue scan | < 100 ms | < 200 ms | < 800 ms | `http_request_duration_seconds{route="/api/kanban/order-queue"}` |
| Risk scan | < 150 ms | < 300 ms | < 1000 ms | `http_request_duration_seconds{route="/api/kanban/*/risk-scan"}` |
| Loop list | < 60 ms | < 150 ms | < 500 ms | `http_request_duration_seconds{route="/api/kanban/loops"}` |
| Card detail | < 50 ms | < 150 ms | < 500 ms | `http_request_duration_seconds{route="/api/kanban/cards/:id"}` |
| Scan endpoint (public) | < 80 ms | < 200 ms | < 600 ms | `http_request_duration_seconds{route="/scan/:id"}` |

### FR-03: Order Management

| Metric | p50 | p95 | p99 | Measurement |
|---|---|---|---|---|
| Order queue list | < 100 ms | < 200 ms | < 800 ms | `http_request_duration_seconds{route="/api/orders/order-queue"}` |
| PO creation | < 100 ms | < 250 ms | < 800 ms | `http_request_duration_seconds{route="/api/orders/purchase-orders",method="POST"}` |
| WO creation | < 100 ms | < 250 ms | < 800 ms | `http_request_duration_seconds{route="/api/orders/work-orders",method="POST"}` |
| TO creation | < 100 ms | < 250 ms | < 800 ms | `http_request_duration_seconds{route="/api/orders/transfer-orders",method="POST"}` |
| Order conversion | < 80 ms | < 150 ms | < 500 ms | `http_request_duration_seconds{route="/api/orders/*/convert"}` |
| Order detail (GET by ID) | < 50 ms | < 150 ms | < 500 ms | `http_request_duration_seconds{route="/api/orders/*-orders/:id"}` |
| Order list (paginated) | < 100 ms | < 250 ms | < 800 ms | `http_request_duration_seconds{route="/api/orders/*-orders",method="GET"}` |

---

## 3. API Category SLOs

Endpoints are grouped into categories for threshold enforcement. Each category maps to a k6 tag (`api_category`) applied in load test scenarios.

| Category | Tag Value | p95 Target | p99 Target | Error Budget | Description |
|---|---|---|---|---|---|
| **Read (single)** | `read_single` | < 150 ms | < 500 ms | < 0.5% | GET by ID lookups |
| **Read (list)** | `read_list` | < 250 ms | < 800 ms | < 0.5% | Paginated list queries, search |
| **Write** | `write` | < 300 ms | < 1000 ms | < 0.5% | POST, PUT, PATCH, DELETE |
| **Workflow (transition)** | `workflow_transition` | < 200 ms | < 600 ms | < 0.5% | State transitions, conversions |
| **Background scan** | `background_scan` | < 300 ms | < 1000 ms | < 1.0% | Risk scans, queue scans |
| **Auth** | `auth` | < 200 ms | < 600 ms | < 0.5% | Login, register, token refresh |
| **Health** | `health` | < 50 ms | < 150 ms | < 0.1% | /health endpoints |

### Endpoint-to-Category Mapping

| Route Pattern | Method | Category |
|---|---|---|
| `/api/catalog/parts/:id` | GET | `read_single` |
| `/api/kanban/cards/:id` | GET | `read_single` |
| `/api/orders/*-orders/:id` | GET | `read_single` |
| `/api/catalog/suppliers/:id` | GET | `read_single` |
| `/api/catalog/parts` | GET | `read_list` |
| `/api/kanban/loops` | GET | `read_list` |
| `/api/orders/order-queue` | GET | `read_list` |
| `/api/orders/*-orders` | GET | `read_list` |
| `/api/notifications` | GET | `read_list` |
| `/api/catalog/parts` | POST, PUT | `write` |
| `/api/orders/*-orders` | POST, PUT, PATCH | `write` |
| `/api/kanban/cards/:id/transition` | POST | `workflow_transition` |
| `/api/orders/*/:id/convert` | POST | `workflow_transition` |
| `/api/kanban/*/risk-scan` | POST | `background_scan` |
| `/api/orders/order-queue` | POST | `background_scan` |
| `/api/auth/*` | POST | `auth` |
| `/health` | GET | `health` |
| `/scan/:id` | GET | `read_single` |

---

## 4. Error Rate Budgets

| Scope | Metric | Budget | Enforcement |
|---|---|---|---|
| **Global (all endpoints)** | 5xx responses / total responses | < 0.5% | CI gate fails at >= 0.5% |
| **Per API category** | 5xx responses / total for category | < 1.0% | CI gate fails at >= 1.0% |
| **Auth endpoints** | 5xx responses / total auth requests | < 0.5% | CI gate fails at >= 0.5% |
| **Health endpoints** | Non-200 responses / total health | < 0.1% | CI gate fails at >= 0.1% |

### Error Budget Prometheus Query

```promql
# Global 5xx rate
sum(rate(http_requests_total{status_code=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m]))
```

---

## 5. Background Job SLOs

| Job Type | Queue | p95 Processing | p99 Processing | Max Queue Wait (p95) |
|---|---|---|---|---|
| Automation actions | `automation` | < 5s | < 15s | < 30s |
| Order aging check | `order-aging` | < 3s | < 10s | < 30s |
| Relowisa recalc | `relowisa-recalc` | < 5s | < 15s | < 30s |
| Stale card cleanup | `stale-card-cleanup` | < 10s | < 30s | < 60s |
| Data export | `data-export` | < 60s | < 120s | < 120s |
| Notifications | `notifications` | < 2s | < 5s | < 10s |

**Measurement**: `job_processing_duration_seconds{queue, job_type}`

---

## 6. WebSocket Event SLOs

| Metric | p95 | p99 | Measurement |
|---|---|---|---|
| Event delivery (publish to client receipt) | < 500 ms | < 1500 ms | Custom `event_delivery_duration_seconds` |
| Redis pub/sub latency | < 50 ms | < 200 ms | `redis_pubsub_latency_seconds` |

**Note**: Aligns with NFR-PERF-003 from `docs/spec/nfr/nfr-baseline.md`.

---

## 7. Database Query SLOs

| Query Type | p95 | p99 | Measurement |
|---|---|---|---|
| Indexed single-row lookup | < 50 ms | < 150 ms | `db_query_duration_seconds{operation="select"}` |
| Aggregation queries | < 200 ms | < 500 ms | `db_query_duration_seconds{operation="aggregate"}` |
| Insert / Update | < 100 ms | < 300 ms | `db_query_duration_seconds{operation="insert\|update"}` |
| Complex joins | < 300 ms | < 800 ms | `db_query_duration_seconds{operation="join"}` |

**Note**: Aligns with NFR-PERF-004 from `docs/spec/nfr/nfr-baseline.md`.

---

## 8. Measurement Points

All latency is measured **server-side** using the `http_request_duration_seconds` histogram from `packages/observability/src/metrics.ts`.

```
Client --> API Gateway --> Upstream Service --> Response
            |                |                |
            |                +-- START timer   |
            |                |  (metricsMiddleware)
            |                |                |
            |                +-- STOP timer ---+
            |                |  (res.on('finish'))
            |                |
            v                v
     Gateway overhead    Measured duration
     (NOT included)      (IS the SLO target)
```

**What IS measured** (included in SLO):
- Request parsing and validation (Zod schemas)
- Business logic execution
- Database queries (Drizzle ORM)
- Redis operations (cache, pub/sub)
- Response serialization

**What is NOT measured** (excluded from SLO):
- Network latency between client and API Gateway
- API Gateway proxy overhead
- TLS handshake time
- Client-side rendering

---

## 9. Prometheus Metric Label Guidance

To ensure consistent metrics that align with SLO thresholds and k6 scenarios, all services MUST use these label conventions.

### Required Labels

| Metric | Label | Values | Notes |
|---|---|---|---|
| `http_request_duration_seconds` | `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | Uppercase HTTP method |
| `http_request_duration_seconds` | `route` | Normalized route pattern | Use `:id` placeholders, never raw UUIDs |
| `http_request_duration_seconds` | `status_code` | `200`, `201`, `400`, `401`, `404`, `500`, etc. | String, not integer |
| `http_requests_total` | `method` | Same as above | |
| `http_requests_total` | `route` | Same as above | |
| `http_requests_total` | `status_code` | Same as above | |
| `job_processing_duration_seconds` | `queue` | Queue name: `automation`, `order-aging`, etc. | Lowercase, hyphenated |
| `job_processing_duration_seconds` | `job_type` | Job type within queue | Lowercase, hyphenated |
| `db_query_duration_seconds` | `operation` | `select`, `insert`, `update`, `delete`, `aggregate`, `join` | Lowercase |
| `db_query_duration_seconds` | `table` | Schema-qualified table name: `orders.purchase_orders` | Lowercase, dot-separated |

### Route Normalization Rules

The `normalizeRoute()` function in `packages/observability/src/metrics.ts` handles this automatically:

1. Use Express route pattern when available: `/api/orders/purchase-orders/:id`
2. Replace UUIDs with `:id`: `/api/orders/purchase-orders/550e8400-...` becomes `/api/orders/purchase-orders/:id`
3. Replace numeric segments with `:id`: `/api/catalog/parts/42` becomes `/api/catalog/parts/:id`
4. **Never** include query parameters in the route label
5. **Never** include tenant IDs in route labels (high cardinality)

### Cardinality Rules

- **Maximum distinct route labels per service**: 50
- **Maximum distinct label combinations per metric**: 500
- If a metric risks exceeding these limits, use a broader route pattern or aggregate

### Custom Label Extension

If a service needs additional labels beyond the standard set, add them to a **separate** metric rather than extending existing ones:

```typescript
// GOOD: separate metric for custom dimensions
const orderCreationDuration = new Histogram({
  name: 'order_creation_duration_seconds',
  help: 'Duration of order creation by type',
  labelNames: ['order_type', 'tenant_tier'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

// BAD: adding labels to shared metric
// httpRequestDuration.observe({ method, route, status_code, order_type }, duration);
```

### k6 Tag-to-Prometheus Alignment

| k6 Tag | Prometheus Label | Notes |
|---|---|---|
| `api_category` | Derived from `route` + `method` | k6 applies tag in scenario; Prom derives from labels |
| `workflow` | Derived from `route` | `fr01`, `fr02`, `fr03` map to route prefixes |
| `method` | `method` | Direct 1:1 mapping |
| `status` | `status_code` | k6 uses `status`, Prometheus uses `status_code` |
| `name` | `route` | k6 `name` tag equals Prometheus `route` label |

---

## 10. CI Performance Gate Contract

### Gate Definition

A new CI gate (**Gate 6: Performance Tests**) runs as part of the PR pipeline when load test files are changed or on a weekly schedule against `main`.

```
Gate 6: Performance Tests (weekly + on-demand)
  +-- Runs k6 load scenarios tagged with workflow and api_category
  +-- Reads thresholds from tests/load/thresholds.json
  +-- FAILS if any p95 threshold is breached
  +-- WARNS if any p99 threshold is breached
  +-- Publishes artifact: tests/load/reports/performance-report.json
```

### Gate Behavior

| Condition | Result | Action |
|---|---|---|
| All p95 thresholds pass | **PASS** | PR may merge |
| Any p95 threshold breached | **FAIL** | PR blocked; report artifact published |
| Any p99 threshold breached (p95 OK) | **WARN** | PR may merge; warning comment added |
| Error rate budget exceeded | **FAIL** | PR blocked; report artifact published |
| k6 run fails to start | **FAIL** | Infrastructure issue; retry or investigate |

### Artifact Report

On every run, the gate publishes `tests/load/reports/performance-report.json` containing:

```json
{
  "timestamp": "2026-02-14T12:00:00Z",
  "git_sha": "abc123",
  "branch": "feature/xyz",
  "duration_seconds": 300,
  "thresholds": {
    "passed": 42,
    "failed": 1,
    "warnings": 2
  },
  "results": [
    {
      "threshold_name": "http_req_duration{api_category:read_single}",
      "metric": "p95",
      "target_ms": 150,
      "actual_ms": 162,
      "status": "FAIL"
    }
  ],
  "error_rates": {
    "global_5xx_rate": 0.003,
    "budget": 0.005,
    "status": "PASS"
  }
}
```

### CI Workflow Integration

The performance gate integrates with the existing pipeline (see `docs/runbooks/ci-gates.md`):

```yaml
# .github/workflows/ci.yml (conceptual addition)
performance-tests:
  runs-on: ubuntu-latest
  if: |
    github.event_name == 'schedule' ||
    contains(github.event.pull_request.labels.*.name, 'perf-test')
  services:
    postgres: ...
    redis: ...
  steps:
    - uses: actions/checkout@v4
    - uses: grafana/setup-k6-action@v1
    - run: k6 run tests/load/scenarios/*.js --config tests/load/thresholds.json
    - uses: actions/upload-artifact@v4
      with:
        name: performance-report
        path: tests/load/reports/
      if: always()
```

---

## 11. k6 Threshold Mapping

The machine-readable threshold config lives at `tests/load/thresholds.json`. Every threshold in this document maps to a named entry in that file.

### Threshold Naming Convention

```
<metric_name>{<tag_key>:<tag_value>}
```

Examples:
- `http_req_duration{api_category:read_single}` -- p95 for all single-record reads
- `http_req_duration{workflow:fr01}` -- p95 for all FR-01 (catalog) endpoints
- `http_req_failed{api_category:write}` -- error rate for write operations

### Tag Taxonomy

| Tag Key | Values | Applied To |
|---|---|---|
| `api_category` | `read_single`, `read_list`, `write`, `workflow_transition`, `background_scan`, `auth`, `health` | All HTTP requests |
| `workflow` | `fr01`, `fr02`, `fr03` | HTTP requests by functional requirement |
| `service` | `catalog`, `kanban`, `orders`, `auth`, `notifications`, `api-gateway` | Per-service breakdown |

---

## 12. Budget Ownership & Review Process

### Ownership Matrix

| SLO Scope | Owner | Reviewer | Escalation |
|---|---|---|---|
| FR-01 (Catalog) thresholds | Backend Team (catalog service) | Platform Team | Engineering Lead |
| FR-02 (Kanban) thresholds | Backend Team (kanban service) | Platform Team | Engineering Lead |
| FR-03 (Orders) thresholds | Backend Team (orders service) | Platform Team | Engineering Lead |
| API category budgets | Platform Team | Backend Team leads | Engineering Lead |
| Error rate budgets | Platform Team | All service owners | Engineering Lead |
| Background job SLOs | Backend Team (per service) | Platform Team | Engineering Lead |
| Database query SLOs | Data Team | Platform Team | Engineering Lead |
| CI gate configuration | Platform Team | All teams | Engineering Lead |

### Review Cadence

| Activity | Frequency | Participants | Output |
|---|---|---|---|
| **Threshold review** | Monthly (1st Monday) | Platform Team + service owners | Updated `thresholds.json` + this doc |
| **Budget burn review** | Weekly (Friday standup) | Platform Team | Slack summary: % budget remaining |
| **Post-incident review** | After any SLO breach | Affected service owner + Platform Team | Updated thresholds or action items |
| **Quarterly capacity review** | Quarterly | All engineering | Updated post-MVP targets |

### Change Process

1. Propose change as a PR modifying both `docs/ops/slo-budgets.md` AND `tests/load/thresholds.json`.
2. Require approval from the SLO scope owner (see ownership matrix) AND Platform Team.
3. Changes to p95 thresholds require load test validation before merge.
4. Document rationale in the PR description (why the budget changed, supporting data).
5. Update the [Revision History](#13-revision-history) section.

### Budget Tightening vs. Relaxing

- **Tightening** (stricter targets): Can be done at any review cycle with supporting evidence.
- **Relaxing** (looser targets): Requires post-incident report or capacity analysis showing the current target is unrealistic. Must be approved by Engineering Lead.

---

## 13. Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0.0 | 2026-02-14 | Backend Agent (Issue #284) | Initial SLO budget spec |
