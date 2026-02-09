# Queue Prioritization — Inputs, Ordering Logic, and Consolidation Rules

> Authoritative specification for the Arda V2 Order Queue.
> Defines how triggered cards are grouped, prioritized, and converted into orders.

---

## 1. Queue Overview

The Order Queue holds all Kanban cards currently in the `triggered` stage. These cards represent demand signals awaiting replenishment orders.

### 1.1 Queue Segments

| Segment | Loop Type | Creates | Grouping Key |
|---------|-----------|---------|--------------|
| **Procurement Queue** | `procurement` | Purchase Orders (PO) | `primarySupplierId` + `facilityId` |
| **Production Queue** | `production` | Work Orders (WO) | `facilityId` |
| **Transfer Queue** | `transfer` | Transfer Orders (TO) | `sourceFacilityId` + `facilityId` |

### 1.2 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/orders/queue` | GET | List all triggered cards (filterable by `loopType`) |
| `/orders/queue/summary` | GET | Aggregated count and age by loop type |
| `/orders/queue/risk-scan` | GET | Detect and score stockout risks |
| `/orders/queue/create-po` | POST | Create PO from selected procurement cards |
| `/orders/queue/create-wo` | POST | Create WO from a single production card |
| `/orders/queue/create-to` | POST | Create TO from selected transfer cards |

---

## 2. Queue Entry Criteria

A card enters the order queue when ALL of the following conditions are met:

| # | Condition | Field Check |
|---|-----------|-------------|
| 1 | Card stage is `triggered` | `kanban_cards.current_stage = 'triggered'` |
| 2 | Card is active | `kanban_cards.is_active = true` |
| 3 | Parent loop is active | `kanban_loops.is_active = true` |

### 2.1 Entry Mechanism

Cards enter the queue through stage transition to `triggered`:

1. **QR Scan** (primary): User scans physical card at depleted bin. The `triggerCardByScan()` function transitions the card from `created` to `triggered`.
2. **Manual trigger**: User selects a card in the UI and manually transitions it to `triggered`.
3. **System trigger**: Automated system detects inventory below `minQuantity` and triggers the card.

### 2.2 Exit Mechanism

Cards exit the queue when:

| Exit Condition | How |
|----------------|-----|
| Order created | Card transitions from `triggered` to `ordered` (normal flow) |
| Card deactivated | `isActive` set to `false` (manual admin action) |
| Loop deactivated | `loop.isActive` set to `false` (hides all cards in that loop from queue) |

---

## 3. Queue Grouping Rules

### 3.1 Procurement Queue Grouping

Cards in the procurement queue are grouped by supplier and facility for potential PO consolidation.

```
Group Key: (tenantId, primarySupplierId, facilityId)
```

**Display hierarchy:**

```
Procurement Queue
  |-- Supplier: Acme Corp (facilityId: warehouse-A)
  |     |-- Card #1: Part XYZ-100 (triggered 2h ago)
  |     |-- Card #2: Part ABC-200 (triggered 5h ago)
  |     +-- Card #3: Part DEF-300 (triggered 1h ago)
  |
  +-- Supplier: GlobalParts (facilityId: warehouse-A)
        +-- Card #4: Part GHI-400 (triggered 8h ago)
```

**Grouping rules:**
1. Cards MUST share the same `primarySupplierId` to be consolidated into one PO.
2. Cards MUST share the same `facilityId` (receiving facility) to be consolidated.
3. Cards from different loops but the same supplier/facility CAN be consolidated.
4. A PO can have multiple lines (one per card/part).

### 3.2 Production Queue Grouping

Cards in the production queue are grouped by facility. Each card creates its own WO (no consolidation).

```
Group Key: (tenantId, facilityId)
```

**Display hierarchy:**

```
Production Queue
  |-- Facility: Main Plant
  |     |-- Card #5: Part MFG-100 (triggered 3h ago) -- creates its own WO
  |     +-- Card #6: Part MFG-200 (triggered 6h ago) -- creates its own WO
  |
  +-- Facility: Secondary Plant
        +-- Card #7: Part MFG-300 (triggered 1h ago) -- creates its own WO
```

