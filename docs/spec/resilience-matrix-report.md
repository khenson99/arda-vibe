# Resilience & Fault-Injection Test Matrix Report

**Ticket**: #88 (MVP-20/T1)
**Scope**: Scan-to-order automation workflows
**Date**: 2025-02-11

---

## 1. Executive Summary

This report documents the resilience and fault-injection test coverage for the
scan-to-order automation pipeline. The test matrix covers four service modules
across two services (`@arda/orders-service` and `@arda/kanban-service`), with
a total of **~105 fault-injection test cases** organized into 27 fault categories.

All tests validate that the system degrades gracefully under infrastructure
failures (Redis down, DB connection loss, event bus unavailable) and application
faults (corrupted data, race conditions, concurrent execution, timeout).

---

## 2. Test File Inventory

| # | File | Service | SUT Module | Test Count |
|---|------|---------|------------|------------|
| 1 | `services/orders/src/services/automation/__tests__/resilience/orchestrator-fault-injection.test.ts` | orders | `AutomationOrchestrator` | ~30 |
| 2 | `services/orders/src/services/automation/__tests__/resilience/guardrails-fault-injection.test.ts` | orders | `checkGuardrails`, `recordPOCreated`, `recordEmailDispatched` | ~25 |
| 3 | `services/orders/src/services/automation/__tests__/resilience/action-handlers-fault-injection.test.ts` | orders | `dispatchAction` (8 action types) | ~25 |
| 4 | `services/kanban/src/__tests__/resilience/card-lifecycle-fault-injection.test.ts` | kanban | `transitionCard`, `triggerCardByScan`, `replayScans` | ~25 |

**Pre-existing resilience tests** (not created in this ticket):

| File | SUT |
|------|-----|
| `services/orders/src/services/automation/__tests__/resilience/idempotency-fault-injection.test.ts` | `IdempotencyManager` |
| `services/kanban/src/__tests__/resilience/dedupe-fault-injection.test.ts` | `ScanDedupeManager` |

---

## 3. Fault Category Matrix

### 3.1 Orchestrator (`AutomationOrchestrator.executePipeline`)

| Category | Fault Injected | Expected Behaviour | Tests |
|----------|---------------|-------------------|-------|
| **Redis kill-switch** | GET throws ECONNREFUSED | Pipeline fails with error, no action dispatched | 3 |
| **Redis kill-switch** | GET returns corrupted value | Pipeline treats as inactive, proceeds | 3 |
| **Rule evaluation** | `loadActiveRules` throws | Pipeline fails, no side effects | 2 |
| **Rule evaluation** | Rules return empty / deny | Pipeline returns denied decision | 2 |
| **Guardrail Redis** | Counter GET/pipeline fails | Pipeline returns guardrail violation | 5 |
| **Approval logic** | Edge cases in threshold strategy | Correct escalation/auto-approve | 5 |
| **Audit recording** | DB insert throws | Pipeline succeeds (non-fatal) | 3 |
| **Cascading faults** | Multiple steps fail sequentially | Correct error propagation | 5 |
| **Recovery** | Transient errors → retry succeeds | Successful after recovery | 5 |

### 3.2 Guardrails (`checkGuardrails`, counter functions)

| Category | Fault Injected | Expected Behaviour | Tests |
|----------|---------------|-------------------|-------|
| **Financial Redis GET** | ECONNREFUSED / null / NaN | Guardrail check passes or fails gracefully | 6 |
| **Redis pipeline** | Pipeline exec rejects / returns null | Counter recording fails, non-fatal | 5 |
| **Corrupted counters** | Non-numeric strings in Redis | Treated as 0, guardrail passes | 4 |
| **Boundary conditions** | Values at exact thresholds | Correct pass/fail at boundaries | 9 |
| **Outbound Redis GET** | ECONNREFUSED / corrupted data | Outbound guardrails pass or fail gracefully | 6 |
| **Combined failures** | Financial + outbound fail together | Both categories report violations | 4 |

### 3.3 Action Handlers (`dispatchAction`)

| Category | Fault Injected | Expected Behaviour | Tests |
|----------|---------------|-------------------|-------|
| **PO creation DB** | Transaction ECONNREFUSED / unique violation / timeout | Returns `{success: false}` | 5 |
| **Transfer order DB** | Insert ECONNREFUSED / empty result | Returns `{success: false}` | 3 |
| **Event bus** | Publish rejects for email/shopping/card/escalate | Returns `{success: false}` | 4 |
| **Work order delegation** | Service throws / returns undefined / timeout | Returns `{success: false}` | 3 |
| **Exception automation** | Service throws / returns failure / undefined | Returns `{success: false}` | 3 |
| **Card transition DB** | Update throws deadlock / ECONNREFUSED | Returns `{success: false}` | 2 |
| **Escalation** | Audit insert + event bus both fail | Returns `{success: false}` | 2 |
| **Cascading** | All DB-dependent / all event-dependent fail | All affected actions fail independently | 4 |

