# Automation Policy, Guardrails & Decision Matrix

> **Issue**: MVP-21/T1 — Define order queue automation policy, guardrails, and decision matrix
> **Status**: Canonical
> **Depends on**: `queue-prioritization.md`, `lifecycle-transition-matrix.md`, `exceptions.md`
> **Updated**: 2025-06-01

Authoritative specification for how the order queue automation engine decides
_what_ it may do, _when_ it may do it, and _how_ it recovers when things go
wrong. Every automated action in the system — email dispatch, PO creation,
work order scheduling, transfer initiation — is governed by the rules defined
here.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Automation Rule Schema](#2-automation-rule-schema)
3. [Allow/Deny Rules](#3-allowdeny-rules)
4. [Idempotency Keys & Replay Semantics](#4-idempotency-keys--replay-semantics)
5. [Human-Override Workflow](#5-human-override-workflow)
6. [Decision Matrix](#6-decision-matrix)
7. [Security & Risk Guardrails](#7-security--risk-guardrails)
8. [Rollback & Compensation Strategy](#8-rollback--compensation-strategy)
9. [Configuration Defaults](#9-configuration-defaults)
10. [Monitoring & Observability](#10-monitoring--observability)

---

## 1. Overview

The automation engine processes kanban cards that have entered the `triggered`
stage and transitions them through the order creation lifecycle. Every
automated action follows the **TCAAF** pattern:

```
Trigger -> Condition -> Action -> Approval -> Fallback
```

**Core principles**:

- **Deny by default**: An action must match at least one `allow` rule and match
  zero `deny` rules to proceed.
- **Idempotent execution**: Every action carries an idempotency key; replays
  produce the same result without side effects.
- **Human override at every stage**: Any automated decision can be paused,
  overridden, or reversed by a user with the appropriate role.
- **Audit everything**: Every decision, action, and override is recorded in the
  immutable `card_stage_transitions` table and the `audit_log` table.
- **Fail safe, not fail silent**: On error, the card remains in its current
  stage and an escalation event is emitted.

---

## 2. Automation Rule Schema

Each automation rule is a self-contained policy object stored in the
`automation_rules` configuration table (or seeded via config).

```typescript
interface AutomationRule {
  id: string;                          // e.g. "E-01", "P-03"
  name: string;
  description: string;
  category: RuleCategory;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];   // ALL must pass (AND logic)
  action: AutomationAction;
  approval: ApprovalRequirement;
  fallback: FallbackBehavior;
  isActive: boolean;
  priority: number;                    // lower = evaluated first
  tenantConfigurable: boolean;         // can tenant admins modify?
}

type RuleCategory =
  | 'email_dispatch'
  | 'po_creation'
  | 'wo_creation'
  | 'to_creation'
  | 'shopping_list'
  | 'card_transition'
  | 'exception_handling';

interface AutomationTrigger {
  event: string;                       // e.g. "card.stage.triggered", "po.status.approved"
  sourceEntity: string;                // e.g. "kanban_card", "purchase_order"
  filters?: Record<string, unknown>;   // optional pre-filter on event payload
}

interface AutomationCondition {
  field: string;                       // dot-path into context, e.g. "order.totalAmount"
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'exists' | 'regex';
  value: unknown;
  description?: string;                // human-readable explanation
}

interface AutomationAction {
  type: ActionType;
  params: Record<string, unknown>;     // action-specific parameters
  idempotencyKeyTemplate: string;      // e.g. "po_create:{{tenantId}}:{{supplierId}}:{{date}}"
  timeoutMs: number;                   // max execution time
}

type ActionType =
  | 'create_purchase_order'
  | 'create_work_order'
  | 'create_transfer_order'
  | 'dispatch_email'
  | 'add_to_shopping_list'
  | 'transition_card'
  | 'resolve_exception'
  | 'escalate';

interface ApprovalRequirement {
  required: boolean;
  strategy: 'auto_approve' | 'single_approver' | 'threshold_based' | 'always_manual';
  thresholds?: {                       // for threshold_based strategy
    autoApproveBelow: number;          // amount in tenant currency
    requireApprovalAbove: number;
    requireDualApprovalAbove: number;
  };
  approverRoles?: string[];            // roles that can approve
  timeoutHours?: number;               // auto-escalate if no response
  escalateOnTimeout?: boolean;
}

interface FallbackBehavior {
  onConditionFail: 'skip' | 'escalate' | 'queue_for_review';
  onActionFail: 'retry' | 'escalate' | 'compensate' | 'halt';
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;      // exponential backoff factor
  compensationAction?: ActionType;     // what to do on permanent failure
}
```

---

## 3. Allow/Deny Rules

Rules are evaluated in priority order. The first matching `deny` rule blocks
the action regardless of any `allow` match. If no `allow` rule matches, the
action is blocked by default.

### 3.1 Email Dispatch Rules

Controls when `PODispatchService.dispatch()` may send emails to suppliers.

| ID | Type | Condition | Description |
|----|------|-----------|-------------|
| E-01 | allow | `po.status == 'approved'` | PO must be approved before dispatch |
| E-02 | allow | `supplier.email IS NOT NULL` | Supplier must have a valid email |
| E-03 | deny | `po.totalAmount > tenant.maxAutoDispatchAmount` | Block auto-dispatch above tenant threshold |
| E-04 | deny | `supplier.isBlacklisted == true` | Never auto-email blacklisted suppliers |
| E-05 | deny | `po.lineCount == 0` | Block dispatch of empty POs |
| E-06 | deny | `po.sentToEmail IS NOT NULL` | Block re-dispatch (already sent) |
| E-07 | deny | `tenant.emailDispatchPaused == true` | Tenant-level kill switch |
| E-08 | allow | `po.isExpedited == true AND po.status == 'approved'` | Expedited POs may bypass batch window |

```typescript
/** Resolved policy for an email dispatch attempt */
interface EmailDispatchPolicy {
  allowed: boolean;
  deniedByRule?: string;          // rule ID that blocked
  requiresApproval: boolean;
  approvalThreshold?: number;
  maxRetries: number;             // from PODispatchService config (default: 3)
  retryDelayMs: number;           // default: 1000, exponential backoff
}
```

### 3.2 Purchase Order Creation Rules

Controls automatic PO creation from triggered procurement kanban cards.

| ID | Type | Condition | Description |
|----|------|-----------|-------------|
| P-01 | allow | `card.currentStage == 'triggered'` | Card must be in triggered stage |
| P-02 | allow | `loop.loopType == 'procurement'` | Loop must be procurement type |
| P-03 | allow | `loop.primarySupplierId IS NOT NULL` | Supplier must be assigned |
| P-04 | deny | `loop.isActive == false` | Inactive loops cannot generate POs |
| P-05 | deny | `card.isActive == false` | Inactive cards cannot generate POs |
| P-06 | deny | `existingDraftPO(supplier, facility) EXISTS` | Prevent duplicate draft POs |
| P-07 | deny | `tenant.poCreationPaused == true` | Tenant-level kill switch |

### 3.3 Work Order Creation Rules

| ID | Type | Condition | Description |
|----|------|-----------|-------------|
| W-01 | allow | `card.currentStage == 'triggered'` | Card must be in triggered stage |
| W-02 | allow | `loop.loopType == 'production'` | Loop must be production type |
| W-03 | deny | `loop.isActive == false` | Inactive loops blocked |
| W-04 | deny | `card.isActive == false` | Inactive cards blocked |
| W-05 | deny | `facility.productionCapacity == 0` | No capacity, escalate instead |

### 3.4 Transfer Order Creation Rules

| ID | Type | Condition | Description |
|----|------|-----------|-------------|
| T-01 | allow | `card.currentStage == 'triggered'` | Card must be in triggered stage |
| T-02 | allow | `loop.loopType == 'transfer'` | Loop must be transfer type |
| T-03 | allow | `loop.sourceFacilityId IS NOT NULL` | Source facility must be assigned |
| T-04 | deny | `loop.isActive == false` | Inactive loops blocked |
| T-05 | deny | `sourceFacility.availableStock < loop.orderQuantity` | Insufficient stock at source |

### 3.5 Shopping List Rules

When multiple triggered cards target the same supplier, they are consolidated
into a "shopping list" before PO creation.

| ID | Type | Condition | Description |
|----|------|-----------|-------------|
| S-01 | allow | `consolidationGroup.cards.length >= 1` | At least one card in group |
| S-02 | deny | `consolidationGroup.totalAmount > tenant.maxAutoConsolidateAmount` | Too large for auto-consolidation |
| S-03 | deny | `consolidationGroup.cards.some(c => c.isExpedited) AND consolidationGroup.cards.some(c => !c.isExpedited)` | Don't mix expedited and normal |
| S-04 | allow | `consolidationWindow.elapsed >= tenant.consolidationWindowMinutes` | Batch window has elapsed |

---

## 4. Idempotency Keys & Replay Semantics

Every automated action generates an idempotency key before execution. If the
same key is presented within the TTL window, the system returns the cached
result without re-executing the action.

### 4.1 Key Generation

```typescript
interface IdempotencyRecord {
  key: string;                    // the idempotency key
  actionType: ActionType;
  status: 'pending' | 'completed' | 'failed';
  result?: unknown;               // cached action result
  createdAt: Date;
  expiresAt: Date;
  tenantId: string;
}
```

| Action Type | Key Template | TTL |
|-------------|-------------|-----|
| `create_purchase_order` | `po_create:{tenantId}:{supplierId}:{facilityId}:{date}` | 24h |
| `create_work_order` | `wo_create:{tenantId}:{facilityId}:{partId}:{date}` | 24h |
| `create_transfer_order` | `to_create:{tenantId}:{sourceFacilityId}:{destFacilityId}:{date}` | 24h |
| `dispatch_email` | `email_dispatch:{tenantId}:{poId}` | 72h |
| `transition_card` | `card_transition:{cardId}:{fromStage}:{toStage}:{cycleNumber}` | 1h |
| `resolve_exception` | `exception_resolve:{exceptionId}:{resolutionType}` | 24h |

### 4.2 Replay Semantics

```typescript
type ReplayBehavior = 'return_cached' | 'return_cached_warn' | 'reject';

/**
 * Execute an action with idempotency protection.
 *
 * 1. Check Redis for existing key
 * 2. If found and status=completed -> return cached result
 * 3. If found and status=pending -> wait or reject (concurrent execution)
 * 4. If not found -> acquire lock, execute, store result
 */
async function executeWithIdempotency<T>(
  key: string,
  actionType: ActionType,
  tenantId: string,
  ttlSeconds: number,
  execute: () => Promise<T>
): Promise<{ result: T; wasReplay: boolean }> {
  const existing = await redis.get(`idempotency:${key}`);

  if (existing) {
    const record: IdempotencyRecord = JSON.parse(existing);
    if (record.status === 'completed') {
      return { result: record.result as T, wasReplay: true };
    }
    if (record.status === 'pending') {
      throw new ConcurrentExecutionError(key);
    }
  }

  // Acquire lock with NX (set-if-not-exists)
  const acquired = await redis.set(
    `idempotency:${key}`,
    JSON.stringify({ key, actionType, status: 'pending', tenantId, createdAt: new Date() }),
    'NX',
    'EX',
    ttlSeconds
  );

  if (!acquired) {
    throw new ConcurrentExecutionError(key);
  }

  try {
    const result = await execute();
    await redis.set(
      `idempotency:${key}`,
      JSON.stringify({ key, actionType, status: 'completed', result, tenantId, createdAt: new Date() }),
      'EX',
      ttlSeconds
    );
    return { result, wasReplay: false };
  } catch (err) {
    await redis.set(
      `idempotency:${key}`,
      JSON.stringify({ key, actionType, status: 'failed', tenantId, createdAt: new Date() }),
      'EX',
      60 // short TTL for failures to allow retry
    );
    throw err;
  }
}
```

### 4.3 Storage

- **Backend**: Redis with key prefix `idempotency:`
- **Eviction**: TTL-based (see table above); no manual cleanup needed
- **Serialization**: JSON with `status`, `result`, `createdAt`, `expiresAt`
- **Concurrency**: Redis `SET NX` for distributed locking

---

## 5. Human-Override Workflow

Any automated action can be intercepted by a human operator. Overrides are
first-class audit events, not backdoors.

### 5.1 Override Triggers

| ID | Trigger | Description | Required Role |
|----|---------|-------------|---------------|
| H-01 | Manual hold on card | User moves card to `hold` pseudo-state | `inventory_manager` |
| H-02 | PO approval rejection | Approver rejects pending PO | `procurement_manager` |
| H-03 | Expedite override | User marks card as expedited, bypassing batch window | `procurement_manager` |
| H-04 | Supplier change | User changes supplier on pending order | `procurement_manager` |
| H-05 | Quantity adjustment | User modifies order quantity from calculated amount | `inventory_manager` |
| H-06 | Kill switch activation | Tenant admin pauses all automation | `tenant_admin` |
| H-07 | Exception manual resolve | User manually resolves an exception that automation escalated | `receiving_manager` |
| H-08 | Force re-trigger | User forces card back to `triggered` after a failed order | `inventory_manager` |

### 5.2 Override Data Model

```typescript
interface AutomationOverride {
  id: string;
  tenantId: string;
  entityType: 'kanban_card' | 'purchase_order' | 'work_order' | 'transfer_order' | 'exception';
  entityId: string;
  overrideType: OverrideType;
  previousState: Record<string, unknown>;
  newState: Record<string, unknown>;
  reason: string;                      // required free-text justification
  overriddenByUserId: string;
  overriddenAt: Date;
  automationRuleId?: string;           // which rule was overridden
  expiresAt?: Date;                    // for time-limited overrides (e.g. holds)
}

type OverrideType =
  | 'hold'
  | 'release'
  | 'reject'
  | 'expedite'
  | 'modify_quantity'
  | 'change_supplier'
  | 'force_retrigger'
  | 'manual_resolve'
  | 'kill_switch';
```

### 5.3 Override Lifecycle

```
                   user action
 automated state -----------------> overridden state
                                       |
                    +------------------+
                    |                  |
                    v                  v
              resumed            expired
              (released)         (auto-release)
```

- **Hold**: Card is paused; automation skips it until released
- **Release**: Card returns to automation pipeline
- **Expiry**: Time-limited holds auto-release after `expiresAt`

### 5.4 Audit Requirements

Every override MUST produce:

1. An `audit_log` entry with `action = 'automation.override'`
2. A `card_stage_transitions` entry (if card stage changes) with `method = 'manual'`
3. An event on the event bus: `automation.override.{overrideType}`

```typescript
interface AutomationAuditEntry {
  tenantId: string;
  action: string;                      // 'automation.override', 'automation.decision', etc.
  entityType: string;
  entityId: string;
  automationRuleId?: string;
  decision: 'allowed' | 'denied' | 'overridden' | 'escalated';
  deniedByRule?: string;
  context: Record<string, unknown>;    // snapshot of data at decision time
  userId?: string;                     // null for system actions
  timestamp: Date;
}
```

---

## 6. Decision Matrix

The master decision matrix defines which automated actions are eligible for
each combination of entity state and context.

### 6.1 Master Decision Matrix

| ID | Trigger Event | Conditions | Action | Approval | Fallback |
|----|--------------|------------|--------|----------|----------|
| D-01 | `card.stage.triggered` + procurement loop | P-01 through P-07 pass | `create_purchase_order` | threshold_based | queue_for_review |
| D-02 | `card.stage.triggered` + production loop | W-01 through W-05 pass | `create_work_order` | auto_approve | escalate |
| D-03 | `card.stage.triggered` + transfer loop | T-01 through T-05 pass | `create_transfer_order` | auto_approve | escalate |
| D-04 | `po.status.approved` | E-01 through E-08 pass | `dispatch_email` | auto_approve (below threshold) | retry then escalate |
| D-05 | `order.created` (PO) | Card linked to order | `transition_card` to `ordered` | auto_approve | halt (leave card in triggered) |
| D-06 | `shipment.dispatched` | Card linked to shipment | `transition_card` to `in_transit` | auto_approve | escalate |
| D-07 | `receipt.completed` | Card linked to receipt | `transition_card` to `received` | auto_approve | escalate |
| D-08 | `receiving.exception.created` | Exception type + severity | `resolve_exception` or `escalate` | per exception-automation rules | escalate |
| D-09 | `consolidation.window.elapsed` | S-01 through S-04 pass | `create_purchase_order` (consolidated) | threshold_based | queue_for_review |
| D-10 | `order.cancelled` | Cards linked to order | `transition_card` to `triggered` (rollback) | auto_approve | halt + alert |
| D-11 | `card.hold.expired` | Hold timer elapsed | Release card to automation | auto_approve | escalate |
| D-12 | `tenant.kill_switch.activated` | Tenant admin action | Pause all automation for tenant | N/A (immediate) | N/A |

### 6.2 Escalation Chain

When an action cannot be completed automatically, it escalates through:

| Level | Actor | SLA | Action |
|-------|-------|-----|--------|
| L1 | Automation engine | Immediate | Retry with backoff |
| L2 | Queue reviewer (role-based) | 4 hours | Manual review in queue UI |
| L3 | Procurement/inventory manager | 8 hours | Decision with full context |
| L4 | Tenant admin | 24 hours | Override or system config change |

### 6.3 Priority Resolution

When multiple rules apply to the same action:

1. **Deny rules win**: Any matching deny rule blocks the action
2. **Lowest priority number wins**: Among allow rules, lower `priority` value takes precedence
3. **Most specific wins**: Rules with more conditions are preferred over broader rules
4. **Tenant overrides win**: Tenant-specific rules override system defaults

---

## 7. Security & Risk Guardrails

### 7.1 Financial Guardrails

| ID | Guardrail | Default Threshold | Configurable |
|----|-----------|-------------------|--------------|
| G-01 | Max auto-approve PO amount | $5,000 | Yes (per tenant) |
| G-02 | Max auto-approve PO amount (expedited) | $10,000 | Yes |
| G-03 | Max auto-consolidate amount | $25,000 | Yes |
| G-04 | Max POs per supplier per day | 5 | Yes |
| G-05 | Max total auto-created PO value per day | $50,000 | Yes |
| G-06 | Max auto-dispatch emails per hour | 50 | Yes |
| G-07 | Max follow-up POs from exceptions per day | 10 | Yes |
| G-08 | Dual approval required above | $15,000 | Yes |

```typescript
interface TenantAutomationLimits {
  tenantId: string;
  maxAutoApprovePOAmount: number;         // G-01
  maxAutoApprovePOAmountExpedited: number; // G-02
  maxAutoConsolidateAmount: number;       // G-03
  maxPOsPerSupplierPerDay: number;        // G-04
  maxDailyAutoCreatedPOValue: number;     // G-05
  maxEmailDispatchPerHour: number;        // G-06
  maxFollowUpPOsPerDay: number;           // G-07
  dualApprovalThreshold: number;          // G-08
}
```

### 7.2 Outbound Action Guardrails

| ID | Guardrail | Description |
|----|-----------|-------------|
| O-01 | Email domain whitelist | Only send to verified supplier email domains |
| O-02 | Email rate limiting | Per-tenant, per-supplier rate limits |
| O-03 | PO number uniqueness | Enforced at DB level (unique constraint) |
| O-04 | Duplicate detection window | Same supplier + facility + date = potential duplicate |
| O-05 | Stale card detection | Cards in `triggered` > 72h without action -> alert |
| O-06 | Circular dependency check | Prevent transfer loops (A->B->A) |
| O-07 | Dead letter queue | Failed actions after max retries go to DLQ for manual review |

### 7.3 RBAC Integration

Automation actions inherit the permission model from the triggering context:

| Action | Required Role to Configure | Required Role to Override |
|--------|--------------------------|--------------------------|
| PO creation rules | `tenant_admin` | `procurement_manager` |
| WO creation rules | `tenant_admin` | `inventory_manager` |
| TO creation rules | `tenant_admin` | `inventory_manager` |
| Email dispatch rules | `tenant_admin` | `procurement_manager` |
| Financial thresholds | `tenant_admin` | `tenant_admin` |
| Kill switch | `tenant_admin` | `tenant_admin` |
| Exception automation | `tenant_admin` | `receiving_manager` |

### 7.4 Tenant Isolation

- All automation rules are scoped to `tenantId`
- Cross-tenant actions are impossible by design (every query includes `tenantId` filter)
- Rate limits are per-tenant; one tenant's activity cannot starve another
- Kill switch affects only the activating tenant

---

## 8. Rollback & Compensation Strategy

When an automated action fails or is reversed, the system must undo side
effects and return entities to a consistent state.

### 8.1 Rollback Matrix

| Action | Rollback Trigger | Rollback Steps | Card Impact |
|--------|-----------------|----------------|-------------|
| PO creation | Order cancelled before send | Delete draft PO + lines | Card -> `triggered` |
| PO dispatch | Email bounce / permanent failure | Mark PO as `draft`, clear `sentToEmail` | Card stays `ordered` + alert |
| WO creation | WO cancelled / rejected | Delete draft WO | Card -> `triggered` |
| TO creation | TO cancelled | Delete draft TO | Card -> `triggered` |
| Card transition | Transition failed mid-flight | No DB change (transaction rollback) | Card stays in previous stage |
| Exception auto-resolve | Resolution incorrect | Reopen exception, reverse resolution | Per exception type |
| Follow-up PO | Original exception reassessed | Cancel follow-up PO if still draft | Exception -> `open` |

### 8.2 Card Rollback Procedure

When an order is cancelled, all linked cards must be rolled back to `triggered`
to re-enter the queue. This is an **exception transition** (per
`lifecycle-transition-matrix.md` section on exception transitions).

```typescript
/**
 * Roll back cards linked to a cancelled order.
 *
 * Exception transition: ordered -> triggered (EX-1)
 * or: in_transit -> triggered (EX-2)
 *
 * Must run inside a DB transaction.
 */
async function rollbackCardsForCancelledOrder(
  tx: DbTransaction,
  tenantId: string,
  orderId: string,
  orderType: 'purchase_order' | 'work_order' | 'transfer_order'
): Promise<void> {
  // Determine which link column to match
  const linkColumn = {
    purchase_order: 'linkedPurchaseOrderId',
    work_order: 'linkedWorkOrderId',
    transfer_order: 'linkedTransferOrderId',
  }[orderType];

  // Find all cards linked to this order
  const linkedCards = await tx
    .select()
    .from(kanbanCards)
    .where(
      and(
        eq(kanbanCards.tenantId, tenantId),
        eq(kanbanCards[linkColumn], orderId),
        // Only rollback cards that are in ordered or in_transit
        sql`${kanbanCards.currentStage} IN ('ordered', 'in_transit')`
      )
    );

  for (const card of linkedCards) {
    // 1. Transition card back to triggered
    await tx
      .update(kanbanCards)
      .set({
        currentStage: 'triggered',
        currentStageEnteredAt: new Date(),
        [linkColumn]: null,            // unlink from cancelled order
        updatedAt: new Date(),
      })
      .where(eq(kanbanCards.id, card.id));

    // 2. Record the exception transition
    await tx.insert(cardStageTransitions).values({
      tenantId,
      cardId: card.id,
      loopId: card.loopId,
      cycleNumber: card.completedCycles + 1,
      fromStage: card.currentStage,
      toStage: 'triggered',
      method: 'system',
      notes: `Rollback: ${orderType} cancelled`,
      metadata: { rollbackOrderId: orderId, orderType },
    });
  }
}
```

### 8.3 Compensation for Sent POs

If a PO has already been dispatched via email, cancellation requires a
compensation workflow since the email cannot be "unsent":

1. Mark PO status as `cancelled`
2. Generate a cancellation notice PDF
3. Dispatch cancellation email to same supplier (using `PODispatchService`)
4. Log compensation action in audit trail
5. Roll back linked cards to `triggered`

### 8.4 Compensation Event Flow

```
order.cancelled
  +-- [if PO not yet sent] -> delete draft, rollback cards
  +-- [if PO sent] -> dispatch cancellation email, rollback cards
  +-- [if receipt started] -> create receiving exception, escalate
```

---

## 9. Configuration Defaults

### 9.1 Default Seed Data Rules

The following rules are seeded for every new tenant:

| Rule | Category | Default Active | Tenant Configurable |
|------|----------|---------------|---------------------|
| Auto-create POs for procurement loops | `po_creation` | Yes | Yes |
| Auto-create WOs for production loops | `wo_creation` | Yes | Yes |
| Auto-create TOs for transfer loops | `to_creation` | Yes | Yes |
| Auto-dispatch approved POs below $5,000 | `email_dispatch` | Yes | Yes (threshold) |
| Consolidate by supplier+facility | `shopping_list` | Yes | Yes (window) |
| Auto-resolve overage exceptions | `exception_handling` | Yes | Yes |
| Follow-up PO for critical short shipments | `exception_handling` | Yes | Yes |
| Escalate unresolvable exceptions | `exception_handling` | Yes | No |

### 9.2 Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `automation.enabled` | `true` | Master switch for all automation |
| `automation.email_dispatch.enabled` | `true` | Email dispatch automation |
| `automation.po_creation.enabled` | `true` | PO auto-creation |
| `automation.wo_creation.enabled` | `true` | WO auto-creation |
| `automation.to_creation.enabled` | `true` | TO auto-creation |
| `automation.exception_handling.enabled` | `true` | Exception auto-resolution |

---

## 10. Monitoring & Observability

### 10.1 Key Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `automation.decisions.total` | Counter | Total automation decisions made |
| `automation.decisions.allowed` | Counter | Decisions that resulted in action |
| `automation.decisions.denied` | Counter | Decisions blocked by deny rules |
| `automation.decisions.escalated` | Counter | Decisions escalated to human review |
| `automation.actions.duration_ms` | Histogram | Action execution duration |
| `automation.actions.retries` | Counter | Retry attempts per action type |
| `automation.overrides.total` | Counter | Human overrides performed |
| `automation.idempotency.replays` | Counter | Idempotent replay hits |
| `automation.guardrails.triggered` | Counter | Guardrail threshold breaches |

### 10.2 Structured Logging

All automation decisions use structured logging via `createLogger('automation')`:

```typescript
log.info({
  tenantId,
  ruleId: rule.id,
  entityType: trigger.sourceEntity,
  entityId,
  decision: 'allowed',
  actionType: action.type,
  idempotencyKey: key,
  durationMs: elapsed,
}, 'Automation decision');
```

---

_End of specification._