**Grouping rules:**
1. Each production card creates exactly ONE Work Order (1:1 relationship).
2. WOs are NOT consolidated because each WO has its own routing steps and scheduling.
3. Grouping by facility is for display purposes only.

### 3.3 Transfer Queue Grouping

Cards in the transfer queue are grouped by source/destination facility pair for potential TO consolidation.

```
Group Key: (tenantId, sourceFacilityId, facilityId)
```

**Display hierarchy:**

```
Transfer Queue
  |-- From: Distribution Center --> To: Warehouse-A
  |     |-- Card #8: Part XYZ-100 (triggered 4h ago)
  |     +-- Card #9: Part ABC-200 (triggered 2h ago)
  |
  +-- From: Distribution Center --> To: Warehouse-B
        +-- Card #10: Part DEF-300 (triggered 7h ago)
```

**Grouping rules:**
1. Cards MUST share the same `sourceFacilityId` AND `facilityId` to be consolidated.
2. Multiple cards from different loops but the same route CAN be consolidated into one TO.
3. A TO can have multiple lines (one per card/part).

---

## 4. Consolidation Rules

### 4.1 Manual Consolidation (Default)

When `autoConsolidateOrders = false` (default):

1. User views the queue, filtered by loop type.
2. User manually selects one or more triggered cards.
3. User clicks "Create PO" / "Create TO".
4. System validates all selected cards are compatible for consolidation (see group key rules above).
5. System creates one order with N lines.

**Validation on consolidation:**

| Check | Error if Fails |
|-------|----------------|
| All cards in `triggered` stage | `400: All cards must be in triggered stage` |
| All cards from correct loop type | `400: All cards must be from procurement loops` (for PO) |
| All cards belong to requesting tenant | `403: Invalid card access` |
| For PO: all cards share same supplier | `400: All cards must share the same supplier for consolidation` |
| For PO/TO: all cards share same facility pair | `400: All cards must share the same facility routing` |

### 4.2 Auto-Consolidation (Tenant Setting)

When `autoConsolidateOrders = true`:

The system automatically pre-groups triggered cards into consolidation batches. The user sees "ready-to-create" groups rather than individual cards.

**Auto-consolidation algorithm:**

```
FOR each unique group key (supplier+facility for PO, source+dest for TO):
  1. Collect all triggered cards matching the group key
  2. Sort by currentStageEnteredAt ASC (oldest first)
  3. Present as a single "Create Order" action
  4. User confirms with one click -> order created with all cards
```

**Auto-consolidation constraints:**

| Constraint | Rule |
|-----------|------|
| Maximum cards per PO | 50 lines (prevent oversized POs) |
| Maximum cards per TO | 50 lines |
| Production WOs | NEVER auto-consolidated (always 1:1) |
| Timing | Auto-groups refresh on each queue view (not cached) |
| Override | User can still manually select a subset of cards from an auto-group |

### 4.3 Consolidation Impact on Card Transitions

When multiple cards are consolidated into a single order:

1. All selected cards transition from `triggered` to `ordered` within the **same database transaction**.
2. All cards are linked to the same order ID (`linkedPurchaseOrderId` or `linkedTransferOrderId`).
3. One audit log entry per card transition + one audit log entry for the order creation.
4. One `order.created` event is emitted (with `linkedCardIds` array containing all card IDs).
5. One `card.transition` event per card is emitted.

---

## 5. Priority Score Algorithm

### 5.1 Purpose

The priority score determines the display order of triggered cards in the queue. Higher priority = card should be processed first.

### 5.2 Inputs

| Input | Source | Weight | Description |
|-------|--------|--------|-------------|
| **Triggered Age** (hours) | `NOW() - kanban_cards.current_stage_entered_at` | 0.35 | How long the card has been waiting in the queue |
| **Days of Supply** | Calculated from consumption velocity | 0.30 | Estimated days until stockout at current consumption rate |
| **Safety Stock Urgency** | `kanban_loops.safety_stock_days` | 0.20 | How close current stock is to safety stock threshold |
| **Lead Time Factor** | `kanban_loops.stated_lead_time_days` | 0.15 | Longer lead time = higher urgency to order now |

