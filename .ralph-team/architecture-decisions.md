# Architecture Decision Records

This file is maintained by the Architect agent. Each decision follows the
ADR format and is referenced by other agents when making implementation choices.

---


## ADR-001: MVP-18 execution order — sequential T1→T2→T3 then parallel T4-T7

**Status**: accepted
**Date**: 2026-02-12
**Context**: MVP-18 has 19 tickets (T1-T19). T1 (schema foundation) blocks T2 (archive table) and T3 (writeAuditEntry). T2 and T3 are independent of each other. T4-T7 (service-level audit writes) all depend on T3. Frontend tickets T14-T16 depend on backend APIs from T8-T10. QA T17-T18 run last.
**Decision**: Execute T1 first (done), then T2 and T3 in parallel (next sprint), then T4-T7 in parallel, then T8-T10, then frontend T14-T16, then QA T17-T18, then design T19. This maximizes parallelism while respecting dependencies. The backend-engineer handles T1-T13, frontend-engineer handles T14-T16, QA handles T17-T18, design-enforcer handles T19.

---

## ADR-002: Issue #250 PR strategy — ship immediately before starting T2

**Status**: accepted
**Date**: 2026-02-12
**Context**: Issue #250 code is complete with 14 tests passing but sits uncommitted/unpushed. T2 (#251) depends on the schema changes from T1.
**Decision**: Backend agent's first action must be to finalize #250 (commit, push, create PR). T2 can branch from the #250 branch to proceed without waiting for merge, but the PR must exist for review tracking.

---

## ADR-003: Fix CI typecheck failures before proceeding to T3

**Status**: accepted
**Date**: 2026-02-12
**Context**: PRs #381 (T1) and #382 (T2) both fail CI with 30 TS2769 errors in `@arda/orders-service`. Adding `hashChain`, `previousHash`, and `sequenceNumber` columns to the audit schema changed Drizzle's inferred insert/select types, which broke overload resolution in 12 orders service files. Main branch is green, so these errors are caused by the schema changes. T3 (#252) depends on the audit schema and cannot proceed until CI is green and the PRs are mergeable.
**Decision**: Backend engineer's next action must be to fix the 30 TS2769 errors on the `agent/backend/issue-250` branch, push, and verify CI passes. Then rebase `agent/backend/issue-251` on top. Only after both PRs are CI-green should the backend engineer start #252 (writeAuditEntry). The fix likely involves updating type annotations or explicit type casts in the orders service Drizzle query calls to accommodate the new audit columns.
**Consequences**: This delays T3 start by one iteration but ensures a clean foundation. Stacking more code on broken CI would compound the problem.
**Alternatives considered**: (1) Proceed with T3 ignoring CI — rejected, cascading failures would get worse. (2) Revert audit schema changes — rejected, the schema is correct and needed by all downstream tickets.

---
