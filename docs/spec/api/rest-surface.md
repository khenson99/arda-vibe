# Arda V2 -- REST API Surface Specification

> **Version**: 1.0.0
> **Last updated**: 2026-02-08
> **Status**: Living document -- updated as endpoints are added or modified

---

## Table of Contents

1. [Overview](#overview)
2. [Conventions](#conventions)
3. [Authentication & Authorization](#authentication--authorization)
4. [Rate Limiting](#rate-limiting)
5. [Auth Service](#1-auth-service)
6. [Catalog Service](#2-catalog-service)
7. [Kanban Service](#3-kanban-service)
8. [Orders Service](#4-orders-service)
9. [Notifications Service](#5-notifications-service)
10. [API Gateway](#6-api-gateway)
11. [Error Responses](#error-responses)
12. [Versioning Strategy](#versioning-strategy)

---

## Overview

Arda V2 exposes a REST API through a single **API Gateway** (`api-gateway` service) that proxies requests to five upstream microservices. All paths below are relative to the gateway base URL unless marked otherwise.

| Gateway Prefix | Upstream Service | Auth Required |
|---|---|---|
| `/api/auth` | auth | No (public) |
| `/api/tenants` | auth | Yes (JWT) |
| `/api/catalog` | catalog | Yes (JWT) |
| `/api/kanban` | kanban | Yes (JWT) |
| `/api/orders` | orders | Yes (JWT) |
| `/api/notifications` | notifications | Yes (JWT) |
| `/scan` | kanban | No (public, GET only) |

---

## Conventions

### Request / Response Format

- All request and response bodies use `application/json`.
- UUIDs are v4 format: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.
- Datetime strings use ISO 8601: `2024-01-15T09:30:00.000Z`.
- Monetary values are strings with two decimal places: `"125.50"`.

### Pagination

Two pagination patterns are in use:

**Pattern A -- Page-based** (most endpoints):
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 142,
    "pages": 8
  }
}
```

**Pattern B -- Offset-based** (notifications, work orders):
```json
{
  "data": [...],
  "count": 50
}
```

Query parameters: `page` (1-indexed), `limit` / `pageSize`, `offset`.

### Tenant Isolation

Every query is scoped to `tenantId` extracted from the JWT. No cross-tenant data access is possible through the API.

---

## Authentication & Authorization

### JWT Structure

Authenticated requests must include an `Authorization: Bearer <token>` header. The JWT payload contains:

| Field | Type | Description |
|---|---|---|
| `sub` | UUID | User ID |
| `tenantId` | UUID | Tenant ID |
| `role` | string | One of the 7 `UserRole` values |
| `email` | string | User email |
| `iat` | number | Issued-at timestamp |
| `exp` | number | Expiry timestamp |

### User Roles

```
tenant_admin | inventory_manager | procurement_manager |
receiving_manager | ecommerce_director | salesperson | executive
```

Role-based restrictions are noted per-endpoint where applicable. Most endpoints require any authenticated role unless otherwise specified.

---

## Rate Limiting

| Tier | Window | Max Requests | Applied To |
|---|---|---|---|
| Standard | 15 minutes | 1,000 | All authenticated endpoints |
| Auth | 15 minutes | 30 | `/api/auth/*` |

Rate limit headers returned: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

---

## 1. Auth Service

**Gateway prefix**: `/api/auth`

### POST /api/auth/register

Create a new user account and tenant.

| Property | Value |
|---|---|
| **Auth** | None (public) |
| **Rate limit** | Auth tier (30/15min) |

**Request body**:
```json
{
  "email": "string (email, required)",
  "password": "string (min 8 chars, required)",
  "firstName": "string (max 100, required)",
  "lastName": "string (max 100, required)",
  "companyName": "string (max 255, required)",
  "companySlug": "string (max 100, optional)"
}
```

**Response** `201`:
```json
{
  "accessToken": "string (JWT)",
  "refreshToken": "string",
  "user": { "id", "email", "firstName", "lastName", "role", "tenantId" }
}
```

---

### POST /api/auth/login

Authenticate with email and password.

| Property | Value |
|---|---|
| **Auth** | None (public) |
| **Rate limit** | Auth tier |

**Request body**:
```json
{
  "email": "string (email, required)",
  "password": "string (required)"
}
```

**Response** `200`: Same shape as register response.

---

### POST /api/auth/refresh

Exchange a refresh token for a new access token.

| Property | Value |
|---|---|
| **Auth** | None (public) |
| **Rate limit** | Auth tier |

**Request body**:
```json
{
  "refreshToken": "string (required)"
}
```

**Response** `200`:
```json
{
  "accessToken": "string (JWT)",
  "refreshToken": "string"
}
```

---

### POST /api/auth/google

Authenticate via Google OAuth using an ID token from the frontend.

| Property | Value |
|---|---|
| **Auth** | None (public) |
| **Rate limit** | Auth tier |

**Request body**:
```json
{
  "idToken": "string (Google ID token, required)"
}
```

**Response** `200`: Same shape as login response.

---

### GET /api/auth/me

Get the current authenticated user's profile.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Rate limit** | Standard |

**Response** `200`:
```json
{
  "id": "uuid",
  "email": "string",
  "firstName": "string",
  "lastName": "string",
  "role": "UserRole",
  "avatarUrl": "string | null",
  "tenantId": "uuid",
  "tenantName": "string",
  "tenantSlug": "string",
  "tenantLogo": "string | null"
}
```

---

### POST /api/auth/logout

Revoke all refresh tokens for the current user.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Rate limit** | Standard |

**Response** `200`:
```json
{ "message": "Logged out successfully" }
```

---

## Tenant Management

**Gateway prefix**: `/api/tenants`

### GET /api/tenants/current

Get the current tenant's details.

| Property | Value |
|---|---|
| **Auth** | JWT required (any role) |

**Response** `200`: Tenant object with `id`, `name`, `slug`, `logoUrl`, `settings`, `planId`, `seatLimit`.

---

### PATCH /api/tenants/current

Update the current tenant's settings.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Roles** | `tenant_admin` only |

**Request body**:
```json
{
  "name": "string (optional)",
  "logoUrl": "string (optional)",
  "settings": "object (optional)"
}
```

---

### GET /api/tenants/current/users

List all users in the current tenant.

| Property | Value |
|---|---|
| **Auth** | JWT required (any role) |

**Response** `200`: Array of user objects.

---

### POST /api/tenants/current/users

Invite/create a new user in the current tenant. Checks seat limits based on plan.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Roles** | `tenant_admin` only |

**Request body**:
```json
{
  "email": "string (email, required)",
  "firstName": "string (required)",
  "lastName": "string (required)",
  "role": "UserRole (required)"
}
```

---

## 2. Catalog Service

**Gateway prefix**: `/api/catalog`

### Categories

#### GET /api/catalog/categories

List all categories for the tenant, ordered by `sortOrder`.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Response** `200`: `{ data: Category[] }`.

---

#### POST /api/catalog/categories

Create a new category.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Request body**:
```json
{
  "name": "string (required)",
  "parentCategoryId": "uuid (optional)",
  "description": "string (optional)",
  "sortOrder": "number (optional)"
}
```

**Response** `201`: Created category object.

---

#### PATCH /api/catalog/categories/:id

Update an existing category.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Request body**: Same fields as create, all optional.

---

### Parts

#### GET /api/catalog/parts

List parts with pagination, search, and filters.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A |

**Query parameters**:

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | int | 1 | Page number |
| `pageSize` | int | 25 | Items per page (max 100) |
| `search` | string | -- | Searches `partNumber` and `name` |
| `categoryId` | uuid | -- | Filter by category |
| `type` | PartType | -- | Filter by part type |
| `isSellable` | boolean | -- | Filter sellable parts |
| `isActive` | boolean | -- | Filter active parts |

---

#### GET /api/catalog/parts/:id

Get part detail with relations.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Response** `200`: Part object with `category`, `supplierParts`, and `bomChildren` included.

---

#### POST /api/catalog/parts

Create a new part. Validates `partNumber` uniqueness within tenant.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Request body**:
```json
{
  "partNumber": "string (required)",
  "name": "string (required)",
  "description": "string (optional)",
  "categoryId": "uuid (optional)",
  "type": "PartType (required)",
  "unitOfMeasure": "UnitOfMeasure (required)",
  "isSellable": "boolean (default false)",
  "isActive": "boolean (default true)"
}
```

---

#### PATCH /api/catalog/parts/:id

Update an existing part.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### DELETE /api/catalog/parts/:id

Soft-delete a part (sets `isActive = false`).

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

### Suppliers

#### GET /api/catalog/suppliers

List suppliers with pagination and search.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A |

**Query parameters**: `search`, `page`, `pageSize`.

---

#### GET /api/catalog/suppliers/:id

Get supplier detail with linked parts (`supplierParts`).

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### POST /api/catalog/suppliers

Create a new supplier.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### PATCH /api/catalog/suppliers/:id

Update an existing supplier.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### POST /api/catalog/suppliers/:id/parts

Link a part to a supplier with supply details.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Request body**:
```json
{
  "partId": "uuid (required)",
  "supplierPartNumber": "string (optional)",
  "unitCost": "number (optional)",
  "minimumOrderQty": "number (optional)",
  "leadTimeDays": "number (optional)",
  "isPrimary": "boolean (default false)"
}
```

---

### Bill of Materials (BOM)

#### GET /api/catalog/bom/:parentPartId

Get BOM items for a parent part.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Response** `200`: Parent part info plus array of BOM items with `childPart` relation included.

---

#### POST /api/catalog/bom/:parentPartId

Add a BOM item. Validates that `childPartId` is not the same as `parentPartId` (prevents self-reference).

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Request body**:
```json
{
  "childPartId": "uuid (required)",
  "quantityPer": "number (required)",
  "sortOrder": "number (optional)",
  "notes": "string (optional)"
}
```

---

#### DELETE /api/catalog/bom/:parentPartId/:bomItemId

Remove a BOM item.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

## 3. Kanban Service

**Gateway prefix**: `/api/kanban`

### Loops

#### GET /api/kanban/loops

List kanban loops with pagination and filters.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A (uses `pageSize` param) |

**Query parameters**: `page`, `pageSize` (max 100), `facilityId`, `loopType`.

---

#### GET /api/kanban/loops/:id

Get loop detail with related `cards`, `parameterHistory`, and `recommendations`.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### POST /api/kanban/loops

Create a new kanban loop with cards in a single transaction. Creates initial parameter history entry.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Request body**:
```json
{
  "partId": "uuid (required)",
  "facilityId": "uuid (required)",
  "storageLocationId": "uuid (optional)",
  "loopType": "'procurement' | 'production' | 'transfer' (required)",
  "cardMode": "'single' | 'multi' (default 'single')",
  "minQuantity": "int > 0 (required)",
  "orderQuantity": "int > 0 (required)",
  "numberOfCards": "int > 0 (default 1)",
  "safetyStockDays": "string (optional)",
  "primarySupplierId": "uuid (required for procurement loops)",
  "sourceFacilityId": "uuid (required for transfer loops)",
  "statedLeadTimeDays": "int (optional)",
  "notes": "string (optional)"
}
```

**Validation rules**:
- `procurement` loops require `primarySupplierId`
- `transfer` loops require `sourceFacilityId`
- `single` card mode requires `numberOfCards = 1`

**Response** `201`: `{ loop, cards }`.

---

#### PATCH /api/kanban/loops/:id/parameters

Update loop parameters (min/order quantities, number of cards). Records parameter change history and adjusts card count.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `loop.parameters_changed` |

**Request body**:
```json
{
  "minQuantity": "int (optional)",
  "orderQuantity": "int (optional)",
  "numberOfCards": "int (optional)",
  "reason": "string (required)"
}
```

If `numberOfCards` increases, new cards are created. If it decreases, excess cards are soft-deactivated (preserving history).

---

### Cards

#### GET /api/kanban/cards

List kanban cards with pagination and filters.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A |

**Query parameters**: `page`, `pageSize`, `loopId`, `stage`.

---

#### GET /api/kanban/cards/:id

Get card detail with `loop`, `transitions`, and QR code data.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### POST /api/kanban/cards/:id/transition

Transition a card to a new stage. Validates transition rules.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `card.transition` |

**Request body**:
```json
{
  "toStage": "CardStage (required)",
  "notes": "string (optional)",
  "metadata": "object (optional)"
}
```

---

#### GET /api/kanban/cards/:id/history

Get the full transition history for a card.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### GET /api/kanban/cards/:id/qr

Generate a QR code for the card. Tracks print count.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Query parameters**: `format` (`svg` | `dataUrl`).

---

#### POST /api/kanban/cards/:id/link-order

Link a card to an order (PO, WO, or TO).

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Request body**:
```json
{
  "purchaseOrderId": "uuid (optional)",
  "workOrderId": "uuid (optional)",
  "transferOrderId": "uuid (optional)"
}
```

Exactly one of the three order IDs must be provided.

---

### Scan (Public)

#### GET /scan/:cardId

Public endpoint for scanning a kanban card QR code. Returns card info for the PWA or redirects.

| Property | Value |
|---|---|
| **Auth** | None (public) |
| **Rate limit** | Standard |

---

#### POST /scan/:cardId/trigger

Trigger a scanned card (transitions to `triggered` stage).

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `card.transition` |

---

### Velocity

#### GET /api/kanban/velocity/:loopId

Get velocity metrics for a specific loop.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### GET /api/kanban/velocity

Get velocity summary across all loops.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Response** `200`:
```json
{
  "cardsByStage": { "created": 5, "triggered": 3, "ordered": 2, ... },
  "loopsByType": { "procurement": 10, "production": 4, "transfer": 2 },
  "totalCompletedCycles": 142,
  "recentActivity": [ ... ]
}
```

`recentActivity` covers the last 7 days.

---

## 4. Orders Service

**Gateway prefix**: `/api/orders`

### Purchase Orders

#### GET /api/orders/purchase-orders

List purchase orders with pagination and filters.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A |

**Query parameters**:

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | int | 1 | Page number |
| `limit` | int | 20 | Items per page (max 100) |
| `status` | POStatus | -- | Filter by status |
| `supplierId` | uuid | -- | Filter by supplier |
| `facilityId` | uuid | -- | Filter by facility |

---

#### GET /api/orders/purchase-orders/:id

Get purchase order detail with all line items.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Response** `200`:
```json
{
  "data": {
    "id": "uuid",
    "poNumber": "string",
    "status": "POStatus",
    "supplierId": "uuid",
    "facilityId": "uuid",
    "subtotal": "string",
    "totalAmount": "string",
    "lines": [
      {
        "id": "uuid",
        "lineNumber": 1,
        "partId": "uuid",
        "quantityOrdered": 100,
        "quantityReceived": 0,
        "unitCost": "string",
        "lineTotal": "string"
      }
    ]
  }
}
```

---

#### POST /api/orders/purchase-orders

Create a purchase order with line items. Auto-generates PO number.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.created` |
| **Audit** | `purchase_order.created` |

**Request body**:
```json
{
  "supplierId": "uuid (required)",
  "facilityId": "uuid (required)",
  "orderDate": "datetime (optional, defaults to now)",
  "expectedDeliveryDate": "datetime (required)",
  "currency": "string (3 chars, default 'USD')",
  "notes": "string (optional)",
  "internalNotes": "string (optional)",
  "lines": [
    {
      "partId": "uuid (required)",
      "kanbanCardId": "uuid (optional)",
      "lineNumber": "int (required)",
      "quantityOrdered": "int > 0 (required)",
      "unitCost": "number > 0 (required)",
      "notes": "string (optional)"
    }
  ]
}
```

---

#### POST /api/orders/purchase-orders/:id/lines

Add a line item to an existing PO. Only allowed when PO status is `draft` or `pending_approval`. Recalculates PO totals.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Audit** | `purchase_order.line_added` |

**Response** `201`: New line object.

---

#### PATCH /api/orders/purchase-orders/:id/status

Transition PO status. Validates against the state machine.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.status_changed` |
| **Audit** | `purchase_order.status_changed` |

**Request body**:
```json
{
  "status": "POStatus (required)",
  "cancelReason": "string (required when status = 'cancelled')"
}
```

**PO State Machine**:
```
draft --> pending_approval, cancelled
pending_approval --> approved, cancelled, draft
approved --> sent, cancelled
sent --> acknowledged, partially_received, cancelled
acknowledged --> partially_received, cancelled
partially_received --> received, cancelled
received --> closed, cancelled
closed --> (terminal)
cancelled --> (terminal)
```

---

#### PATCH /api/orders/purchase-orders/:id/receive

Receive line items. Updates `quantityReceived` per line and auto-transitions PO status to `partially_received` or `received` based on whether all lines are fully received.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.status_changed` (if status changes) |
| **Audit** | `purchase_order.lines_received` |

**Request body**:
```json
{
  "lines": [
    {
      "lineId": "uuid (required)",
      "quantityReceived": "int >= 0 (required)"
    }
  ]
}
```

Only allowed when PO status is `sent`, `acknowledged`, or `partially_received`.

---

### Work Orders

#### GET /api/orders/work-orders

List work orders with pagination and filters.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A (offset-based internally) |

**Query parameters**: `page`, `limit` (max 100), `status` (WOStatus), `partId`, `facilityId`, `kanbanCardId`.

---

#### GET /api/orders/work-orders/:id

Get work order detail with routing steps.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### POST /api/orders/work-orders

Create a work order with optional routing steps. Auto-generates WO number.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.created` |
| **Audit** | `work_order.created` |

---

#### PATCH /api/orders/work-orders/:id/status

Transition work order status. Validates transition rules. Completion requires `quantityProduced >= quantityToProduce`.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.status_changed` |
| **Audit** | `work_order.status_changed` |

**WO State Machine**:
```
draft --> scheduled, cancelled
scheduled --> in_progress, cancelled
in_progress --> on_hold, completed, cancelled
on_hold --> in_progress, cancelled
completed --> (terminal)
cancelled --> (terminal)
```

---

#### PATCH /api/orders/work-orders/:id/routings/:routingId

Update a routing step (status, actualMinutes, notes).

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Audit** | `work_order.routing_updated` |

---

#### PATCH /api/orders/work-orders/:id/production

Increment production quantities (quantityProduced, quantityRejected).

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Audit** | `work_order.production_updated` |

---

### Transfer Orders

#### GET /api/orders/transfer-orders

List transfer orders with pagination and filters.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A |

**Query parameters**: `page`, `limit` (max 100), `status` (TransferStatus), `sourceFacilityId`, `destinationFacilityId`.

---

#### GET /api/orders/transfer-orders/:id

Get transfer order detail with line items.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### POST /api/orders/transfer-orders

Create a transfer order with lines. Validates source facility is different from destination. Auto-generates TO number.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.created` |
| **Audit** | `transfer_order.created` |

---

#### PATCH /api/orders/transfer-orders/:id/status

Transition transfer order status.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.status_changed` |
| **Audit** | `transfer_order.status_changed` |

**TO State Machine**:
```
draft --> requested, cancelled
requested --> approved, cancelled
approved --> picking, cancelled
picking --> shipped, cancelled
shipped --> in_transit, cancelled
in_transit --> received, cancelled
received --> closed, cancelled
closed --> (terminal)
cancelled --> (terminal)
```

---

#### PATCH /api/orders/transfer-orders/:id/ship

Ship line items. Updates `quantityShipped` per line. Auto-transitions to `shipped` when all lines are fully shipped.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Audit** | `transfer_order.lines_shipped` |

---

#### PATCH /api/orders/transfer-orders/:id/receive

Receive line items. Updates `quantityReceived` per line. Auto-transitions to `received` when all lines are fully received.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Audit** | `transfer_order.lines_received` |

---

### Work Centers

#### GET /api/orders/work-centers

List work centers with pagination.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A |

**Query parameters**: `page`, `limit`, `facilityId`.

---

#### GET /api/orders/work-centers/:id

Get work center detail.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### POST /api/orders/work-centers

Create a work center. Validates `code` uniqueness per tenant.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Audit** | `work_center.created` |

---

#### PATCH /api/orders/work-centers/:id

Update a work center.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Audit** | `work_center.updated` |

---

#### DELETE /api/orders/work-centers/:id

Soft-delete a work center (`isActive = false`).

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Audit** | `work_center.deleted` |

---

### Order Queue

#### GET /api/orders/queue

List all triggered kanban cards awaiting order creation, grouped by loop type.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Query parameters**: `loopType` (`procurement` | `production` | `transfer`, optional).

**Response** `200`:
```json
{
  "success": true,
  "data": {
    "procurement": [{ "id", "cardNumber", "loopType", "partId", "facilityId", ... }],
    "production": [...],
    "transfer": [...]
  },
  "total": 15
}
```

---

#### GET /api/orders/queue/summary

Get aggregate queue summary.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Response** `200`:
```json
{
  "success": true,
  "data": {
    "totalAwaitingOrders": 15,
    "oldestCardAgeHours": 72,
    "byLoopType": {
      "procurement": 8,
      "production": 4,
      "transfer": 3
    }
  }
}
```

---

#### POST /api/orders/queue/create-po

Create a purchase order from triggered procurement cards. Transitions cards from `triggered` to `ordered`. Writes audit logs and emits events.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.created`, `card.transition` (per card) |
| **Audit** | `order_queue.purchase_order_created`, `kanban_card.transitioned_to_ordered` |

**Request body**:
```json
{
  "cardIds": ["uuid", "uuid"] ,
  "supplierId": "uuid (optional, defaults to loop's primarySupplierId)",
  "facilityId": "uuid (optional, defaults to loop's facilityId)",
  "expectedDeliveryDate": "datetime (optional)",
  "notes": "string (optional)"
}
```

**Validation**:
- All cards must exist and belong to the tenant
- All cards must be in `triggered` stage
- All cards must be from `procurement` loops

---

#### POST /api/orders/queue/create-wo

Create a work order from a single triggered production card.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.created`, `card.transition` |
| **Audit** | `order_queue.work_order_created`, `kanban_card.transitioned_to_ordered` |

**Request body**:
```json
{
  "cardId": "uuid (required)",
  "routingSteps": [
    {
      "workCenterId": "uuid (required)",
      "stepNumber": "int > 0 (required)",
      "operationName": "string (required)",
      "estimatedMinutes": "int (optional)"
    }
  ],
  "scheduledStartDate": "datetime (optional)",
  "scheduledEndDate": "datetime (optional)",
  "notes": "string (optional)"
}
```

**Validation**:
- Card must exist, belong to tenant, and be in `triggered` stage
- Card must be from a `production` loop

---

#### POST /api/orders/queue/create-to

Create a transfer order from triggered transfer cards.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Events emitted** | `order.created`, `card.transition` (per card) |
| **Audit** | `order_queue.transfer_order_created`, `kanban_card.transitioned_to_ordered` |

**Request body**:
```json
{
  "cardIds": ["uuid", "uuid"],
  "notes": "string (optional)"
}
```

**Validation**:
- All cards must exist and belong to the tenant
- All cards must be in `triggered` stage
- All cards must be from `transfer` loops

---

### Audit

#### GET /api/orders/audit

List audit log entries with pagination and filters.

| Property | Value |
|---|---|
| **Auth** | JWT required |
| **Pagination** | Pattern A |

**Query parameters**:

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | int | 1 | Page number |
| `limit` | int | 50 | Items per page (max 200) |
| `action` | string | -- | Filter by action name |
| `entityType` | string | -- | Filter by entity type |
| `entityId` | uuid | -- | Filter by entity ID |
| `userId` | uuid | -- | Filter by acting user |
| `dateFrom` | datetime | -- | Start of date range |
| `dateTo` | datetime | -- | End of date range |

---

## 5. Notifications Service

**Gateway prefix**: `/api/notifications`

### Notifications

#### GET /api/notifications

List notifications for the current user.

| Property | Value |
|---|---|
| **Auth** | JWT required (scoped to current user) |
| **Pagination** | Pattern B (offset-based) |

**Query parameters**:

| Param | Type | Default | Description |
|---|---|---|---|
| `unreadOnly` | `'true'` / `'false'` | -- | Filter unread only |
| `type` | NotificationType | -- | Filter by type |
| `limit` | int | 50 | Max items (max 200) |
| `offset` | int | 0 | Offset for pagination |

---

#### GET /api/notifications/unread-count

Get the count of unread notifications for the current user.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Response** `200`:
```json
{ "count": 7 }
```

---

#### PATCH /api/notifications/:id/read

Mark a single notification as read.

| Property | Value |
|---|---|
| **Auth** | JWT required (ownership verified) |

---

#### POST /api/notifications/mark-all-read

Mark all unread notifications as read for the current user.

| Property | Value |
|---|---|
| **Auth** | JWT required |

---

#### DELETE /api/notifications/:id

Delete a notification (hard delete).

| Property | Value |
|---|---|
| **Auth** | JWT required (ownership verified) |

---

### Preferences

#### GET /api/notifications/preferences

Get notification preferences for the current user. Returns defaults merged with any user overrides.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Response** `200`:
```json
{
  "data": {
    "card_triggered": { "inApp": true, "email": false, "webhook": false },
    "po_created": { "inApp": true, "email": true, "webhook": false },
    "po_sent": { "inApp": true, "email": false, "webhook": false },
    "po_received": { "inApp": true, "email": true, "webhook": false },
    "stockout_warning": { "inApp": true, "email": true, "webhook": false },
    "relowisa_recommendation": { "inApp": true, "email": false, "webhook": false },
    "exception_alert": { "inApp": true, "email": true, "webhook": true },
    "wo_status_change": { "inApp": true, "email": false, "webhook": false },
    "transfer_status_change": { "inApp": true, "email": false, "webhook": false },
    "system_alert": { "inApp": true, "email": true, "webhook": false }
  }
}
```

---

#### PUT /api/notifications/preferences

Create or update notification preferences per notification type and channel.

| Property | Value |
|---|---|
| **Auth** | JWT required |

**Request body**:
```json
{
  "preferences": {
    "po_created": { "inApp": true, "email": false, "webhook": true },
    "stockout_warning": { "inApp": true, "email": true, "webhook": true }
  }
}
```

Each notification type key maps to an object with `inApp`, `email`, and `webhook` boolean values.

---

## 6. API Gateway

### GET /health

Health check endpoint.

| Property | Value |
|---|---|
| **Auth** | None (public) |

**Response** `200`:
```json
{ "status": "ok", "timestamp": "2024-01-15T09:30:00.000Z" }
```

---

## Error Responses

All errors follow a consistent format:

```json
{
  "error": "Human-readable error message",
  "code": "MACHINE_READABLE_CODE (optional)",
  "details": [ ... ]
}
```

### Standard HTTP Status Codes

| Code | Meaning | Typical Cause |
|---|---|---|
| `400` | Bad Request | Zod validation failure, missing fields |
| `401` | Unauthorized | Missing or invalid JWT |
| `403` | Forbidden | Role restriction or tenant mismatch |
| `404` | Not Found | Resource does not exist or wrong tenant |
| `409` | Conflict | Invalid state transition, duplicate key |
| `429` | Too Many Requests | Rate limit exceeded |
| `500` | Internal Server Error | Unhandled exception |

### Validation Error Detail

When Zod validation fails, the response includes field-level details:

```json
{
  "error": "Validation error",
  "details": [
    { "field": "email", "message": "Invalid email address" },
    { "field": "password", "message": "Password must be at least 8 characters" }
  ]
}
```

---

## Versioning Strategy

### Current State

The API is currently unversioned. All endpoints are at `v1` implicitly.

### Planned Approach `[PLANNED]`

- **URL prefix versioning**: `/api/v1/...`, `/api/v2/...`
- **Sunset headers**: `Sunset: <date>` and `Deprecation: <date>` headers on deprecated endpoints
- **Breaking change policy**: New major versions for:
  - Removing a field from a response
  - Changing a field's type
  - Removing an endpoint
  - Changing authentication requirements
- **Non-breaking changes** (no version bump):
  - Adding optional request fields
  - Adding response fields
  - Adding new endpoints
  - Adding new enum values

---

*End of REST API Surface Specification*