### 5.3 Priority Score Formula

```
priorityScore = (ageScore * 0.35) + (supplyScore * 0.30) + (safetyScore * 0.20) + (leadTimeScore * 0.15)
```

Where each component is normalized to a 0-100 scale:

#### Age Score (0-100)

```typescript
function computeAgeScore(triggeredAgeHours: number, leadTimeDays: number): number {
  // Normalize: at 0 hours = 0, at 2x lead time hours = 100
  const maxAge = leadTimeDays * 24 * 2; // 2x lead time in hours
  return Math.min(100, Math.round((triggeredAgeHours / maxAge) * 100));
}
```

#### Supply Score (0-100)

```typescript
function computeSupplyScore(estimatedDaysOfSupply: number | null, leadTimeDays: number): number {
  if (estimatedDaysOfSupply === null) return 50; // Unknown = medium priority
  // Inverse: fewer days = higher score
  // At 0 days = 100, at 2x lead time = 0
  const maxDays = leadTimeDays * 2;
  return Math.min(100, Math.max(0, Math.round((1 - estimatedDaysOfSupply / maxDays) * 100)));
}
```

#### Safety Stock Score (0-100)

```typescript
function computeSafetyScore(safetyStockDays: number, estimatedDaysOfSupply: number | null): number {
  if (estimatedDaysOfSupply === null || safetyStockDays <= 0) return 50;
  // If days-of-supply < safety stock, urgency is critical
  if (estimatedDaysOfSupply <= safetyStockDays) return 100;
  // Scale down as supply exceeds safety stock
  const buffer = estimatedDaysOfSupply - safetyStockDays;
  return Math.max(0, Math.round(100 - (buffer / safetyStockDays) * 50));
}
```

#### Lead Time Score (0-100)

```typescript
function computeLeadTimeScore(leadTimeDays: number): number {
  // Longer lead time = higher priority to order early
  // Normalize: 1 day = 10, 7 days = 50, 30 days = 100
  return Math.min(100, Math.round((leadTimeDays / 30) * 100));
}
```

### 5.4 Default Sort Order

The queue is sorted by:

1. **Primary**: `priorityScore` DESC (highest priority first)
2. **Secondary**: `currentStageEnteredAt` ASC (oldest triggered first, as tiebreaker)

When priority scoring is not computed (simple queue view), the default sort is:

1. `currentStageEnteredAt` ASC (oldest first — FIFO)

---

## 6. Risk Score Calculation

Risk scoring identifies cards at elevated stockout risk. It is separate from priority scoring and produces actionable alerts.

### 6.1 Risk Inputs

| Input | Source | Description |
|-------|--------|-------------|
| **Triggered Age** (hours) | `NOW() - card.currentStageEnteredAt` | Time card has been waiting |
| **Stated Lead Time** (days) | `loop.statedLeadTimeDays` | Expected replenishment time |
| **Safety Stock Days** | `loop.safetyStockDays` | Buffer stock target |
| **Trigger Count** (lookback) | Count of `toStage = 'triggered'` transitions in last N days | Demand frequency |
| **Order Quantity** | `loop.orderQuantity` | Replenishment qty per cycle |
| **Min Quantity** | `loop.minQuantity` | Reorder point |

### 6.2 Risk Thresholds

Thresholds are dynamically calculated per card based on lead time and safety stock:

#### Age-Based Thresholds

```typescript
const leadTimeDays = max(1, loop.statedLeadTimeDays ?? 7);
const safetyStockDays = max(0, loop.safetyStockDays ?? 0);

const ageHighThreshold = max(12, round((leadTimeDays + safetyStockDays) * 24));  // hours
const ageMediumThreshold = max(8, round(ageHighThreshold * 0.75));               // hours
```

