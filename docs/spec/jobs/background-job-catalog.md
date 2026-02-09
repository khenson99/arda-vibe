# Arda V2 -- Background Job Catalog

> **Version**: 1.0.0
> **Last updated**: 2026-02-08
> **Status**: Living document

---

## Table of Contents

1. [Overview](#overview)
2. [Infrastructure](#infrastructure)
3. [Existing Background Processes](#existing-background-processes)
4. [Proposed Jobs](#proposed-jobs)
5. [Job Scheduling Strategy](#job-scheduling-strategy)
6. [Monitoring & Observability](#monitoring--observability)

---

## Overview

This document catalogs all background processes, async workers, and event-driven jobs in the Arda V2 system. It covers both **existing** processes that are already implemented and **proposed** jobs that are recommended for future implementation.

### Job Categories

| Category | Description |
|---|---|
| **Event-driven** | Triggered by Redis pub/sub events; runs immediately |
| **Scheduled** | Runs on a cron-like schedule; periodic maintenance |
| **On-demand** | Triggered by an API call or user action |

---

## Infrastructure

### Current Stack

| Component | Technology | Purpose |
|---|---|---|
| Event bus | Redis Pub/Sub (`@arda/events`) | Inter-service event delivery |
| Database | PostgreSQL (Drizzle ORM) | Persistent storage for job results |
| Process model | Long-running Node.js processes | Each service runs its own event listeners |

### Planned Infrastructure `[PLANNED]`

| Component | Technology | Purpose |
|---|---|---|
| Job queue | BullMQ (Redis-backed) | Reliable job scheduling with retry, backoff, priorities |
| Cron scheduler | `node-cron` or BullMQ repeatable jobs | Periodic job execution |
| Dead-letter queue | BullMQ DLQ | Failed job inspection and replay |

---

## Existing Background Processes

### 1. Notification Event Listener

| Property | Value |
|---|---|
| **ID** | `notification-event-listener` |
| **Category** | Event-driven |
| **Service** | notifications |
| **Source file** | `services/notifications/src/services/event-listener.ts` |
| **Status** | Implemented |

**Description**: Subscribes to the global Redis event channel (`arda:events:global`) and creates notification rows for all active tenant users when relevant events are received. After inserting notifications, publishes `notification.created` events per user for real-time WebSocket delivery.

**Trigger**: Any `ArdaEvent` published to the global channel.

**Events handled**:

| Event Type | Condition | Action |
|---|---|---|
| `card.transition` | `toStage` in `[triggered, received, restocked]` | Create `card_triggered` notification |
| `order.created` | Always | Create `po_created` notification |
| `order.status_changed` | PO sent | Create `po_sent` notification |
| `order.status_changed` | PO received / partially received | Create `po_received` notification |
| `order.status_changed` | PO other statuses | Create `system_alert` notification |
| `order.status_changed` | Work order | Create `wo_status_change` notification |
| `order.status_changed` | Transfer order | Create `transfer_status_change` notification |
| `relowisa.recommendation` | Always | Create `relowisa_recommendation` notification |

**Side effects**:
- Inserts N notification rows (one per active tenant user)
- Publishes N `notification.created` events

**Error handling**: Catches and logs errors per event; does not crash the listener on individual failures.

**Performance characteristics**:
- Fan-out: 1 event -> N notifications (N = active users in tenant)
- DB writes: 1 batch insert + N event publishes
- No rate limiting or batching currently applied

---

### 2. WebSocket Event Bridge

| Property | Value |
|---|---|
| **ID** | `websocket-event-bridge` |
| **Category** | Event-driven |
| **Service** | api-gateway |
| **Source file** | `services/api-gateway/src/ws/socket-handler.ts` |
| **Status** | Implemented |

**Description**: For each connected WebSocket client, subscribes to the tenant's Redis event channel and forwards all events to the Socket.IO room `tenant:{tenantId}`. This bridges the backend Redis pub/sub to frontend clients.

**Trigger**: WebSocket client connection (subscribes) and any `ArdaEvent` on the tenant channel (forwards).

**Lifecycle**:
1. Client connects with valid JWT
2. Server joins client to `tenant:{tenantId}` room
3. Server subscribes to `arda:events:{tenantId}` Redis channel
4. Every event on that channel is emitted to the room via `io.to().emit()`
5. On disconnect, the Redis subscription handler is removed

**Error handling**: Redis message parse errors are logged; malformed events are dropped silently.

---

### 3. Order Queue Event Emitter

| Property | Value |
|---|---|
| **ID** | `order-queue-event-emitter` |
| **Category** | On-demand (triggered by API call) |
| **Service** | orders |
| **Source file** | `services/orders/src/routes/order-queue.routes.ts` |
| **Status** | Implemented |

**Description**: When an order is created from the order queue (via `POST /queue/create-po`, `/create-wo`, or `/create-to`), this process emits both `order.created` and `card.transition` events for all cards that were transitioned from `triggered` to `ordered`.

**Trigger**: Successful order creation from the order queue API endpoints.

**Events emitted**:
- `order.created` (1 per order)
- `card.transition` (1 per transitioned card)

**Error handling**: Event publishing failures are caught and logged; the order creation itself is not rolled back if event emission fails.

---

### 4. Order Status Event Emitter

| Property | Value |
|---|---|
| **ID** | `order-status-event-emitter` |
| **Category** | On-demand (triggered by API call) |
| **Service** | orders |
| **Source file** | `services/orders/src/routes/purchase-orders.routes.ts`, `work-orders.routes.ts`, `transfer-orders.routes.ts` |
| **Status** | Implemented |

**Description**: When an order's status changes (via explicit status transition or auto-transition from receive operations), an `order.status_changed` event is published. This enables the notification service and WebSocket layer to react to status changes.

**Trigger**: Successful status transition on any order type.

**Events emitted**: `order.status_changed`

**Auto-transition scenarios**:
- PO receive: `sent/acknowledged` -> `partially_received` -> `received`
- TO ship: auto-transitions to `shipped` when all lines shipped
- TO receive: auto-transitions to `received` when all lines received

---

### 5. Audit Logger

| Property | Value |
|---|---|
| **ID** | `audit-logger` |
| **Category** | On-demand (inline with API requests) |
| **Service** | orders |
| **Source files** | All order route files |
| **Status** | Implemented |

**Description**: Writes structured audit log entries for all write operations in the orders service. Runs within the same database transaction as the primary operation to ensure consistency.

**Audit actions recorded**:

| Action | Entity Type | Trigger |
|---|---|---|
| `purchase_order.created` | `purchase_order` | POST /purchase-orders |
| `purchase_order.status_changed` | `purchase_order` | PATCH /purchase-orders/:id/status |
| `purchase_order.line_added` | `purchase_order` | POST /purchase-orders/:id/lines |
| `purchase_order.lines_received` | `purchase_order` | PATCH /purchase-orders/:id/receive |
| `work_order.created` | `work_order` | POST /work-orders |
| `work_order.status_changed` | `work_order` | PATCH /work-orders/:id/status |
| `work_order.routing_updated` | `work_order` | PATCH /work-orders/:id/routings/:id |
| `work_order.production_updated` | `work_order` | PATCH /work-orders/:id/production |
| `transfer_order.created` | `transfer_order` | POST /transfer-orders |
| `transfer_order.status_changed` | `transfer_order` | PATCH /transfer-orders/:id/status |
| `transfer_order.lines_shipped` | `transfer_order` | PATCH /transfer-orders/:id/ship |
| `transfer_order.lines_received` | `transfer_order` | PATCH /transfer-orders/:id/receive |
| `work_center.created` | `work_center` | POST /work-centers |
| `work_center.updated` | `work_center` | PATCH /work-centers/:id |
| `work_center.deleted` | `work_center` | DELETE /work-centers/:id |
| `order_queue.purchase_order_created` | `purchase_order` | POST /queue/create-po |
| `order_queue.work_order_created` | `work_order` | POST /queue/create-wo |
| `order_queue.transfer_order_created` | `transfer_order` | POST /queue/create-to |
| `kanban_card.transitioned_to_ordered` | `kanban_card` | POST /queue/create-* |

**Audit record structure**:
```json
{
  "tenantId": "uuid",
  "userId": "uuid",
  "action": "string",
  "entityType": "string",
  "entityId": "uuid",
  "previousState": { ... },
  "newState": { ... },
  "metadata": { "source": "string", ... },
  "ipAddress": "string (max 45 chars)",
  "userAgent": "string",
  "timestamp": "datetime"
}
```

---

## Proposed Jobs

### 6. ReLoWiSa Recalculation Engine `[PLANNED]`

| Property | Value |
|---|---|
| **ID** | `relowisa-recalculation` |
| **Category** | Scheduled |
| **Service** | kanban (new worker process) |
| **Priority** | High |
| **Estimated effort** | 3-5 days |

**Description**: Periodically recalculates optimal kanban loop parameters (min quantity, order quantity, number of cards) using the ReLoWiSa algorithm. Analyzes historical cycle data, demand patterns, and lead time variability to generate parameter recommendations.

**Schedule**: Every 24 hours at 02:00 UTC (configurable per tenant).

**Input**:
- Loop parameter history (`kanban_parameter_history` table)
- Card transition history (cycle times, lead times)
- Demand data (consumption rates)
- Supplier lead time variability

**Processing logic**:
1. For each active kanban loop in each tenant:
   a. Calculate average cycle time from last 90 days of card transitions
   b. Calculate demand variability (standard deviation of daily consumption)
   c. Calculate lead time variability from supplier/production data
   d. Apply ReLoWiSa algorithm to compute optimal parameters
   e. Compare with current parameters; if change exceeds threshold (>10%), create recommendation
2. Insert recommendation into `relowisa_recommendations` table
3. Publish `relowisa.recommendation` event per recommendation

**Output**:
- New rows in `relowisa_recommendations` table
- `relowisa.recommendation` events (triggers notifications)

**Error handling**:
- Process loops independently; failure in one loop does not affect others
- Log errors per loop with full context
- DLQ for loops that fail 3 consecutive times

**Idempotency**: Use a daily run key (`relowisa:{tenantId}:{loopId}:{date}`) to prevent duplicate calculations.

---

### 7. Order Aging & Escalation `[PLANNED]`

| Property | Value |
|---|---|
| **ID** | `order-aging-escalation` |
| **Category** | Scheduled |
| **Service** | orders (new worker process) |
| **Priority** | High |
| **Estimated effort** | 2-3 days |

**Description**: Monitors order age and escalates overdue orders. Identifies POs past their expected delivery date, WOs past their scheduled end date, and cards stuck in `triggered` or `ordered` stage beyond configurable thresholds.

**Schedule**: Every 6 hours.

**Processing logic**:
1. **Overdue POs**: Find POs where `expectedDeliveryDate < NOW()` and status in `[sent, acknowledged, partially_received]`
   - Mark as at-risk in metadata
   - Create `exception_alert` notification: "PO {number} is {N} days overdue"
2. **Stale triggered cards**: Find cards in `triggered` stage for more than 48 hours (configurable)
   - Create `stockout_warning` notification
3. **Overdue WOs**: Find WOs where `scheduledEndDate < NOW()` and status in `[scheduled, in_progress]`
   - Create `exception_alert` notification
4. **Stuck orders**: Find orders in `draft` status for more than 7 days
   - Create `system_alert` notification

**Output**:
- Notifications for overdue/at-risk items
- `[PLANNED]` Optional: Auto-status update for severely overdue items

**Error handling**: Per-order processing; failures logged and skipped.

**Configuration** (per tenant, stored in tenant settings):
```json
{
  "orderAging": {
    "triggeredCardThresholdHours": 48,
    "draftOrderThresholdDays": 7,
    "overduePoGraceDays": 0,
    "overdueWoGraceDays": 0
  }
}
```

---

### 8. Stale Card Cleanup `[PLANNED]`

| Property | Value |
|---|---|
| **ID** | `stale-card-cleanup` |
| **Category** | Scheduled |
| **Service** | kanban (new worker process) |
| **Priority** | Medium |
| **Estimated effort** | 1-2 days |

**Description**: Identifies and handles kanban cards that have been stuck in intermediate stages for abnormally long periods. This prevents cards from getting lost in the system and ensures loop velocity metrics remain accurate.

**Schedule**: Daily at 03:00 UTC.

**Processing logic**:
1. Find cards in `ordered` stage for more than 60 days (no linked order status change)
2. Find cards in `in_transit` stage for more than 30 days
3. Find deactivated cards (`isActive = false`) with no activity for 90 days
4. For stuck active cards:
   - Create `exception_alert` notification with card details
   - Add metadata tag `stale_card_flagged` to card
5. For deactivated cards with no activity:
   - Archive card data (move to `kanban_cards_archive` table) `[PLANNED]`
   - Remove from active queries

**Output**:
- Notifications for stuck cards
- Metadata updates on flagged cards
- `[PLANNED]` Archived card records

**Configuration**:
```json
{
  "staleCardCleanup": {
    "orderedStaleThresholdDays": 60,
    "inTransitStaleThresholdDays": 30,
    "inactiveArchiveThresholdDays": 90
  }
}
```

---

### 9. Scheduled Report Generation `[PLANNED]`

| Property | Value |
|---|---|
| **ID** | `scheduled-report-generation` |
| **Category** | Scheduled |
| **Service** | New `reports` service |
| **Priority** | Medium |
| **Estimated effort** | 5-8 days |
| **Plan requirement** | `pro` or `enterprise` |

**Description**: Generates and delivers scheduled reports to users. Supports multiple report types and delivery methods. Reports are generated as PDFs or CSVs and delivered via email or stored for download.

**Schedule**: Configurable per report subscription (daily, weekly, monthly).

**Report types**:

| Report ID | Name | Description |
|---|---|---|
| `order-summary` | Order Summary | PO/WO/TO counts, values, and status breakdown for period |
| `velocity-report` | Kanban Velocity | Cycle times, throughput, and efficiency metrics per loop |
| `inventory-movement` | Inventory Movement | Parts received, consumed, and transferred for period |
| `supplier-performance` | Supplier Performance | Lead time accuracy, order fulfillment rates per supplier |
| `audit-trail` | Audit Trail | Filtered audit log export for compliance |
| `exception-report` | Exception Report | Overdue orders, stuck cards, and anomalies |

**Processing logic**:
1. Check report subscriptions due for generation
2. For each due subscription:
   a. Query relevant data for the reporting period
   b. Generate report in requested format (PDF/CSV)
   c. Store report file (S3 or local storage)
   d. Send delivery notification with download link
   e. If email delivery enabled, attach report to email

**Output**:
- Generated report files
- `notification.created` events for report availability

**Data model** `[PLANNED]`:
```sql
CREATE TABLE report_subscriptions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  report_type VARCHAR(50) NOT NULL,
  schedule VARCHAR(20) NOT NULL,  -- 'daily', 'weekly', 'monthly'
  parameters JSONB DEFAULT '{}',
  delivery_method VARCHAR(20) DEFAULT 'in_app',  -- 'in_app', 'email', 'both'
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE generated_reports (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  subscription_id UUID REFERENCES report_subscriptions(id),
  report_type VARCHAR(50) NOT NULL,
  file_url TEXT NOT NULL,
  file_format VARCHAR(10) NOT NULL,  -- 'pdf', 'csv'
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### 10. Notification Digest `[PLANNED]`

| Property | Value |
|---|---|
| **ID** | `notification-digest` |
| **Category** | Scheduled |
| **Service** | notifications |
| **Priority** | Medium |
| **Estimated effort** | 2-3 days |

**Description**: Aggregates unread notifications into a periodic digest email for users who have email delivery enabled. Prevents notification fatigue by batching updates instead of sending individual emails for each event.

**Schedule**: Configurable per user (immediate, hourly, daily at 08:00 local time).

**Processing logic**:
1. For each user with digest preference enabled:
   a. Query unread notifications since last digest
   b. Group by notification type
   c. Generate digest email with summary counts and top items
   d. Send email via configured email provider
   e. Mark notifications as "digest_sent" (without marking as read)
2. Track last digest timestamp per user

**Output**:
- Digest emails sent to users
- Updated `last_digest_at` timestamp per user

**Digest email structure**:
```
Subject: Arda Daily Digest -- {date}

Summary:
- 3 new purchase orders created
- 2 cards triggered
- 1 overdue order alert

Recent Activity:
1. PO-0042 was sent to Acme Corp
2. Card #7 in Loop "Widget A" was triggered
3. WO-0015 status changed to in_progress
...

[View all notifications ->]
```

**Configuration** (per user in notification preferences):
```json
{
  "digest": {
    "enabled": true,
    "frequency": "daily",  // 'immediate' | 'hourly' | 'daily'
    "deliveryHour": 8,     // Local hour for daily digest
    "timezone": "America/New_York"
  }
}
```

---

### 11. Data Export `[PLANNED]`

| Property | Value |
|---|---|
| **ID** | `data-export` |
| **Category** | On-demand |
| **Service** | New `exports` worker |
| **Priority** | Low |
| **Estimated effort** | 3-4 days |
| **Plan requirement** | `starter` or higher |

**Description**: Handles large data export requests asynchronously. When a user requests an export of orders, parts, audit logs, or other data, the job processes the request in the background and notifies the user when the file is ready for download.

**Trigger**: `POST /api/exports` endpoint (creates export job).

**Export types**:

| Export ID | Source | Formats |
|---|---|---|
| `orders` | Purchase orders, work orders, transfer orders | CSV, XLSX |
| `parts-catalog` | Parts with categories and suppliers | CSV, XLSX |
| `audit-log` | Audit log entries | CSV |
| `kanban-cards` | Cards with loop details and history | CSV |
| `velocity-data` | Loop velocity metrics | CSV |

**Processing logic**:
1. Validate export request (type, filters, format)
2. Create export job record with status `pending`
3. Queue job in BullMQ
4. Worker processes:
   a. Update status to `processing`
   b. Stream data from database with pagination (1000 rows per batch)
   c. Write to temporary file in requested format
   d. Upload to file storage (S3 or local)
   e. Update status to `completed` with download URL
   f. Publish notification for the requesting user
5. Download URL expires after 24 hours

**Output**:
- Export file stored in file storage
- `notification.created` event when export is ready
- Export job record with download URL

**Error handling**:
- Retry up to 3 times with exponential backoff
- On permanent failure, update status to `failed` with error message
- Notify user of failure

**Data model** `[PLANNED]`:
```sql
CREATE TABLE export_jobs (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  export_type VARCHAR(50) NOT NULL,
  format VARCHAR(10) NOT NULL,
  filters JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'pending',  -- pending, processing, completed, failed
  file_url TEXT,
  file_size_bytes BIGINT,
  row_count INT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Job Scheduling Strategy

### Execution Order (Scheduled Jobs)

To avoid resource contention, scheduled jobs should run in a staggered sequence:

| Time (UTC) | Job | Duration (est.) |
|---|---|---|
| 02:00 | ReLoWiSa Recalculation | 15-60 min |
| 03:00 | Stale Card Cleanup | 5-15 min |
| 04:00 | Order Aging & Escalation | 5-15 min |
| 06:00 | Scheduled Report Generation | 10-30 min |
| 08:00* | Notification Digest (daily) | 5-10 min |

*08:00 is per-user local time; the job runs hourly and checks which users are due.

### Retry Policy `[PLANNED]`

| Job Type | Max Retries | Backoff | Dead-Letter |
|---|---|---|---|
| Event-driven | 3 | Exponential (1s, 4s, 16s) | Yes |
| Scheduled | 2 | Fixed (5 min) | Yes |
| On-demand | 3 | Exponential (5s, 25s, 125s) | Yes |

### Concurrency `[PLANNED]`

| Job | Max Concurrent | Rationale |
|---|---|---|
| ReLoWiSa Recalculation | 1 per tenant | Heavy computation, avoid contention |
| Report Generation | 3 | I/O-bound, moderate parallelism |
| Data Export | 5 | I/O-bound, high parallelism safe |
| All others | 10 | Default concurrency |

---

## Monitoring & Observability

### Existing Monitoring

| What | How | Location |
|---|---|---|
| Event listener errors | `console.error` | stdout / container logs |
| Event parse failures | Structured log via `createLogger` | stdout |
| WebSocket connections | Structured log (`ws` namespace) | stdout |
| Audit trail | PostgreSQL `audit_log` table | Database |

### Proposed Monitoring `[PLANNED]`

| Metric | Type | Alert Threshold |
|---|---|---|
| `job.execution.duration` | Histogram | > 2x average |
| `job.execution.failures` | Counter | > 5 per hour |
| `job.queue.depth` | Gauge | > 100 pending |
| `job.dlq.size` | Gauge | > 0 (any DLQ entry) |
| `event.publish.latency` | Histogram | > 500ms p99 |
| `event.handler.duration` | Histogram | > 1s per event |
| `notification.fanout.count` | Counter | Track for capacity planning |

### Health Check Endpoints `[PLANNED]`

Each service's `/health` endpoint should include job system health:

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T09:30:00.000Z",
  "jobs": {
    "redis": "connected",
    "queue": {
      "active": 2,
      "waiting": 5,
      "failed": 0,
      "dlq": 0
    }
  }
}
```

---

*End of Background Job Catalog Specification*
