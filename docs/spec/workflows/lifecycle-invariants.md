# Lifecycle Invariants -- Idempotency, Ordering, and Concurrency Guarantees

> Authoritative specification for invariants that MUST hold across all Kanban card
> lifecycle operations in Arda V2.
>
> **Issue**: MVP-04/T1
> **Status**: Canonical
> **Depends on**: `lifecycle-transition-matrix.md`, `kanban-loop-rules.md`, `exceptions.md`

---

## 1. Immutable History

### 1.1 Transition Log Immutability

The `card_stage_transitions` table is an append-only audit log. The following invariants MUST hold:

| ID    | Invariant | Enforcement |
|-------|-----------|-------------|
| IH-1  | Rows in `card_stage_transitions` are NEVER updated after insertion. | No `UPDATE` statements on this table. Schema has no `updatedAt` column. |
| IH-2  | Rows in `card_stage_transitions` are NEVER deleted (except via cascade when a card is hard-deleted). | Application code never issues `DELETE` on this table. |
| IH-3  | Every standard transition inserts exactly one row in `card_stage_transitions`. | Enforced in `transitionCard()` -- insert is part of the same DB transaction as the card update. |
| IH-4  | Every exception transition inserts exactly one row in `card_stage_transitions` with `method = 'system'` and a non-empty `notes` field. | Enforced in exception-handling functions (`rollbackCardToTriggered()`, `autoAdvanceStuckCards()`, etc.). |
| IH-5  | The `fromStage` field in a transition row MUST match the card's `currentStage` at the moment the transition is executed. | Enforced by reading the card within the same transaction before writing the transition row. |

### 1.2 Transition Record Schema

Every row in `card_stage_transitions` MUST contain:

| Field                  | Required | Constraint |
|------------------------|:--------:|------------|
| `id`                   | Yes      | UUID, auto-generated |
| `tenantId`             | Yes      | Must match the card's `tenantId` |
| `cardId`               | Yes      | FK to `kanban_cards.id` |
| `loopId`               | Yes      | FK to `kanban_loops.id` |
| `cycleNumber`          | Yes      | >= 1; equals `card.completedCycles + 1` for the current cycle |
| `fromStage`            | Yes*     | The card's stage before the transition. *Null only for the initial `created` record. |
| `toStage`              | Yes      | The card's stage after the transition |
| `transitionedAt`       | Yes      | Timestamp with timezone; defaults to `NOW()` |
| `transitionedByUserId` | No       | UUID of the user who initiated (null for `system` transitions) |
| `method`               | Yes      | One of: `qr_scan`, `manual`, `system` |
| `notes`                | No       | Free text; REQUIRED for exception transitions |
| `metadata`             | No       | JSONB; REQUIRED for exception transitions (must include reason, cancelled order ID, etc.) |

### 1.3 Audit Log Complementarity

In addition to `card_stage_transitions`, certain operations also insert rows in the general
`audit_logs` table (e.g., `kanban_card.transitioned_to_ordered`, `purchase_order.created`).
These two tables serve different purposes:

| Table                      | Purpose | Query Pattern |
|----------------------------|---------|---------------|
| `card_stage_transitions`   | Velocity calculation, cycle time analysis, ReLoWiSa data | Queried by cardId + cycleNumber for metrics |
| `audit_logs`               | Security audit, compliance, who-did-what | Queried by userId, entityType, action |

Both records MUST be written within the same database transaction to maintain consistency.

---

## 2. Timestamp Ordering Guarantees

### 2.1 Monotonic Timestamps

| ID    | Invariant | Description |
|-------|-----------|-------------|
| TO-1  | For any card, the `transitionedAt` timestamps in `card_stage_transitions` MUST be monotonically non-decreasing within a cycle. | A transition's timestamp is always >= the previous transition's timestamp for the same card and cycle. |
| TO-2  | `kanban_cards.currentStageEnteredAt` MUST equal the `transitionedAt` of the most recent transition for that card. | These are set in the same transaction. |
| TO-3  | Within a single cycle, the sequence of `transitionedAt` values follows the stage ordering. | `created.time <= triggered.time <= ordered.time <= in_transit.time <= received.time <= restocked.time` (with `in_transit` optional). |

### 2.2 Clock Source

