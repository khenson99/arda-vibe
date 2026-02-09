// ─── Offline Event Queue ────────────────────────────────────────────
// IndexedDB-based scan event persistence with replay and exponential backoff.
// Queued events survive page reloads and are replayed when connectivity returns.

// ─── Types ───────────────────────────────────────────────────────────

export type QueueItemStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export interface QueuedScanEvent {
  /** Unique ID for this queue entry (auto-generated) */
  id: string;
  /** The kanban card ID to trigger */
  cardId: string;
  /** Idempotency key for dedup on replay */
  idempotencyKey: string;
  /** Timestamp when the scan was captured */
  scannedAt: string;
  /** Optional geolocation at scan time */
  location?: { lat: number; lng: number };
  /** Current sync status */
  status: QueueItemStatus;
  /** Number of replay attempts */
  retryCount: number;
  /** Timestamp of last replay attempt */
  lastAttemptAt?: string;
  /** Error message from last failed attempt */
  lastError?: string;
  /** Error code from backend (e.g., CARD_ALREADY_TRIGGERED) */
  lastErrorCode?: string;
  /** Backend response on successful sync */
  syncResult?: Record<string, unknown>;
}

export interface QueueStatusCounts {
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
  total: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const DB_NAME = 'arda-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'scan-events';

/** Maximum retry attempts before marking as permanently failed */
const MAX_RETRIES = 5;

/** Base delay for exponential backoff (ms) */
const BASE_DELAY_MS = 1000;

/** Maximum backoff delay (ms) */
const MAX_DELAY_MS = 30000;

// ─── IndexedDB Helpers ──────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('cardId', 'cardId', { unique: false });
        store.createIndex('scannedAt', 'scannedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txPromise<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txPromiseAll<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>[],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const requests = fn(store);
    const results: T[] = [];
    let completed = 0;

    if (requests.length === 0) {
      resolve([]);
      return;
    }

    requests.forEach((req, i) => {
      req.onsuccess = () => {
        results[i] = req.result;
        completed++;
        if (completed === requests.length) resolve(results);
      };
      req.onerror = () => reject(req.error);
    });

    tx.onerror = () => reject(tx.error);
  });
}

// ─── Queue Operations ───────────────────────────────────────────────