### 3.4 Card Lifecycle (`transitionCard`, `triggerCardByScan`, `replayScans`)

| Category | Fault Injected | Expected Behaviour | Tests |
|----------|---------------|-------------------|-------|
| **Card fetch DB** | ECONNREFUSED / null / inactive / timeout | Throws AppError with correct code | 4 |
| **Transition validation** | Invalid transitions / bad roles / wrong loop type / wrong method | Throws AppError with specific code | 7 |
| **Atomic DB transaction** | ECONNREFUSED / deadlock / serialization failure | Throws, transaction rolled back | 3 |
| **Event bus** | Publish throws for lifecycle events | Transition succeeds (fire-and-forget) | 2 |
| **Dedupe manager** | Redis fails / duplicate detected / key expired | Correct rejection or error propagation | 4 |
| **Scan conflict** | All conflict resolution codes | Correct codes for all stage/active combos | 6 |
| **Scan conflicts in trigger** | Inactive / already triggered / stage advanced | Throws with correct error code | 3 |
| **Replay batch** | Mixed success/failure / duplicates / empty batch | Individual results, failures isolated | 4 |

---

## 4. Infrastructure Fault Coverage

| Infrastructure Component | Fault Type | Modules Covered |
|--------------------------|-----------|-----------------|
| **PostgreSQL** | ECONNREFUSED | Orchestrator, Action Handlers, Card Lifecycle |
| **PostgreSQL** | Deadlock detection | Action Handlers, Card Lifecycle |
| **PostgreSQL** | Serialization failure | Card Lifecycle |
| **PostgreSQL** | Query timeout | Orchestrator, Action Handlers, Card Lifecycle |
| **PostgreSQL** | Unique constraint violation | Action Handlers |
| **PostgreSQL** | Connection pool exhaustion | Action Handlers |
| **Redis** | ECONNREFUSED | Orchestrator, Guardrails, Card Lifecycle (dedupe) |
| **Redis** | Corrupted JSON / NaN values | Guardrails |
| **Redis** | Pipeline exec failure | Guardrails |
| **Redis** | Cluster failover | Action Handlers |
| **Event Bus (Redis)** | Publish rejection | Orchestrator, Action Handlers, Card Lifecycle |
| **Event Bus (Redis)** | Publish timeout | Action Handlers |
| **External Services** | WO orchestration unavailable | Action Handlers |
| **External Services** | Exception automation failure | Action Handlers |

---

## 5. Design Patterns Validated

### 5.1 Non-Fatal Side Effects

The following operations are designed to fail silently without breaking the main
pipeline:

- **Audit log recording** (Orchestrator step 7)
- **Post-action counter updates** (Orchestrator step 6)
- **Domain event emission** (Card Lifecycle step 9)

Tests confirm that failures in these paths do not propagate to callers.

### 5.2 Idempotency Under Faults

- Concurrent execution detection via `ConcurrentExecutionError`
- Redis-backed scan deduplication with `ScanDedupeManager`
- DB-backed idempotency via `idempotencyKey` in card stage transitions

### 5.3 Graceful Degradation

All action handlers catch errors internally and return structured
`{success: false, error: string}` results instead of throwing. This allows
the orchestrator to apply fallback strategies (retry, escalate, compensate,
halt) based on the rule configuration.

### 5.4 Fire-and-Forget Events

Card lifecycle domain events (step 9) are wrapped in try/catch and failures
are logged but do not cause the transition to fail. This ensures that Redis
event bus outages do not block critical card transitions.

---

## 6. Gaps and Future Work

| Gap | Risk | Recommendation |
|-----|------|---------------|
| No chaos-engineering in staging | Medium | Add network partition simulation (Toxiproxy) |
| No load-test under fault conditions | Medium | Run k6 with fault injection during load |
| No multi-tenant isolation fault tests | Low | Add tests for tenant A fault not affecting tenant B |
| No circuit-breaker pattern | Medium | Add circuit breaker around external service calls |
| No retry with jitter tests | Low | Validate backoff multiplier and jitter in integration tests |

---

## 7. Running the Tests

```bash
# Orders service resilience tests
npx turbo test --filter=@arda/orders-service -- --reporter=verbose

# Kanban service resilience tests
npx turbo test --filter=@arda/kanban-service -- --reporter=verbose

# All resilience tests specifically
npx vitest run --reporter=verbose services/orders/src/services/automation/__tests__/resilience/
npx vitest run --reporter=verbose services/kanban/src/__tests__/resilience/
```