| Level | Condition | Meaning |
|-------|-----------|---------|
| **High** | `triggeredAgeHours >= ageHighThreshold` | Card has been waiting longer than lead time + safety stock |
| **Medium** | `triggeredAgeHours >= ageMediumThreshold` | Card is approaching critical wait time |
| None | Below both thresholds | No age-based risk |

#### Days-of-Supply Thresholds

```typescript
const estimatedDailyConsumption = (orderQuantity * triggerCount) / lookbackDays;
const estimatedDaysOfSupply = minQuantity / estimatedDailyConsumption;

const dosHighThreshold = round(max(1, min(3, (leadTimeDays + safetyStockDays) * 0.35)));
const dosMediumThreshold = round(max(dosHighThreshold + 1, min(7, dosHighThreshold + 2)));
```

| Level | Condition | Meaning |
|-------|-----------|---------|
| **High** | `estimatedDaysOfSupply <= dosHighThreshold` | Stockout imminent |
| **Medium** | `estimatedDaysOfSupply <= dosMediumThreshold` | Supply getting low |
| None | Above both thresholds | Adequate supply |

### 6.3 Risk Level Resolution

When both age and supply triggers fire, the **worst** (highest) risk level wins:

```typescript
// If either metric is 'high', overall risk is 'high'
// If one is 'medium' and neither is 'high', overall is 'medium'
let riskLevel: 'medium' | 'high' | null = null;

if (ageHours >= ageHighThreshold) riskLevel = 'high';
else if (ageHours >= ageMediumThreshold) riskLevel = 'medium';

if (estimatedDaysOfSupply <= dosHighThreshold) riskLevel = 'high';
else if (estimatedDaysOfSupply <= dosMediumThreshold) {
  riskLevel = riskLevel === 'high' ? 'high' : 'medium';
}
```

### 6.4 Risk Scan Execution

The risk scan runs in two modes:

| Mode | Trigger | Scope |
|------|---------|-------|
| **On-demand** | `GET /orders/queue/risk-scan` | Single tenant (from auth context) |
| **Scheduled** | `QueueRiskScheduler` (configurable interval) | All active tenants |

**Scan parameters:**

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `lookbackDays` | 30 | 7-90 | Window for calculating trigger frequency |
| `limit` | 100 | 1-200 | Maximum risk items returned |
| `minRiskLevel` | `medium` | `medium` or `high` | Filter threshold |
| `emitEvents` | `true` | boolean | Whether to publish `queue.risk_detected` events |

### 6.5 Risk Event Emission

When `emitEvents = true`, a `queue.risk_detected` event is published per risk item:

```typescript
{
  type: 'queue.risk_detected',
  tenantId: string,
  queueType: 'procurement' | 'production' | 'transfer',
  loopId: string,
  cardId: string,
  partId: string,
  facilityId: string,
  riskLevel: 'medium' | 'high',
  triggeredAgeHours: number,
  estimatedDaysOfSupply: number | null,
  reason: string,             // human-readable explanation
  timestamp: string
}
```

This event triggers notifications to relevant users (see `event-listener.ts`).

### 6.6 Risk Scan Sort Order

Risk results are sorted by:

1. **Primary**: `riskLevel` DESC (`high` before `medium`)
2. **Secondary**: `triggeredAgeHours` DESC (oldest waiting first)

---

## 7. Queue-to-Order Creation Flow

### 7.1 Purchase Order Creation

**Endpoint**: `POST /orders/queue/create-po`

**Input:**
```json
{
  "cardIds": ["uuid-1", "uuid-2"],
  "supplierId": "uuid-supplier",       // optional, defaults to loop's primarySupplierId
  "facilityId": "uuid-facility",       // optional, defaults to first card's loop facilityId
  "expectedDeliveryDate": "2025-01-15T00:00:00Z",  // optional
  "notes": "Urgent replenishment"       // optional
}
```

**Step-by-step execution:**