/** Generate a unique queue entry ID */
function generateQueueId(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate an idempotency key for a scan */
function generateIdempotencyKey(cardId: string): string {
  return `scan-${cardId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Enqueue a scan event for offline persistence */
export async function enqueueScan(
  cardId: string,
  location?: { lat: number; lng: number },
): Promise<QueuedScanEvent> {
  const event: QueuedScanEvent = {
    id: generateQueueId(),
    cardId,
    idempotencyKey: generateIdempotencyKey(cardId),
    scannedAt: new Date().toISOString(),
    location,
    status: 'pending',
    retryCount: 0,
  };

  const db = await openDb();
  await txPromise(db, STORE_NAME, 'readwrite', (store) => store.add(event));
  db.close();

  return event;
}

/** Get all queued events, optionally filtered by status */
export async function getQueuedEvents(
  statusFilter?: QueueItemStatus,
): Promise<QueuedScanEvent[]> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    let request: IDBRequest<QueuedScanEvent[]>;

    if (statusFilter) {
      const index = store.index('status');
      request = index.getAll(statusFilter);
    } else {
      request = store.getAll();
    }

    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/** Get queue status counts */
export async function getQueueStatus(): Promise<QueueStatusCounts> {
  const events = await getQueuedEvents();

  const counts: QueueStatusCounts = {
    pending: 0,
    syncing: 0,
    synced: 0,
    failed: 0,
    total: events.length,
  };

  for (const event of events) {
    counts[event.status]++;
  }

  return counts;
}

/** Update a queue entry's status */
export async function updateQueueItem(
  id: string,
  update: Partial<Pick<QueuedScanEvent, 'status' | 'retryCount' | 'lastAttemptAt' | 'lastError' | 'lastErrorCode' | 'syncResult'>>,
): Promise<QueuedScanEvent | null> {
  const db = await openDb();
  const existing = await txPromise<QueuedScanEvent | undefined>(
    db, STORE_NAME, 'readonly', (store) => store.get(id),
  );

  if (!existing) {
    db.close();
    return null;
  }

  const updated: QueuedScanEvent = { ...existing, ...update };
  await txPromise(db, STORE_NAME, 'readwrite', (store) => store.put(updated));
  db.close();

  return updated;
}

/** Remove a queue entry (discard or after successful sync cleanup) */
export async function removeQueueItem(id: string): Promise<void> {
  const db = await openDb();
  await txPromise(db, STORE_NAME, 'readwrite', (store) => store.delete(id));
  db.close();
}

/** Remove all synced items (cleanup) */
export async function clearSyncedItems(): Promise<number> {
  const synced = await getQueuedEvents('synced');
  if (synced.length === 0) return 0;

  const db = await openDb();
  await txPromiseAll(db, STORE_NAME, 'readwrite', (store) =>
    synced.map((item) => store.delete(item.id)),
  );
  db.close();

  return synced.length;
}

// ─── Replay Worker ──────────────────────────────────────────────────

export type ReplayFn = (event: QueuedScanEvent) => Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}>;

/** Calculate exponential backoff delay with jitter */
export function calculateBackoffDelay(retryCount: number): number {
  const delay = Math.min(
    BASE_DELAY_MS * Math.pow(2, retryCount),
    MAX_DELAY_MS,
  );
  // Add 0-25% jitter
  const jitter = delay * 0.25 * Math.random();
  return Math.round(delay + jitter);
}

/** Non-retryable error codes (conflict, not transient) */
const NON_RETRYABLE_CODES = new Set([
  'CARD_NOT_FOUND',
  'CARD_INACTIVE',
  'CARD_ALREADY_TRIGGERED',
  'TENANT_MISMATCH',
  'INVALID_TRANSITION',
  'ROLE_NOT_ALLOWED',
  'LOOP_TYPE_INCOMPATIBLE',
  'METHOD_NOT_ALLOWED',
]);

/** Determine if an error is retryable */
export function isRetryable(errorCode?: string): boolean {
  if (!errorCode) return true; // Unknown errors are retryable
  return !NON_RETRYABLE_CODES.has(errorCode);
}

/**
 * Replay all pending queue items using the provided send function.
 * Returns the number of items processed.
 */
export async function replayQueue(sendFn: ReplayFn): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  conflicts: number;
}> {
  const pending = await getQueuedEvents('pending');
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let conflicts = 0;

  for (const event of pending) {
    // Skip if max retries exceeded
    if (event.retryCount >= MAX_RETRIES) {
      await updateQueueItem(event.id, {
        status: 'failed',
        lastError: 'Maximum retry attempts exceeded',
      });
      failed++;
      processed++;
      continue;
    }

    // Wait for backoff delay if this is a retry
    if (event.retryCount > 0) {
      const delay = calculateBackoffDelay(event.retryCount);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Mark as syncing
    await updateQueueItem(event.id, {
      status: 'syncing',
      lastAttemptAt: new Date().toISOString(),
    });

    try {
      const result = await sendFn(event);

      if (result.success) {
        await updateQueueItem(event.id, {
          status: 'synced',
          syncResult: result.data,
          lastError: undefined,
          lastErrorCode: undefined,
        });
        succeeded++;
      } else if (!isRetryable(result.errorCode)) {
        // Non-retryable error = conflict
        await updateQueueItem(event.id, {
          status: 'failed',
          lastError: result.errorMessage ?? 'Non-retryable error',
          lastErrorCode: result.errorCode,
        });
        conflicts++;
      } else {
        // Retryable error - put back to pending for next replay cycle
        await updateQueueItem(event.id, {
          status: 'pending',
          retryCount: event.retryCount + 1,
          lastError: result.errorMessage ?? 'Sync failed',
          lastErrorCode: result.errorCode,
        });
      }
    } catch (err) {
      // Network/unexpected error - put back to pending
      await updateQueueItem(event.id, {
        status: 'pending',
        retryCount: event.retryCount + 1,
        lastError: err instanceof Error ? err.message : 'Network error',
      });
    }

    processed++;
  }

  return { processed, succeeded, failed, conflicts };
}

// ─── Online/Offline Listener ────────────────────────────────────────

export type OnlineChangeCallback = (isOnline: boolean) => void;

/**
 * Subscribe to online/offline events. Returns cleanup function.
 */
export function subscribeToConnectivity(callback: OnlineChangeCallback): () => void {
  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