All timestamps use PostgreSQL's `NOW()` function within the transaction. This means:

- All rows written in the same transaction share the same `NOW()` value.
- Timestamps reflect the database server's clock, not the application server's or the client's.
- No client-supplied timestamps are accepted for `transitionedAt` or `currentStageEnteredAt`.

### 2.3 Cycle Boundary Timestamps

| Event | Timestamp Field | Ordering Guarantee |
|-------|-----------------|--------------------|
| Cycle N starts | `card_stage_transitions.transitionedAt` for the `restocked --> created` transition | This timestamp marks the end of cycle N and the start of cycle N+1 |
| Cycle N+1 first trigger | `card_stage_transitions.transitionedAt` for the `created --> triggered` transition | Must be >= the cycle restart timestamp |

### 2.4 Order Timestamp Alignment

When a card transitions from `triggered` to `ordered`, the following timestamps are created in
the same transaction and therefore share the same `NOW()` value:

- `card_stage_transitions.transitionedAt`
- `kanban_cards.currentStageEnteredAt`
- `purchase_orders.createdAt` (or `work_orders.createdAt` or `transfer_orders.createdAt`)

This guarantees that the card transition and order creation are temporally indistinguishable.

---

## 3. Idempotency Rules

### 3.1 Non-Idempotent Operations

The following operations are explicitly NOT idempotent. Repeated calls produce errors, not
silent acceptance:

| Operation | Repeated Call Behavior | Rationale |
|-----------|-----------------------|-----------|
| QR scan trigger (`created` --> `triggered`) | Second scan returns `400 CARD_ALREADY_TRIGGERED` | Duplicate scans may indicate process errors (wrong card, operator confusion). Surfacing the error is safer than silently accepting. |
| Any stage transition | Second call returns `400 INVALID_TRANSITION` because the stage has already changed | Stage transitions are state-changing operations. Repeating them would corrupt the audit trail. |
| Order creation from queue | Second call fails if cards are no longer in `triggered` stage | Prevents duplicate orders for the same demand signal. |

### 3.2 Idempotent Operations

The following operations ARE idempotent (repeated calls produce the same result):

| Operation | Behavior on Repeat | Mechanism |
|-----------|--------------------|-----------|
| Read queue (`GET /orders/queue`) | Same result if no state has changed | Pure read; no side effects |
| Read card state (`GET /kanban/cards/:id`) | Same result if no state has changed | Pure read; no side effects |
| Risk scan (`GET /orders/queue/risk-scan`) | Produces same risk assessments for same input state | Deterministic calculation; events may be re-emitted but are informational |

### 3.3 Retry Safety

| Operation | Safe to Retry? | Condition |
|-----------|:--------------:|-----------|
| Card transition (after network timeout) | Yes, with caveat | If the first attempt succeeded but the response was lost, the retry will fail with `INVALID_TRANSITION`. The client should fetch current card state and reconcile. |
| Order creation (after network timeout) | No, not blindly | The client must first check whether the order was created (query by cardIds). If cards are in `ordered`, the order was created successfully. |
| Event publish (Redis) | Yes | Events are fire-and-forget. Re-publishing is harmless (at-most-once delivery; consumers handle duplicates at the UI level via state reconciliation). |

### 3.4 Client Reconciliation Pattern

After any failed or timed-out write operation, the client MUST:

1. Query the current card state from the API.
2. Compare with the expected state.
3. If the state matches the intended result, treat the operation as successful.
4. If the state does not match, display the current state and allow the user to retry.

---

## 4. Multi-Card Mode Semantics

### 4.1 Independence Invariant

| ID    | Invariant |
|-------|-----------|
| MC-1  | Each card in a multi-card loop transitions independently. A transition on card #1 has no automatic effect on card #2. |
| MC-2  | Cards in the same loop MAY be in different stages simultaneously. There is no constraint requiring cards to be in the same stage. |
| MC-3  | Each card maintains its own `completedCycles` counter. Cards in the same loop may have different cycle counts. |
| MC-4  | Each card has its own linked order ID. Two cards in the same loop may be linked to different orders. |

### 4.2 Consolidation Invariant

