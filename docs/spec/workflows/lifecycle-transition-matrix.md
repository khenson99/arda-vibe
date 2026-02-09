# Lifecycle Transition Matrix -- Canonical Stage Transitions for All Loop Types

> Authoritative, implementation-ready specification for Kanban card stage transitions
> across procurement, production, and transfer loops.
>
> **Issue**: MVP-04/T1
> **Status**: Canonical
> **Depends on**: `kanban-loop-rules.md`, `exceptions.md`, `rbac-matrix.md`

---

## 1. Stage Enum and Loop Type Enum (Source of Truth)

These enums are defined in `packages/db/src/schema/kanban.ts` and `packages/shared-types/src/index.ts`.

```typescript
type CardStage = 'created' | 'triggered' | 'ordered' | 'in_transit' | 'received' | 'restocked';
type LoopType  = 'procurement' | 'production' | 'transfer';
```

---

## 2. Unified Transition Adjacency Map

This is the single canonical lookup for all standard (non-exception) transitions. Every call to
`transitionCard()` MUST validate against this map before proceeding.

```typescript
const VALID_TRANSITIONS: Record<CardStage, CardStage[]> = {
  created:    ['triggered'],
  triggered:  ['ordered'],
  ordered:    ['in_transit', 'received'],
  in_transit: ['received'],
  received:   ['restocked'],
  restocked:  ['created'],
};
```

Any transition not present in this map returns `HTTP 400 INVALID_TRANSITION`.

---

## 3. Master Transition Matrix (All Loop Types)

Each cell indicates whether the transition is ALLOWED, CONDITIONAL, or FORBIDDEN.

| From \ To        | `created` | `triggered` | `ordered`   | `in_transit` | `received`  | `restocked` |
|------------------|:---------:|:-----------:|:-----------:|:------------:|:-----------:|:-----------:|
| **`created`**    | --        | ALLOWED     | --          | --           | --          | --          |
| **`triggered`**  | --        | --          | ALLOWED     | --           | --          | --          |
| **`ordered`**    | --        | --          | --          | CONDITIONAL  | ALLOWED     | --          |
| **`in_transit`** | --        | --          | --          | --           | ALLOWED     | --          |
| **`received`**   | --        | --          | --          | --           | --          | ALLOWED     |
| **`restocked`**  | ALLOWED   | --          | --          | --           | --          | --          |

Legend:
- **ALLOWED** -- Permitted for all loop types with standard guards.
- **CONDITIONAL** -- Permitted only for specific loop types (see per-transition detail).
- **--** -- FORBIDDEN. Returns `400 INVALID_TRANSITION`.

---

## 4. Per-Transition Detail

### 4.1 T1: `created` --> `triggered`

| Attribute             | Value |
|-----------------------|-------|
| **Transition ID**     | T1 |
| **From**              | `created` |
| **To**                | `triggered` |
| **Loop types**        | All (`procurement`, `production`, `transfer`) |
| **Trigger event**     | QR scan (primary), manual UI action, system auto-trigger |
| **Methods**           | `qr_scan`, `manual`, `system` |

#### Allowed Actors (Roles)

| Role                    | Allowed | Permission Required |
|-------------------------|:-------:|---------------------|
| `tenant_admin`          | Y       | (bypasses all checks) |
| `inventory_manager`     | Y       | `kanban:cards:transition` or `kanban:scan:trigger` |
| `procurement_manager`   | Y       | `kanban:cards:transition` or `kanban:scan:trigger` |
| `receiving_manager`     | Y       | `kanban:cards:transition` or `kanban:scan:trigger` |
| `ecommerce_director`    | --      | -- |
| `salesperson`           | --      | -- |
| `executive`             | --      | -- |

#### Guard Conditions (Pre-conditions)

| #  | Guard                                                        | Error Code |
|----|--------------------------------------------------------------|------------|
| G1 | Card exists in database                                      | `CARD_NOT_FOUND` |
| G2 | `card.tenantId = request.tenantId`                           | `FORBIDDEN` |
| G3 | `card.isActive = true`                                       | `CARD_INACTIVE` |
| G4 | `card.currentStage = 'created'`                              | `INVALID_TRANSITION` |
| G5 | Parent loop is active: `loop.isActive = true`                | `LOOP_INACTIVE` |
| G6 | If `qr_scan`: card UUID matches scanned QR payload           | `QR_MISMATCH` |
| G7 | If scan includes `tenantId`, it must match `card.tenantId`   | `TENANT_MISMATCH` |

