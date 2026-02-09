# MVP-05: Scan UX, Deep-Link Contract, and Offline Interaction States

> **Epic**: MVP-05 — PWA Scan Module
> **Ticket**: #47 (T1)
> **Status**: Specification
> **Last updated**: 2026-02-09

---

## 1. Scan Entry Points

Operators can initiate a scan through three distinct entry points:

### 1.1 Camera Scan (Primary)

- The operator opens the PWA and taps "Scan Card" to activate the device camera.
- A live viewfinder is rendered using the browser `MediaDevices.getUserMedia()` API.
- The scanner decodes QR codes using a client-side library (e.g., `jsQR` or `@aspect-software/barcode-reader`).
- On successful decode, the app extracts the `cardId` from the QR payload and initiates the trigger flow.
- If the camera permission is denied, the UI falls back to manual lookup with an explanatory message.

### 1.2 Deep-Link Scan (Secondary)

- Physical kanban cards contain a QR code that encodes a URL.
- When scanned with the device's native camera app (outside the PWA), the URL opens the PWA at the scan route.
- The deep-link URL triggers the frontend route `/scan/:cardId`, which resolves and triggers the card.

### 1.3 Manual Lookup (Fallback)

- Available when camera access is unavailable or when the operator knows the card ID.
- The operator types or pastes the card UUID into a text input and submits.
- Validation confirms the input is a valid UUID before dispatching.

---

## 2. Deep-Link Payload Contract

### 2.1 URL Format

```
{APP_URL}/scan/{cardId}
```

- `APP_URL` is the configured frontend base URL (e.g., `https://app.arda.io`).
- `cardId` is the UUID v4 primary key of the kanban card (immutable; see `qr-payload.service.ts`).

### 2.2 QR Code Payload

The QR code encodes the full deep-link URL. Example:

```
https://app.arda.io/scan/a0b1c2d3-e4f5-6789-abcd-ef0123456789
```

### 2.3 Backend Resolution

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `GET /api/kanban/scan/:cardId` | GET | None (public) | Deep-link entry. Returns JSON for API clients or 302 redirect for browsers. |
| `POST /api/kanban/scan/:cardId/trigger` | POST | JWT required | Triggers the card transition (created -> triggered). Used by PWA after authentication. |

### 2.4 Trigger Request Body

```json
{
  "location": {
    "lat": 40.7128,
    "lng": -73.9060
  }
}
```

Location is optional. The backend determines the scanned-by user from the JWT.

### 2.5 Trigger Response

```json
{
  "success": true,
  "card": { "id": "...", "currentStage": "triggered", ... },
  "loopType": "procurement",
  "partId": "part-uuid",
  "message": "Card triggered. Part added to Order Queue."
}
```

### 2.6 Idempotency

- The backend uses an `idempotencyKey` stored in the transition metadata.
- The PWA generates a deterministic key: `scan-{cardId}-{sessionId}-{timestamp}`.
- If the same `idempotencyKey` is replayed, the backend returns the original transition result without creating a duplicate.

---

## 3. Failure States

### 3.1 Camera Denied

- **Trigger**: User denies camera permission or the browser does not support `getUserMedia`.
- **UI**: Warning banner with message "Camera access denied. Use manual lookup below."
- **Action**: The manual lookup input is displayed as the primary interface.

### 3.2 Malformed QR Code

- **Trigger**: The decoded QR string does not match the UUID pattern (`/^[0-9a-f]{8}-...-[0-9a-f]{12}$/i`).
- **UI**: Error card with message "Invalid QR code format. Please try again."
- **Action**: Scanner remains active for retry.

### 3.3 Card Not Found

- **Trigger**: The backend returns 404 (`CARD_NOT_FOUND`).
- **UI**: Error card with message "Card not found. This QR code may be invalid."
- **Action**: Retry button or manual lookup fallback.

### 3.4 Card Already Triggered

