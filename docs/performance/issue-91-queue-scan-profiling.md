# Issue #91 - Queue & Scan Data Path Profiling Report

## Targets

| Data Path | p95 Target | Baseline (est.) |
|---|---|---|
| Queue list (`GET /order-queue`) | < 200 ms | ~400 ms |
| Risk scan (`runQueueRiskScanForTenant`) | < 300 ms | ~600 ms |
| Order conversion (PO/WO/TO creation) | < 150 ms | ~250 ms |

## Changes Applied

### 1. Database Indexes (Phase 1 & 2)

Added three composite indexes and one JSONB expression index:

| Index | Table | Columns | Purpose |
|---|---|---|---|
| `kanban_cards_queue_idx` | `kanban.kanban_cards` | `(tenant_id, current_stage, is_active)` | Queue list hot path: covers the WHERE clause for triggered-card fetches |
| `card_transitions_risk_scan_idx` | `kanban.card_stage_transitions` | `(tenant_id, loop_id, to_stage, transitioned_at)` | Risk scan aggregation: covers the trigger-count GROUP BY query |
| `po_lines_card_tenant_idx` | `orders.purchase_order_lines` | `(tenant_id, kanban_card_id)` | Draft PO lookup: replaces sequential scan on card-id for correlated subquery |
| `kanban_cards_risk_level_idx` | `kanban.kanban_cards` | `(metadata->>'riskLevel')` WHERE NOT NULL | Partial expression index for risk-level filtered queries |

Migration file: `packages/db/drizzle/0007_queue_scan_perf_indexes.sql`

All indexes use `CREATE INDEX CONCURRENTLY` to avoid write locks during deployment.

### 2. Query Optimizations (Phase 3)

**Correlated subquery elimination** (order-queue.routes.ts, GET `/`):
- Before: Per-row correlated subquery to find draft PO for each triggered card
- After: Single `DISTINCT ON` query with `ANY(cardIds)` array parameter, results joined in-memory via Map lookup
- Expected improvement: Eliminates N+1 query pattern; single round-trip regardless of card count

**Risk scan CTE merge** (order-queue.routes.ts, `runQueueRiskScanForTenant`):
- Before: Two sequential queries -- first fetches triggered cards, second counts triggers per loop
- After: Single CTE query combining both operations; the `trigger_counts` CTE references `triggered` CTE inline
- Expected improvement: Eliminates one database round-trip; PostgreSQL can optimize the combined plan

### 3. Worker Concurrency Tuning (Phase 4)

| Worker | Before | After | Rationale |
|---|---|---|---|
| `automation.worker` | 5 | 10 | Automation actions are I/O-bound (API calls, event publishing); doubling concurrency improves throughput |
| `order-aging.worker` | 2 | 3 | Aging checks are read-heavy with selective writes; modest increase for better tenant parallelism |
| `relowisa-recalc.worker` | 2 | 3 | Recalculation is CPU-light but DB-heavy; slight increase for multi-tenant throughput |

Workers NOT changed (remain at their current concurrency):
- `stale-card-cleanup.worker` -- stays at 1 (bulk delete operations, mutex-like behavior desired)
- `data-export.worker` -- stays at 1 (memory-intensive CSV/PDF generation)

## Index Size Estimates

Estimated index sizes for a representative dataset (~10K cards, ~500K transitions, ~50K PO lines):

| Index | Estimated Size |
|---|---|
| `kanban_cards_queue_idx` | ~300 KB |
| `card_transitions_risk_scan_idx` | ~15 MB |
| `po_lines_card_tenant_idx` | ~2 MB |
| `kanban_cards_risk_level_idx` | ~50 KB (partial) |

Total additional storage: ~18 MB. Negligible relative to table sizes.

## Verification

Performance test file: `services/orders/src/__tests__/perf/queue-scan-perf.test.ts`

Run with:
```bash
PERF_TEST=1 PERF_TENANT_ID=<tenant-uuid> npx vitest run services/orders/src/__tests__/perf/queue-scan-perf.test.ts
```

The test suite runs 20 iterations of each data path and asserts p95 latency against the targets above.

## Deployment Notes

1. Run the migration first: `0007_queue_scan_perf_indexes.sql`
2. Because `CREATE INDEX CONCURRENTLY` is used, the migration does NOT acquire exclusive locks -- safe for zero-downtime deployment
3. Monitor `pg_stat_user_indexes` after deployment to confirm the new indexes are being used
4. Monitor worker queue depths after concurrency changes to verify improved throughput

## Risk Assessment

- **Low risk**: Indexes are additive; they cannot break existing queries
- **Low risk**: CTE refactor produces identical result sets; the data mapping is unchanged
- **Medium risk**: Worker concurrency increases may raise Redis connection count. Monitor Redis `connected_clients` metric after deployment