#### Side Effects

1. Insert row in `card_stage_transitions` (immutable audit).
2. Update `kanban_cards.currentStage = 'triggered'`.
3. Update `kanban_cards.currentStageEnteredAt = NOW()`.
4. Publish `card.transition` event via Redis (outside DB transaction).
5. Card appears in the order queue for its loop type.

---

### 4.2 T2: `triggered` --> `ordered`

| Attribute             | Value |
|-----------------------|-------|
| **Transition ID**     | T2 |
| **From**              | `triggered` |
| **To**                | `ordered` |
| **Loop types**        | All (`procurement`, `production`, `transfer`) |
| **Trigger event**     | Queue processing (order creation from queue) |
| **Methods**           | `system` (primary, via queue processing), `manual` |

#### Allowed Actors (Roles)

| Role                    | Allowed | Context | Permission Required |
|-------------------------|:-------:|---------|---------------------|
| `tenant_admin`          | Y       | Any loop type | (bypasses all checks) |
| `procurement_manager`   | Y       | Procurement loops (PO creation) | `orders:order_queue:create_po` |
| `inventory_manager`     | Y       | Production / Transfer loops (WO/TO creation) | `orders:order_queue:create_wo` or `orders:order_queue:create_to` |
| `receiving_manager`     | --      | -- | -- |
| `ecommerce_director`    | --      | -- | -- |
| `salesperson`           | --      | -- | -- |
| `executive`             | --      | -- | -- |

#### Guard Conditions (Pre-conditions)

| #  | Guard                                                                              | Error Code |
|----|------------------------------------------------------------------------------------|------------|
| G1 | Card exists and `card.tenantId = request.tenantId`                                 | `CARD_NOT_FOUND` / `FORBIDDEN` |
| G2 | `card.isActive = true`                                                             | `CARD_INACTIVE` |
| G3 | `card.currentStage = 'triggered'`                                                  | `INVALID_TRANSITION` |
| G4 | Exactly one linked order ID provided (`linkedPurchaseOrderId` OR `linkedWorkOrderId` OR `linkedTransferOrderId`) | `MISSING_ORDER_LINK` |
| G5 | Linked order type matches loop type: procurement->PO, production->WO, transfer->TO | `ORDER_TYPE_MISMATCH` |

#### Atomicity Requirement

This transition MUST execute within the same database transaction as the order creation.
If order creation fails, the card must remain in `triggered` stage. The transaction boundary
encompasses: order record insert + order line inserts + all card stage updates + all
`card_stage_transitions` inserts + audit log entries. Events are published after commit.

#### Side Effects

1. Insert row in `card_stage_transitions` with `method = 'system'`.
2. Update `kanban_cards.currentStage = 'ordered'`.
3. Update `kanban_cards.currentStageEnteredAt = NOW()`.
4. Set the appropriate `linked*OrderId` on the card.
5. Clear other linked order ID fields to `null`.
6. Insert audit log entry (`kanban_card.transitioned_to_ordered`).
7. Publish `card.transition` event (after commit).
8. Publish `order.created` event (after commit).
9. Card exits the order queue.

---

### 4.3 T3: `ordered` --> `in_transit`

| Attribute             | Value |
|-----------------------|-------|
| **Transition ID**     | T3 |
| **From**              | `ordered` |
| **To**                | `in_transit` |
| **Loop types**        | `procurement`, `transfer` ONLY |
| **NOT allowed for**   | `production` (goods produced on-site; must skip to `received`) |
| **Trigger event**     | Shipment dispatch confirmed by procurement manager or system webhook |
| **Methods**           | `manual` (primary), `system` (via order status webhook) |

#### Allowed Actors (Roles)

| Role                    | Allowed | Permission Required |
|-------------------------|:-------:|---------------------|
| `tenant_admin`          | Y       | (bypasses all checks) |
| `procurement_manager`   | Y       | `kanban:cards:transition` |
| `inventory_manager`     | --      | -- |
| `receiving_manager`     | --      | -- |

#### Guard Conditions (Pre-conditions)

| #  | Guard                                                                    | Error Code |
|----|--------------------------------------------------------------------------|------------|
| G1 | Universal guards (exists, tenant match, active, stage = `ordered`)       | (various) |
| G2 | `loop.loopType != 'production'`                                          | `PRODUCTION_LOOP_NO_TRANSIT` |
| G3 | Card has a linked PO or TO (not a WO)                                    | `INVALID_ORDER_TYPE_FOR_TRANSIT` |
| G4 | Linked PO status is `sent` or `acknowledged`; OR linked TO status is `shipped` or `in_transit` | `ORDER_NOT_IN_SHIPMENT_STATUS` |

