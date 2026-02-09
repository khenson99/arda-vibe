# Arda V2 -- WebSocket & Event Catalog

> **Version**: 1.0.0
> **Last updated**: 2026-02-08
> **Status**: Living document

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Connection & Authentication](#connection--authentication)
3. [Channel Strategy](#channel-strategy)
4. [Redis Event Bus (Backend)](#redis-event-bus-backend)
5. [Socket.IO Events (Frontend)](#socketio-events-frontend)
6. [Event Type Reference](#event-type-reference)
7. [Client Interaction Events](#client-interaction-events)
8. [Notification Event Listener](#notification-event-listener)
9. [Event Flow Diagrams](#event-flow-diagrams)
10. [Versioning Strategy](#versioning-strategy)

---

## Architecture Overview

Arda V2 uses a two-layer real-time event system:

```
                 Service Layer                      Gateway                    Client
            +-----------------+                +--------------+          +----------+
            | orders service  | --publish-->  |              |          |          |
            | kanban service  | --publish-->  | Redis PubSub | -------> | Socket.IO|
            | catalog service | --publish-->  |  Event Bus   |          |  Client  |
            +-----------------+               +--------------+          +----------+
                                                     |
                                                     v
                                              +--------------+
                                              | Notification |
                                              |   Service    |
                                              | (global sub) |
                                              +--------------+
```

**Layer 1 -- Redis Pub/Sub (Backend)**: Inter-service event bus using `@arda/events`. Services publish `ArdaEvent` objects to Redis channels. Other services subscribe to process events asynchronously.

**Layer 2 -- Socket.IO (Frontend)**: The API gateway subscribes to tenant-scoped Redis channels and forwards events to connected Socket.IO clients in the matching tenant room.

### Key Design Decisions

- **Dual publish**: Every event is published to both a tenant-scoped channel and a global channel simultaneously
- **Fan-out at the gateway**: The gateway bridges Redis to Socket.IO, not individual services
- **No client-to-server events** (except control messages): Clients only receive; mutations go through REST
- **Singleton EventBus**: One shared instance per process via `getEventBus()`

---

## Connection & Authentication

### Transport

| Property | Value |
|---|---|
| **Protocol** | Socket.IO v4 (WebSocket with HTTP long-polling fallback) |
| **Path** | `/socket.io` |
| **CORS origin** | `config.APP_URL` |
| **Credentials** | Enabled |

### Authentication

JWT authentication is performed during the Socket.IO handshake. The client must provide a valid access token.

**Authentication methods** (in priority order):
1. `socket.handshake.auth.token` -- preferred (Socket.IO auth object)
2. `socket.handshake.headers.authorization` -- fallback (`Bearer <token>` header)

**Handshake flow**:
```
Client                                    Gateway
  |                                          |
  |  connect({ auth: { token: JWT } })       |
  |----------------------------------------->|
  |                                          | verifyAccessToken(token)
  |                                          | extract { sub, tenantId, role }
  |  'connected' { tenantId, userId, ts }    |
  |<-----------------------------------------|
  |                                          | join room: tenant:{tenantId}
  |                                          | subscribe to Redis: arda:events:{tenantId}
```

**Error responses**:
- Missing token: `Error('Authentication required')`
- Invalid/expired token: `Error('Invalid token')`

### Keepalive

| Mechanism | Interval | Timeout |
|---|---|---|
| **Transport-level** (Socket.IO built-in) | 25 seconds | 10 seconds |
| **Application-level** (custom ping/pong) | Client-initiated | Immediate response |

---

## Channel Strategy

### Redis Channels

| Channel Pattern | Purpose | Publisher | Subscriber |
|---|---|---|---|
| `arda:events:{tenantId}` | Tenant-scoped events | Any service | Gateway (per connected tenant) |
| `arda:events:global` | Cross-cutting events | Any service | Notification service |

Every event is published to **both** channels simultaneously. This allows:
- The gateway to subscribe only to channels for tenants with active WebSocket connections
- The notification service to process all events regardless of tenant connectivity

### Socket.IO Rooms

| Room Pattern | Join Trigger | Leave Trigger | Purpose |
|---|---|---|---|
| `tenant:{tenantId}` | Automatic on connection | Automatic on disconnect | All tenant events |
| `loop:{loopId}` | Client sends `subscribe:loop` | Client sends `unsubscribe:loop` | Loop-specific events |

**Room validation**: When a client requests `subscribe:loop`, the server verifies the loop exists and belongs to the client's tenant before joining the room. This prevents cross-tenant loop subscriptions.

---

## Redis Event Bus (Backend)

### ArdaEvent Union Type

The `@arda/events` package defines 6 event types (plus a derived notification event). All events share the `tenantId` and `timestamp` fields.

```typescript
type ArdaEvent =
  | CardTransitionEvent
  | OrderCreatedEvent
  | OrderStatusChangedEvent
  | LoopParameterChangedEvent
  | ReloWisaRecommendationEvent
  | NotificationEvent;
```

### EventBus API

```typescript
class EventBus {
  // Publish to both tenant and global channels
  publish(event: ArdaEvent): Promise<void>;

  // Subscribe to a specific tenant's events
  subscribeTenant(tenantId: string, handler: (event: ArdaEvent) => void): Promise<void>;

  // Subscribe to ALL events globally
  subscribeGlobal(handler: (event: ArdaEvent) => void): Promise<void>;

  // Unsubscribe from a tenant
  unsubscribeTenant(tenantId: string, handler: (event: ArdaEvent) => void): Promise<void>;

  // Health check
  ping(): Promise<boolean>;

  // Graceful shutdown
  shutdown(): Promise<void>;
}
```

---

## Socket.IO Events (Frontend)

### Server-to-Client Events

These events are emitted by the gateway to connected clients. The event name matches the `type` field of the underlying `ArdaEvent`.

| Socket.IO Event Name | Payload Type | Trigger |
|---|---|---|
| `connected` | `ConnectedPayload` | On successful handshake |
| `card.transition` | `CardTransitionEvent` | Card stage change |
| `order.created` | `OrderCreatedEvent` | New order created |
| `order.status_changed` | `OrderStatusChangedEvent` | Order status transition |
| `loop.parameters_changed` | `LoopParameterChangedEvent` | Loop parameters updated |
| `relowisa.recommendation` | `ReloWisaRecommendationEvent` | New ReLoWiSa recommendation |
| `notification.created` | `NotificationEvent` | New notification created |
| `pong` | `{ timestamp: string }` | Response to client ping |
| `error` | `{ message: string }` | Subscription or processing error |

### WSEventType Mapping (shared-types)

The `@arda/shared-types` package defines a separate `WSEventType` union for frontend consumption. The mapping from backend events to frontend event types:

| Backend Event (ArdaEvent.type) | Frontend WSEventType |
|---|---|
| `card.transition` | `card:stage_changed` or `card:triggered` |
| `order.created` + PO | `po:status_changed` |
| `order.status_changed` + PO | `po:status_changed` |
| `order.status_changed` + WO | `wo:status_changed` |
| `order.status_changed` + TO | `transfer:status_changed` |
| `notification.created` | `notification:new` |
| `relowisa.recommendation` | `relowisa:recommendation` |
| -- | `inventory:updated` `[PLANNED]` |

---

## Event Type Reference

### 1. CardTransitionEvent

Emitted when a kanban card transitions between stages.

```typescript
interface CardTransitionEvent {
  type: 'card.transition';
  tenantId: string;        // UUID
  cardId: string;          // UUID
  loopId: string;          // UUID
  fromStage: string | null; // null for initial creation
  toStage: string;         // CardStage value
  method: string;          // 'manual' | 'scan' | 'system'
  userId?: string;         // UUID, absent for system transitions
  timestamp: string;       // ISO 8601
}
```

**Producers**:
- `kanban/cards.routes.ts` -- POST /:id/transition
- `kanban/scan.routes.ts` -- POST /:cardId/trigger
- `orders/order-queue.routes.ts` -- POST /create-po, /create-wo, /create-to (triggered -> ordered)

**Valid `toStage` values**: `created`, `triggered`, `ordered`, `in_transit`, `received`, `restocked`

---

### 2. OrderCreatedEvent

Emitted when a new order is created.

```typescript
interface OrderCreatedEvent {
  type: 'order.created';
  tenantId: string;                                          // UUID
  orderType: 'purchase_order' | 'work_order' | 'transfer_order';
  orderId: string;                                           // UUID
  orderNumber: string;                                       // e.g., "PO-0001", "WO-0001", "TO-0001"
  linkedCardIds: string[];                                   // UUIDs of linked kanban cards
  timestamp: string;                                         // ISO 8601
}
```

**Producers**:
- `orders/purchase-orders.routes.ts` -- POST /
- `orders/work-orders.routes.ts` -- POST /
- `orders/transfer-orders.routes.ts` -- POST /
- `orders/order-queue.routes.ts` -- POST /create-po, /create-wo, /create-to

---

### 3. OrderStatusChangedEvent

Emitted when an order transitions between statuses.

```typescript
interface OrderStatusChangedEvent {
  type: 'order.status_changed';
  tenantId: string;                                          // UUID
  orderType: 'purchase_order' | 'work_order' | 'transfer_order';
  orderId: string;                                           // UUID
  orderNumber: string;
  fromStatus: string;                                        // Previous status
  toStatus: string;                                          // New status
  timestamp: string;                                         // ISO 8601
}
```

**Producers**:
- `orders/purchase-orders.routes.ts` -- PATCH /:id/status, PATCH /:id/receive
- `orders/work-orders.routes.ts` -- PATCH /:id/status
- `orders/transfer-orders.routes.ts` -- PATCH /:id/status

---

### 4. LoopParameterChangedEvent

Emitted when a kanban loop's parameters are updated.

```typescript
interface LoopParameterChangedEvent {
  type: 'loop.parameters_changed';
  tenantId: string;    // UUID
  loopId: string;      // UUID
  changeType: string;  // 'manual' | 'relowisa'
  reason: string;      // User-provided reason for the change
  timestamp: string;   // ISO 8601
}
```

**Producers**:
- `kanban/loops.routes.ts` -- PATCH /:id/parameters

---

### 5. ReloWisaRecommendationEvent

Emitted when the ReLoWiSa engine generates a new parameter recommendation.

```typescript
interface ReloWisaRecommendationEvent {
  type: 'relowisa.recommendation';
  tenantId: string;          // UUID
  loopId: string;            // UUID
  recommendationId: string;  // UUID
  confidenceScore: number;   // 0-100
  timestamp: string;         // ISO 8601
}
```

**Producers**:
- ReLoWiSa engine (background process) `[PLANNED]`

---

### 6. NotificationEvent

Emitted after a notification is persisted to the database.

```typescript
interface NotificationEvent {
  type: 'notification.created';
  tenantId: string;          // UUID
  userId: string;            // UUID -- target user
  notificationId: string;    // UUID
  notificationType: string;  // NotificationType value
  title: string;
  timestamp: string;         // ISO 8601
}
```

**Producers**:
- `notifications/services/event-listener.ts` -- after creating notification rows

This event is a **secondary event**: it is produced as a side-effect of processing other events. The notification service subscribes globally, creates notification database rows, and then publishes `notification.created` for each inserted notification so the WebSocket layer can push them to clients.

---

## Client Interaction Events

### Client-to-Server Events

| Event Name | Payload | Description |
|---|---|---|
| `ping` | (none) | Application-level keepalive request |
| `subscribe:loop` | `loopId: string` | Request loop-specific event updates |
| `unsubscribe:loop` | `loopId: string` | Stop receiving loop-specific events |

### Server-to-Client Control Events

| Event Name | Payload | Description |
|---|---|---|
| `connected` | `{ tenantId, userId, timestamp }` | Confirmation of successful connection |
| `pong` | `{ timestamp: string }` | Response to client `ping` |
| `error` | `{ message: string }` | Error during subscription or processing |

---

## Notification Event Listener

The notification service subscribes to the global Redis channel and creates in-app notifications based on event type. This is the primary consumer of the global event stream.

### Event-to-Notification Mapping

| Source Event | Condition | Notification Type | Title |
|---|---|---|---|
| `card.transition` | `toStage` in `[triggered, received, restocked]` | `card_triggered` | "Kanban card moved to {stage}" |
| `order.created` | Always | `po_created` | "New {orderType} created" |
| `order.status_changed` + PO `sent` | `toStatus === 'sent'` | `po_sent` | "Purchase order sent" |
| `order.status_changed` + PO `received` | `toStatus === 'received'` | `po_received` | "Purchase order received" |
| `order.status_changed` + PO `partially_received` | `toStatus === 'partially_received'` | `po_received` | "Purchase order partially received" |
| `order.status_changed` + PO (other) | Any other PO status | `system_alert` | "Purchase order status updated" |
| `order.status_changed` + WO | Always | `wo_status_change` | "Work order status updated" |
| `order.status_changed` + TO | Always | `transfer_status_change` | "Transfer order status updated" |
| `relowisa.recommendation` | Always | `relowisa_recommendation` | "New ReLoWiSa recommendation" |

### Notification Distribution

When a notification is created, it is inserted for **all active users** in the tenant (unless a specific `userId` is provided). After insertion, a `notification.created` event is published per user to enable real-time WebSocket push.

### Notification Types (Complete List)

```typescript
type NotificationType =
  | 'card_triggered'
  | 'po_created'
  | 'po_sent'
  | 'po_received'
  | 'stockout_warning'
  | 'relowisa_recommendation'
  | 'exception_alert'
  | 'wo_status_change'
  | 'transfer_status_change'
  | 'system_alert';
```

### Notification Channels

Each notification type can be delivered through three channels, controlled by user preferences:

| Channel | DB Value | Default Enabled |
|---|---|---|
| In-App | `in_app` | Yes (all types) |
| Email | `email` | Yes for: `po_created`, `po_received`, `stockout_warning`, `exception_alert`, `system_alert` |
| Webhook | `webhook` | Yes for: `exception_alert` only |

---

## Event Flow Diagrams

### Card Trigger to Order Creation

```
[Shop Floor Scan]
       |
       v
  POST /scan/:id/trigger
       |
       v
  card.transition (triggered)  ---------> [Notification Service]
       |                                         |
       v                                         v
  [Card appears in Order Queue]           notification.created
       |                                         |
       v                                         v
  POST /queue/create-po                   [Socket.IO push to client]
       |
       +---> order.created  ----------------> [Notification Service]
       |                                         |
       +---> card.transition (ordered) x N       v
                                          notification.created
```

### Purchase Order Lifecycle

```
  POST /purchase-orders (draft)
       |
       v
  order.created  --> notification (po_created)
       |
       v
  PATCH /:id/status (sent)
       |
       v
  order.status_changed --> notification (po_sent)
       |
       v
  PATCH /:id/receive
       |
       v
  order.status_changed (partially_received or received)
       |
       v
  notification (po_received)
```

---

## Versioning Strategy

### Current State

Events are currently unversioned. The `type` field serves as the event identifier.

### Planned Approach `[PLANNED]`

- **Schema versioning**: Add an optional `schemaVersion` field to all events (default `1`)
- **Backward compatibility**: New fields are always optional; existing fields are never removed
- **Consumer tolerance**: All event consumers must ignore unknown fields (open/closed principle)
- **Breaking changes**: If an event schema must break, publish under a new `type` value (e.g., `card.transition.v2`) while continuing to publish the v1 format during a deprecation window
- **Deprecation period**: Minimum 90 days of dual-publishing before removing old format

### Event Envelope `[PLANNED]`

Future events may be wrapped in a standardized envelope:

```typescript
interface EventEnvelope<T extends ArdaEvent> {
  id: string;           // UUID, unique event ID for idempotency
  schemaVersion: number; // Schema version
  source: string;        // Producing service name
  correlationId?: string; // For tracing across services
  event: T;              // The actual event payload
}
```

---

*End of WebSocket & Event Catalog Specification*