| Step | Action | Detail |
|------|--------|--------|
| 1 | **Authenticate** | Verify JWT. Extract `tenantId` from token. |
| 2 | **Validate input** | Parse with Zod schema. `cardIds` must be non-empty array of UUIDs. |
| 3 | **Fetch cards** | Load all cards by `cardIds` where `tenantId` matches. |
| 4 | **Validate cards** | All cards found (count matches). All belong to tenant. All in `triggered` stage. |
| 5 | **Fetch loops** | Load loops for all cards. Validate all are `procurement` type. |
| 6 | **Validate consolidation** | All cards share same `primarySupplierId` and `facilityId` (for consolidated POs). |
| 7 | **Begin transaction** | Start DB transaction. |
| 8 | **Generate PO number** | Call `getNextPONumber(tenantId)` — generates sequential `PO-XXXX` number. |
| 9 | **Insert PO** | Create `purchase_orders` row with `status = 'draft'`. |
| 10 | **Insert PO lines** | One line per card: `partId`, `quantityOrdered = loop.orderQuantity`, `lineNumber = i+1`. |
| 11 | **Transition cards** | For each card: update to `ordered`, set `linkedPurchaseOrderId`, insert `card_stage_transitions` row. |
| 12 | **Write audit** | Insert audit log for PO creation + per-card transition audit. |
| 13 | **Commit transaction** | All-or-nothing: if any step fails, everything rolls back. |
| 14 | **Emit events** | Publish `order.created` event. Publish `card.transition` event per card. |
| 15 | **Return response** | `201 Created` with `poId`, `poNumber`, `cardsLinked` count. |

### 7.2 Work Order Creation

**Endpoint**: `POST /orders/queue/create-wo`

**Input:**
```json
{
  "cardId": "uuid-1",
  "routingSteps": [
    {
      "workCenterId": "uuid-wc",
      "stepNumber": 1,
      "operationName": "Machining",
      "estimatedMinutes": 120
    }
  ],
  "scheduledStartDate": "2025-01-10T08:00:00Z",
  "scheduledEndDate": "2025-01-10T16:00:00Z",
  "notes": "Priority build"
}
```

**Key differences from PO creation:**
- Single card only (`cardId`, not `cardIds` array).
- Card must be from a `production` loop.
- Routing steps are optional but recommended.
- WO links via `linkedWorkOrderId`.

### 7.3 Transfer Order Creation

**Endpoint**: `POST /orders/queue/create-to`

**Input:**
```json
{
  "cardIds": ["uuid-1", "uuid-2"],
  "notes": "Weekly replenishment transfer"
}
```

**Key differences from PO creation:**
- Source facility comes from `loop.sourceFacilityId`.
- Destination facility comes from `loop.facilityId`.
- No supplier involved.
- TO lines track `quantityRequested`, `quantityShipped`, `quantityReceived`.

---

## 8. Queue Refresh Strategy

### 8.1 Real-Time Updates

The queue is kept current through:

1. **WebSocket push**: `card.transition` events are broadcast to connected clients via Redis pub/sub. The frontend subscribes to its tenant channel and updates the queue view in real-time.
2. **Polling fallback**: If WebSocket is unavailable, the frontend polls `GET /orders/queue` every 30 seconds.

### 8.2 Data Freshness

| Data Point | Freshness | Source |
|------------|-----------|--------|
| Card list in queue | Real-time (WebSocket) or 30s (polling) | `kanban_cards WHERE current_stage = 'triggered'` |
| Queue summary counts | Real-time or 30s | Aggregation query |
| Risk scores | On-demand or scheduled (default: every 15 minutes) | `runQueueRiskScanForTenant()` |
| Priority scores | Computed at query time | Calculated from current data |

### 8.3 Stale Data Handling

If a user attempts to create an order from stale queue data (e.g., a card was already ordered by another user):

1. The `transitionTriggeredCardToOrdered()` function checks `currentStage === 'triggered'`.
2. If the card is no longer in `triggered`, it throws `400: Card must be in triggered stage`.
3. The frontend should handle this gracefully: remove the card from the local queue view and show a notification.
4. No partial order creation: if any card in a batch fails validation, the entire transaction rolls back.