#### Side Effects

1. Insert row in `card_stage_transitions`.
2. Update `kanban_cards.currentStage = 'in_transit'`.
3. Update `kanban_cards.currentStageEnteredAt = NOW()`.
4. Publish `card.transition` event.

---

### 4.4 T4: `ordered` --> `received` (Direct Receipt)

| Attribute             | Value |
|-----------------------|-------|
| **Transition ID**     | T4 |
| **From**              | `ordered` |
| **To**                | `received` |
| **Loop types**        | All, but primarily `production` (WO completed) and `procurement` (local/same-day delivery) |
| **Trigger event**     | Goods available (WO completed, PO received, TO received) |
| **Methods**           | `manual`, `system` |

#### Allowed Actors (Roles)

| Role                    | Allowed | Permission Required |
|-------------------------|:-------:|---------------------|
| `tenant_admin`          | Y       | (bypasses all checks) |
| `receiving_manager`     | Y       | `kanban:cards:transition` |
| `procurement_manager`   | Y       | `kanban:cards:transition` |
| `inventory_manager`     | Y (production loops) | `kanban:cards:transition` |

#### Guard Conditions (Pre-conditions)

| #  | Guard                                                                      | Error Code |
|----|----------------------------------------------------------------------------|------------|
| G1 | Universal guards (exists, tenant match, active, stage = `ordered`)         | (various) |
| G2 | Card has a linked order                                                    | `MISSING_ORDER_LINK` |
| G3 | Linked order in receipt-valid status:                                      | `ORDER_NOT_RECEIVABLE` |
|    | -- PO: `received` or `partially_received`                                  | |
|    | -- WO: `completed`                                                         | |
|    | -- TO: `received`                                                          | |
| G4 | Receiving quantity recorded on the order line(s)                           | `NO_RECEIPT_QUANTITY` |

#### Side Effects

1. Insert row in `card_stage_transitions`.
2. Update `kanban_cards.currentStage = 'received'`.
3. Update `kanban_cards.currentStageEnteredAt = NOW()`.
4. Publish `card.transition` event.
5. Trigger notification for receiving team.

---

### 4.5 T5: `in_transit` --> `received`

| Attribute             | Value |
|-----------------------|-------|
| **Transition ID**     | T5 |
| **From**              | `in_transit` |
| **To**                | `received` |
| **Loop types**        | `procurement`, `transfer` |
| **Trigger event**     | Goods received at facility |
| **Methods**           | `manual` (primary), `qr_scan` (scan at receiving dock), `system` |

#### Allowed Actors (Roles)

| Role                    | Allowed | Permission Required |
|-------------------------|:-------:|---------------------|
| `tenant_admin`          | Y       | (bypasses all checks) |
| `receiving_manager`     | Y       | `kanban:cards:transition` |

#### Guard Conditions (Pre-conditions)

| #  | Guard                                                                      | Error Code |
|----|----------------------------------------------------------------------------|------------|
| G1 | Universal guards (exists, tenant match, active, stage = `in_transit`)      | (various) |
| G2 | Linked order in receipt-valid status:                                      | `ORDER_NOT_RECEIVABLE` |
|    | -- PO: `received` or `partially_received`                                  | |
|    | -- TO: `received`                                                          | |
| G3 | Receiving quantity recorded: at least one line has `quantityReceived > 0`   | `NO_RECEIPT_QUANTITY` |

#### Partial Receipt Semantics

If the PO/TO has multiple lines and only some are received, the card transitions to `received`
based on ITS specific line being fulfilled. The PO may remain in `partially_received` status.
See `exceptions.md` Section 1.3 for partial receipt split behavior.

#### Side Effects

1. Insert row in `card_stage_transitions`.
2. Update `kanban_cards.currentStage = 'received'`.
3. Update `kanban_cards.currentStageEnteredAt = NOW()`.
4. Publish `card.transition` event.
5. If PO is `partially_received`, emit notification for remaining lines.

---

### 4.6 T6: `received` --> `restocked`

| Attribute             | Value |
|-----------------------|-------|
| **Transition ID**     | T6 |
| **From**              | `received` |
| **To**                | `restocked` |
| **Loop types**        | All (`procurement`, `production`, `transfer`) |
| **Trigger event**     | Material put away in storage location |
| **Methods**           | `manual` (primary), `qr_scan` (scan at storage location) |

