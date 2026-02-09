# Audit Summary API Contract

## Endpoint

- Method: `GET`
- Path: `/audit/summary`

## Query Parameters

- `action` (optional): Filter by exact audit action name.
- `entityType` (optional): Filter by entity type.
- `entityId` (optional): Filter by entity UUID.
- `userId` (optional): Filter by actor UUID.
- `dateFrom` (optional): ISO datetime lower bound (inclusive).
- `dateTo` (optional): ISO datetime upper bound (inclusive).
- `granularity` (optional): `day` or `week` (default: `day`).

## Response Shape

The endpoint returns:

```json
{
  "data": {
    "total": 0,
    "byAction": [{ "action": "purchase_order.created", "count": 12 }],
    "byEntityType": [{ "entityType": "purchase_order", "count": 12 }],
    "byTimeBucket": [{ "bucket": "2026-02-09", "count": 3 }],
    "topActions": [{ "action": "purchase_order.created", "count": 12 }],
    "statusTransitionFunnel": [{ "status": "sent", "count": 8 }],
    "recentAnomalies": [
      {
        "action": "purchase_order.created",
        "currentCount": 7,
        "previousCount": 1,
        "delta": 6,
        "percentChange": 600,
        "severity": "high"
      }
    ]
  },
  "filters": {
    "dateFrom": "2026-02-01T00:00:00.000Z",
    "dateTo": "2026-02-09T23:59:59.999Z",
    "granularity": "day"
  }
}
```

## Shared Frontend Types

Use `@arda/shared-types`:

- `AuditSummaryQuery`
- `AuditSummaryResponse`
- `AuditSummaryData`
- `AuditSummaryRecentAnomaly`