| ID    | Invariant |
|-------|-----------|
| MC-5  | Multiple triggered cards from the same loop CAN be consolidated into one PO or TO. Each card becomes a separate line (or contributes to quantity on the same line if they share a part). |
| MC-6  | Production WOs are NEVER consolidated. Each card creates exactly one WO (1:1 relationship), even for multi-card loops. |
| MC-7  | When cards are consolidated into a single order, ALL cards transition from `triggered` to `ordered` in the SAME database transaction. If any card fails, the entire batch rolls back. |

### 4.3 Queue Display Invariant

| ID    | Invariant |
|-------|-----------|
| MC-8  | The order queue groups multi-card entries by loop, showing how many of N cards are currently triggered (e.g., "3 of 5 cards triggered"). |
| MC-9  | A card in `created` stage CAN be triggered even if other cards from the same loop are in `triggered`, `ordered`, or later stages. There is no mutual exclusion between cards. |

### 4.4 Single-Card Mode Constraint

| ID    | Invariant |
|-------|-----------|
| MC-10 | In single-card mode (`cardMode = 'single'`), the loop has exactly `numberOfCards = 1`. Only one card circulates. |
| MC-11 | If the single card is not in `created` stage, no demand signal can be generated for that loop until the cycle completes. |

---

## 5. Concurrency and Conflict Resolution

### 5.1 Optimistic Concurrency Control

The system uses a read-then-write pattern within database transactions. The current stage is read
and validated within the transaction before the update is written.

```
BEGIN TRANSACTION
  1. SELECT card WHERE id = :cardId (read current state)
  2. VALIDATE currentStage allows toStage
  3. UPDATE card SET currentStage = toStage
  4. INSERT card_stage_transitions (...)
COMMIT
```

### 5.2 Row-Level Locking (Recommended for Production)

For high-concurrency environments, `SELECT ... FOR UPDATE` SHOULD be used to prevent race
conditions:

```sql
SELECT * FROM kanban_cards WHERE id = :cardId FOR UPDATE;
```

This ensures that if two transitions target the same card concurrently, the second transaction
blocks until the first commits, then fails validation because the stage has changed.

### 5.3 Concurrency Invariants

| ID    | Invariant |
|-------|-----------|
| CC-1  | At most one transition can succeed for any given card at any point in time. Concurrent attempts result in exactly one success and N-1 failures. |
| CC-2  | The first transaction to commit wins. All subsequent transactions that read a stale stage will fail with `INVALID_TRANSITION`. |
| CC-3  | No partial transitions are possible. A transition either fully completes (card updated + transition row inserted) or fully rolls back (no state change). |
| CC-4  | Batch operations (multi-card PO/TO creation) are atomic. If card #3 of 5 fails validation, NO cards are transitioned and NO order is created. |

### 5.4 Race Condition Scenarios

| Scenario | Outcome |
|----------|---------|
| Two operators scan the same QR code within milliseconds | First scan succeeds; second returns `400 CARD_ALREADY_TRIGGERED` |
| User A creates PO from queue while User B creates PO with overlapping cards | First commit wins. Second transaction rolls back entirely. User B sees error, refreshes queue. |
| System auto-resets cycle (`restocked` --> `created`) while user manually transitions | Whichever commits first wins. The other fails with `INVALID_TRANSITION`. |
| Two users both try to advance card from `received` to `restocked` | First succeeds; second fails because card is already in `restocked`. |

### 5.5 Frontend Conflict Handling

When the frontend receives a `400 INVALID_TRANSITION` error:

1. Refetch the card's current state from the API.
2. Update the local UI to reflect the actual stage.
3. Show a toast notification: "This card was already processed by another user."
4. If in a queue view, refetch the queue to remove stale entries.

---

## 6. Stage Consistency Invariants

### 6.1 Single-Stage Invariant

| ID    | Invariant |
|-------|-----------|
| SC-1  | A card is in exactly one stage at any point in time. There is no "between stages" state. |
| SC-2  | `kanban_cards.currentStage` is the authoritative source of truth for the card's current stage. It is always consistent with the most recent row in `card_stage_transitions`. |
| SC-3  | `kanban_cards.currentStageEnteredAt` always reflects the timestamp of the most recent transition. |

### 6.2 Linked Order Consistency