- **Trigger**: The backend returns 400 (`CARD_ALREADY_TRIGGERED`).
- **UI**: Warning card showing the card's current stage with message "This card is already in the [stage] stage."
- **Action**: Acknowledge button dismisses the warning. No retry needed.

### 3.5 Card Inactive

- **Trigger**: The backend returns 400 (`CARD_INACTIVE`).
- **UI**: Error card with message "This card has been deactivated."
- **Action**: No retry available. Operator should contact admin.

### 3.6 Tenant Mismatch

- **Trigger**: The backend returns 403 (`TENANT_MISMATCH`).
- **UI**: Error card with message "This card does not belong to your organization."
- **Action**: No retry available.

### 3.7 Duplicate Scan (Idempotency)

- **Trigger**: The backend detects a duplicate `idempotencyKey`.
- **UI**: Success card showing the original result (treated as success, not an error).
- **Action**: None needed; the transition was already recorded.

### 3.8 Offline / Network Error

- **Trigger**: `navigator.onLine === false` or fetch fails with network error.
- **UI**: Info card with message "You are offline. Scan queued and will sync when reconnected."
- **Badge**: Sync status badge shows pending count (e.g., "2 pending").
- **Action**: The scan event is persisted to IndexedDB and replayed when connectivity returns.

---

## 4. Operator Feedback for Queued/Offline Scans

### 4.1 Queued Scan Lifecycle

```
SCAN --> [Online?]
          |-- Yes --> POST /trigger --> Success/Error UI
          |-- No  --> IndexedDB Queue --> Pending Badge
                        |
                        +--> [Online restored] --> Replay Worker
                                                     |-- Success --> Mark synced
                                                     |-- 409/400 --> Conflict UI
                                                     |-- 5xx/timeout --> Retry with backoff
```

### 4.2 Visual Indicators

| State | Badge Variant | Icon | Message |
|---|---|---|---|
| Pending (offline) | `warning` | Clock | "Queued — will sync when online" |
| Syncing | `accent` | Spinner | "Syncing..." |
| Synced | `success` | Check | "Synced successfully" |
| Failed (retryable) | `destructive` | Alert | "Sync failed — tap to retry" |
| Conflict | `warning` | Warning | "Conflict — action required" |

### 4.3 Sync Status Bar

- A persistent compact bar at the top of the scan view shows the aggregate queue state.
- Format: `{pending} pending | {synced} synced | {failed} failed`
- Tapping the bar opens the full sync detail view with per-scan status.

### 4.4 Conflict Resolution

When a queued scan replays and encounters a conflict (e.g., `CARD_ALREADY_TRIGGERED`, `INVALID_TRANSITION`), the operator sees a conflict resolver with options:

- **Retry**: Re-send the scan with a fresh idempotency key (for transient errors).
- **Discard**: Remove the queued scan (acknowledges it is no longer needed).
- **Escalate**: Flag the scan for supervisor review (logs the conflict for audit).

---

## 5. Data Flow Summary

```
  [QR Code on Card]
        |
        v
  [Device Camera / Native Scan / Manual Entry]
        |
        v
  [PWA Frontend: /scan/:cardId]
        |
        +--[Online]--> POST /api/kanban/scan/:cardId/trigger
        |                  |
        |                  +--> 200: Success UI
        |                  +--> 400/403/404: Error UI
        |
        +--[Offline]--> IndexedDB offline-queue
                            |
                            +--> [online event] --> Replay Worker
                                                       |
                                                       +--> Success: mark synced
                                                       +--> Conflict: conflict-resolver UI
                                                       +--> Transient error: exponential backoff
```

---

## 6. Security Considerations

- The `GET /scan/:cardId` endpoint is public (no auth) to support native camera scanning.
- The `POST /scan/:cardId/trigger` endpoint requires JWT authentication.
- QR codes do not contain any sensitive data -- only the card UUID.
- The PWA must verify the user is authenticated before dispatching the trigger call.
- Offline-queued scans are stored only in the device's IndexedDB (client-side, no server persistence until sync).