#### Allowed Actors (Roles)

| Role                    | Allowed | Permission Required |
|-------------------------|:-------:|---------------------|
| `tenant_admin`          | Y       | (bypasses all checks) |
| `receiving_manager`     | Y       | `kanban:cards:transition` |
| `inventory_manager`     | Y       | `kanban:cards:transition` |

#### Guard Conditions (Pre-conditions)

| #  | Guard                                                                  | Error Code |
|----|------------------------------------------------------------------------|------------|
| G1 | Universal guards (exists, tenant match, active, stage = `received`)    | (various) |

No additional guard conditions beyond the universal set. Put-away is always allowed once goods
are received.

#### Side Effects

1. Insert row in `card_stage_transitions`.
2. Update `kanban_cards.currentStage = 'restocked'`.
3. Update `kanban_cards.currentStageEnteredAt = NOW()`.
4. Publish `card.transition` event.
5. Trigger notification for inventory team.

---

### 4.7 T7: `restocked` --> `created` (Cycle Restart)

| Attribute             | Value |
|-----------------------|-------|
| **Transition ID**     | T7 |
| **From**              | `restocked` |
| **To**                | `created` |
| **Loop types**        | All (`procurement`, `production`, `transfer`) |
| **Trigger event**     | Cycle reset (automatic after restock or manual) |
| **Methods**           | `system` (primary, auto-reset after restock), `manual` |

#### Allowed Actors (Roles)

| Role                    | Allowed | Permission Required |
|-------------------------|:-------:|---------------------|
| `tenant_admin`          | Y       | (bypasses all checks) |
| `inventory_manager`     | Y       | `kanban:cards:transition` |
| System (auto-reset)     | Y       | N/A (method = `system`) |

#### Guard Conditions (Pre-conditions)

| #  | Guard                                                                  | Error Code |
|----|------------------------------------------------------------------------|------------|
| G1 | Universal guards (exists, tenant match, active, stage = `restocked`)   | (various) |
| G2 | Parent loop is active: `loop.isActive = true`                          | `LOOP_INACTIVE` |

If the loop is deactivated, the card stays in `restocked` indefinitely. The cycle does not restart.

#### Side Effects

1. Insert row in `card_stage_transitions`.
2. Update `kanban_cards.currentStage = 'created'`.
3. Update `kanban_cards.currentStageEnteredAt = NOW()`.
4. Increment `kanban_cards.completedCycles` by 1.
5. Clear all linked order IDs: `linkedPurchaseOrderId = null`, `linkedWorkOrderId = null`, `linkedTransferOrderId = null`.
6. Publish `card.transition` event.
7. Card is now idle, waiting at the bin for the next depletion signal.

#### Cycle Number

The new cycle number = `completedCycles + 1`. This value is used in subsequent
`card_stage_transitions.cycleNumber` for velocity calculations.

---

## 5. Loop-Type-Specific Transition Paths

### 5.1 Procurement Loop Path

```
created --> triggered --> ordered --> in_transit --> received --> restocked --> created
                                  \                                         /
                                   +-------> received -----> restocked ----+
                                   (direct receipt: local/same-day delivery)
```

| Transition | Required |
|------------|----------|
| T1: `created` --> `triggered` | Yes |
| T2: `triggered` --> `ordered` | Yes (creates PO) |
| T3: `ordered` --> `in_transit` | Optional (skip for local/same-day) |
| T4: `ordered` --> `received` | Alternative to T3+T5 (direct receipt) |
| T5: `in_transit` --> `received` | Yes (if T3 was taken) |
| T6: `received` --> `restocked` | Yes |
| T7: `restocked` --> `created` | Yes (cycle restart) |

**PO Status Lifecycle (Parallel)**:
```
draft --> pending_approval --> approved --> sent --> acknowledged --> partially_received --> received --> closed
                                                                                                   \--> cancelled
```

### 5.2 Production Loop Path

```
created --> triggered --> ordered --> received --> restocked --> created
```

The `in_transit` stage is NEVER used for production loops. Goods are produced on-site.

| Transition | Required |
|------------|----------|
| T1: `created` --> `triggered` | Yes |
| T2: `triggered` --> `ordered` | Yes (creates WO) |
| T3: `ordered` --> `in_transit` | FORBIDDEN (`PRODUCTION_LOOP_NO_TRANSIT`) |
| T4: `ordered` --> `received` | Yes (WO completed) |
| T6: `received` --> `restocked` | Yes |
| T7: `restocked` --> `created` | Yes (cycle restart) |