| ID    | Invariant |
|-------|-----------|
| LO-1  | A card in `ordered`, `in_transit`, or `received` stage MUST have exactly one non-null linked order ID (`linkedPurchaseOrderId`, `linkedWorkOrderId`, or `linkedTransferOrderId`). |
| LO-2  | A card in `created`, `triggered`, or `restocked` stage MUST have all linked order IDs set to `null`. |
| LO-3  | The linked order type MUST match the card's loop type: procurement -> PO, production -> WO, transfer -> TO. |
| LO-4  | When a cycle restarts (`restocked` --> `created`), all linked order IDs are cleared to `null` in the same transaction. |
| LO-5  | When an exception rollback occurs (`ordered`/`in_transit` --> `triggered`), all linked order IDs are cleared to `null` in the same transaction. |

### 6.3 Cycle Counter Consistency

| ID    | Invariant |
|-------|-----------|
| CY-1  | `kanban_cards.completedCycles` is incremented by exactly 1 on each `restocked` --> `created` transition. No other transition modifies this counter. |
| CY-2  | `completedCycles` is monotonically non-decreasing. It is NEVER decremented. |
| CY-3  | The `cycleNumber` recorded in `card_stage_transitions` for a given cycle equals `completedCycles + 1` at the time of the transition (i.e., the cycle currently in progress). |
| CY-4  | All transition rows within a single cycle share the same `cycleNumber`. |

---

## 7. Active/Inactive State Invariants

### 7.1 Card Active State

| ID    | Invariant |
|-------|-----------|
| AC-1  | A card with `isActive = false` cannot undergo any standard transition. All transition attempts return `400 CARD_INACTIVE`. |
| AC-2  | Deactivating a card does NOT automatically cancel its linked order. The order continues independently. |
| AC-3  | A deactivated card is excluded from all queue queries (`WHERE isActive = true`). |
| AC-4  | Reactivating a card (`isActive = true`) allows it to resume from its current stage. No stage change occurs on reactivation. |

### 7.2 Loop Active State

| ID    | Invariant |
|-------|-----------|
| AL-1  | A card in an inactive loop (`loop.isActive = false`) is filtered out of queue queries. |
| AL-2  | The `created` --> `triggered` transition checks `loop.isActive = true`. If the loop is inactive, the card CAN still be triggered (the guard is on the card, not the loop for T1), but the triggered card will not appear in the queue because queue queries filter by `loop.isActive = true`. |
| AL-3  | The `restocked` --> `created` cycle restart checks `loop.isActive = true`. If the loop is inactive, the card stays in `restocked` indefinitely. |
| AL-4  | Reactivating a loop immediately makes its cards visible in the queue again. Cards stuck in `restocked` (due to AL-3) can now cycle-restart. |

---

## 8. Event Delivery Invariants

### 8.1 Event Timing

| ID    | Invariant |
|-------|-----------|
| EV-1  | Events are published AFTER the database transaction commits. If the transaction rolls back, no event is published. |
| EV-2  | Events are fire-and-forget. A failure to publish an event does NOT cause the transaction to roll back. |
| EV-3  | The database is the source of truth. Events are for real-time notifications and UI updates, not for state management. |

### 8.2 Event Delivery Guarantee

| ID    | Invariant |
|-------|-----------|
| EV-4  | Delivery guarantee is at-most-once. Events may be lost (Redis failure, subscriber disconnect) but are never duplicated by the publisher. |
| EV-5  | If an event is lost, the state is recoverable from the database. Clients can poll or query the API to reconcile. |
| EV-6  | The periodic risk scan serves as a catch-up mechanism. It re-evaluates all triggered cards and re-emits `queue.risk_detected` events regardless of whether previous events were delivered. |

### 8.3 Event Content Invariants

| ID    | Invariant |
|-------|-----------|
| EV-7  | Every `card.transition` event includes: `tenantId`, `cardId`, `loopId`, `fromStage`, `toStage`, `method`, `timestamp`. |
| EV-8  | The event's `fromStage` and `toStage` MUST match the corresponding `card_stage_transitions` row. |
| EV-9  | One `card.transition` event is emitted per card transition. In a batch operation (multi-card PO), N events are emitted for N cards. |

---

## 9. Data Integrity Constraints (Database Level)

### 9.1 Enum Constraints

| Constraint | Enforcement |
|------------|-------------|
| `currentStage` values are restricted to the `card_stage` enum | PostgreSQL enum type; invalid values rejected at DB level |
| `loopType` values are restricted to the `loop_type` enum | PostgreSQL enum type |
| `method` values should be one of `qr_scan`, `manual`, `system` | Application-level validation (varchar field) |

### 9.2 Referential Integrity

| Constraint | Enforcement |
|------------|-------------|
| `card_stage_transitions.cardId` references `kanban_cards.id` | FK with `ON DELETE CASCADE` |
| `card_stage_transitions.loopId` references `kanban_loops.id` | FK with `ON DELETE CASCADE` |
| `kanban_cards.loopId` references `kanban_loops.id` | FK with `ON DELETE CASCADE` |

### 9.3 Uniqueness Constraints

| Constraint | Index |
|------------|-------|
| One card per (loopId, cardNumber) | `kanban_cards_loop_number_idx` UNIQUE |
| One loop per (tenantId, partId, facilityId, loopType) | `kanban_loops_unique_idx` UNIQUE |

---

## 10. Ordering and Sequencing Guarantees

### 10.1 Stage Ordering Within a Cycle

For any completed cycle, the transition timestamps MUST satisfy:

```
t(created->triggered) < t(triggered->ordered) < t(ordered->in_transit)* < t(*->received) < t(received->restocked) < t(restocked->created)
```

Where `*` indicates that the `in_transit` stage is optional (skipped for production loops and
some procurement/transfer scenarios).

### 10.2 Cycle Ordering

For any card, cycles are strictly ordered:

```
cycle_1.restocked_time < cycle_2.created_time < cycle_2.triggered_time < ... < cycle_2.restocked_time < cycle_3.created_time < ...
```

There is no overlap between cycles. A card cannot be in two cycles simultaneously.

### 10.3 Transition Ordering Within a Batch

When multiple cards are transitioned in a single batch (e.g., multi-card PO creation), all
transition rows share the same `transitionedAt` timestamp (they are in the same DB transaction
and `NOW()` returns a consistent value within a transaction). The insertion order is deterministic
(ordered by array position of `cardIds`) but the timestamp ordering is identical.

---

## 11. Failure Mode Summary

| Failure | State After Failure | Recovery |
|---------|---------------------|----------|
| DB transaction rollback (any cause) | No state change. Card remains in previous stage. No transition row inserted. No event published. | Retry the operation. |
| Redis event publish failure | Card state updated in DB (committed). Event not delivered. | DB is source of truth. Clients poll or query API. Risk scan catches stuck cards. |
| Application crash after DB commit but before event publish | Card state updated. Event lost. | Same as Redis failure. DB state is authoritative. |
| Concurrent transition conflict | First commit wins. Second transaction fails. | Second caller refetches card state and presents current state to user. |
| Network timeout (client does not receive response) | Transaction may have committed or rolled back. Client does not know. | Client queries card state to determine outcome. Reconciles accordingly. |

---

## 12. Implementation Checklist

This checklist summarizes the invariants that MUST be validated in code review for any transition
logic:

- [ ] Transition inserts exactly one `card_stage_transitions` row (IH-3, IH-4).
- [ ] No `UPDATE` or `DELETE` on `card_stage_transitions` (IH-1, IH-2).
- [ ] `fromStage` matches `card.currentStage` at read time (IH-5).
- [ ] `currentStageEnteredAt` is updated to match `transitionedAt` (TO-2).
- [ ] All timestamps use `NOW()` -- no client-supplied timestamps (TO-2).
- [ ] Linked order IDs cleared on cycle restart (LO-4) and rollback (LO-5).
- [ ] `completedCycles` incremented only on `restocked` --> `created` (CY-1).
- [ ] Events published after commit, never inside the transaction (EV-1).
- [ ] Event publish failure does not roll back the transaction (EV-2).
- [ ] Batch operations are fully atomic -- all-or-nothing (CC-4).
- [ ] `card.isActive` checked before any transition (AC-1).
- [ ] `loop.isActive` checked for T1 queue visibility and T7 cycle restart (AL-2, AL-3).
- [ ] Duplicate scans return an error, not silent acceptance (Section 3.1).
- [ ] Exception transitions use `method = 'system'` with `notes` and `metadata` (IH-4).