**WO Status Lifecycle (Parallel)**:
```
draft --> scheduled --> in_progress --> completed
                            |              |
                            v              v
                          on_hold      cancelled
```

### 5.3 Transfer Loop Path

```
created --> triggered --> ordered --> in_transit --> received --> restocked --> created
```

Transfer loops always go through `in_transit` because goods physically move between facilities.

| Transition | Required |
|------------|----------|
| T1: `created` --> `triggered` | Yes |
| T2: `triggered` --> `ordered` | Yes (creates TO) |
| T3: `ordered` --> `in_transit` | Yes (source facility ships) |
| T4: `ordered` --> `received` | Possible but unusual (same-campus transfers) |
| T5: `in_transit` --> `received` | Yes (destination receives) |
| T6: `received` --> `restocked` | Yes |
| T7: `restocked` --> `created` | Yes (cycle restart) |

**TO Status Lifecycle (Parallel)**:
```
draft --> requested --> approved --> picking --> shipped --> in_transit --> received --> closed
                                                                                   \--> cancelled
```

---

## 6. Exception (Rollback) Transitions

These transitions are OUTSIDE the standard `VALID_TRANSITIONS` map and require dedicated
exception-handling functions. They MUST NOT be processed by the standard `transitionCard()` function.

### 6.1 Exception Transition Map

| ID   | From          | To          | Trigger                           | Function                       |
|------|---------------|-------------|-----------------------------------|--------------------------------|
| EX-1 | `ordered`    | `triggered` | Linked order cancelled            | `rollbackCardToTriggered()`    |
| EX-2 | `in_transit` | `triggered` | Shipment lost or order cancelled  | `rollbackCardToTriggered()`    |
| EX-3 | `received`   | `restocked` | Card stuck > 48h (auto-advance)  | `autoAdvanceStuckCards()`      |
| EX-4 | `restocked`  | `created`   | Card stuck > 4h (auto-reset)     | `autoResetStuckCycles()`       |

### 6.2 Exception Transition Guards

All exception transitions MUST:
1. Bypass normal `VALID_TRANSITIONS` validation (dedicated code path).
2. Use `method = 'system'` in the `card_stage_transitions` record.
3. Record the exception reason in the `notes` field.
4. Record exception metadata in the `metadata` JSONB field (e.g., cancelled order ID, stuck duration).
5. Insert an audit log entry with the exception context.
6. Emit a `card.transition` event for real-time UI update.

### 6.3 EX-1 / EX-2: Order Cancellation Rollback

| Guard | Condition |
|-------|-----------|
| Card is in `ordered` or `in_transit` stage | Required |
| Linked order status is `cancelled` | Required |
| Card is active | Required |

**Side Effects**:
1. Update `kanban_cards.currentStage = 'triggered'`.
2. Clear all linked order IDs.
3. Card re-enters the order queue.

### 6.4 EX-3 / EX-4: Auto-Advance for Stuck Cards

These are automated system processes that run on a schedule. They handle cards that have been
stuck in `received` (> 48h) or `restocked` (> 4h) beyond expected durations. See
`exceptions.md` Section 1.1 for complete threshold definitions.

---

## 7. Forbidden Transitions (Exhaustive Enumeration)

The following transitions are explicitly FORBIDDEN under all circumstances. Any attempt returns
`HTTP 400 INVALID_TRANSITION`.

| #   | From          | To            | Reason |
|-----|---------------|---------------|--------|
| F1  | `created`     | `created`     | Self-transition not allowed |
| F2  | `created`     | `ordered`     | Must pass through `triggered` first |
| F3  | `created`     | `in_transit`  | Must pass through `triggered` and `ordered` first |
| F4  | `created`     | `received`    | Must pass through `triggered` and `ordered` first |
| F5  | `created`     | `restocked`   | Must pass through full cycle |
| F6  | `triggered`   | `created`     | Backward transition not allowed (except via exception rollback) |
| F7  | `triggered`   | `triggered`   | Self-transition not allowed; duplicate scans rejected |
| F8  | `triggered`   | `in_transit`  | Must pass through `ordered` first |
| F9  | `triggered`   | `received`    | Must pass through `ordered` first |
| F10 | `triggered`   | `restocked`   | Must pass through `ordered` and `received` first |
| F11 | `ordered`     | `created`     | Backward transition not allowed |
| F12 | `ordered`     | `triggered`   | Only via exception rollback (EX-1), not standard transition |
| F13 | `ordered`     | `ordered`     | Self-transition not allowed |
| F14 | `ordered`     | `restocked`   | Must pass through `received` first |
| F15 | `ordered`     | `in_transit`  | FORBIDDEN for `production` loops (G2 in T3) |
| F16 | `in_transit`  | `created`     | Backward transition not allowed |
| F17 | `in_transit`  | `triggered`   | Only via exception rollback (EX-2), not standard transition |
| F18 | `in_transit`  | `ordered`     | Backward transition not allowed |
| F19 | `in_transit`  | `in_transit`  | Self-transition not allowed |
| F20 | `in_transit`  | `restocked`   | Must pass through `received` first |
| F21 | `received`    | `created`     | Backward transition not allowed |
| F22 | `received`    | `triggered`   | Backward transition not allowed |
| F23 | `received`    | `ordered`     | Backward transition not allowed |
| F24 | `received`    | `in_transit`  | Backward transition not allowed |
| F25 | `received`    | `received`    | Self-transition not allowed |
| F26 | `restocked`   | `triggered`   | Must pass through `created` first |
| F27 | `restocked`   | `ordered`     | Must pass through `created` and `triggered` first |
| F28 | `restocked`   | `in_transit`  | Must pass through full cycle |
| F29 | `restocked`   | `received`    | Backward transition not allowed |
| F30 | `restocked`   | `restocked`   | Self-transition not allowed |

---

## 8. Universal Pre-conditions (All Transitions)

Every transition attempt (standard or exception) MUST pass these checks in order:

| Order | Check | Error Code | HTTP Status |
|-------|-------|------------|-------------|
| 1 | Card exists in database | `CARD_NOT_FOUND` | 404 |
| 2 | `card.tenantId = request.tenantId` | `FORBIDDEN` | 403 |
| 3 | Requesting user has required role/permission | `FORBIDDEN` | 403 |
| 4 | `card.isActive = true` | `CARD_INACTIVE` | 400 |
| 5 | `toStage` is in `VALID_TRANSITIONS[card.currentStage]` | `INVALID_TRANSITION` | 400 |
| 6 | Per-transition guard conditions (G1-Gn for that transition) | (transition-specific) | 400 |

---

## 9. Transaction Boundary Rules

| Operation | Transaction Scope | Event Timing |
|-----------|-------------------|--------------|
| Single card transition (`manual`, `qr_scan`) | Single DB transaction: update card + insert transition row | Event publish after commit (fire-and-forget) |
| Queue order creation (`triggered` --> `ordered`) | One DB transaction wrapping: order creation + all card transitions + audit log entries | Events published after commit |
| Batch transition (multi-card PO/TO) | One DB transaction for all cards. If any card fails validation, entire batch rolls back. No partial success. | Events published after commit (one per card) |
| Cycle restart (`restocked` --> `created`) | Single DB transaction: update card (stage, completedCycles, clear linked IDs) + insert transition row | Event publish after commit |
| Exception rollback (`ordered`/`in_transit` --> `triggered`) | Single DB transaction: update card + insert transition row + audit log | Event publish after commit |

---

## 10. Transition Method Reference

Each transition records its method in `card_stage_transitions.method`.

| Method     | Code        | Description |
|------------|-------------|-------------|
| QR Scan    | `qr_scan`   | User scans the physical card's QR code |
| Manual     | `manual`    | User clicks a transition button in the UI |
| System     | `system`    | Automated transition (order creation, event handler, auto-advance, rollback) |

---

## 11. Duplicate and Idempotency Quick Reference

| Scenario | Behavior | HTTP Status | Error Code |
|----------|----------|-------------|------------|
| QR scan on card in `created` | SUCCESS: transition to `triggered` | 200 | -- |
| QR scan on card NOT in `created` | REJECTED | 400 | `CARD_ALREADY_TRIGGERED` |
| Attempt to transition to current stage | REJECTED (self-transition) | 400 | `INVALID_TRANSITION` |
| Two concurrent transitions on same card | First wins; second fails cleanly | 400 | `INVALID_TRANSITION` |
| Creating order from stale queue data | All-or-nothing batch rejection | 400 | `INVALID_TRANSITION` |

Duplicate scans are NOT idempotent. Each failed scan attempt returns an error to surface
potential process issues to the operator.
