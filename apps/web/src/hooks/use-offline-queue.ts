import { useState, useEffect, useCallback, useRef } from 'react';
import {
  enqueueScan,
  getQueuedEvents,
  getQueueStatus,
  removeQueueItem,
  clearSyncedItems,
  replayQueue,
  subscribeToConnectivity,
  type QueuedScanEvent,
  type QueueStatusCounts,
  type ReplayFn,
} from '@/lib/offline-queue';

// ─── Types ───────────────────────────────────────────────────────────

export interface UseOfflineQueueOptions {
  /** Function to send a queued scan to the backend */
  sendFn: ReplayFn;
  /** Auto-replay when coming back online (default: true) */
  autoReplay?: boolean;
  /** Poll interval for queue status updates in ms (default: 5000) */
  pollInterval?: number;
}

export interface UseOfflineQueueReturn {
  /** Current queue status counts */
  status: QueueStatusCounts;
  /** All queued events */
  events: QueuedScanEvent[];
  /** Whether the device is currently online */
  isOnline: boolean;
  /** Whether a replay is currently in progress */
  isReplaying: boolean;
  /** Enqueue a new scan event */
  enqueue: (cardId: string, location?: { lat: number; lng: number }) => Promise<QueuedScanEvent>;
  /** Manually trigger a replay of pending items */
  replay: () => Promise<void>;
  /** Remove a specific queue item (discard) */
  discard: (id: string) => Promise<void>;
  /** Clear all synced items */
  clearSynced: () => Promise<void>;
  /** Refresh queue state from IndexedDB */
  refresh: () => Promise<void>;
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useOfflineQueue({
  sendFn,
  autoReplay = true,
  pollInterval = 5000,
}: UseOfflineQueueOptions): UseOfflineQueueReturn {
  const [status, setStatus] = useState<QueueStatusCounts>({
    pending: 0,
    syncing: 0,
    synced: 0,
    failed: 0,
    total: 0,
  });
  const [events, setEvents] = useState<QueuedScanEvent[]>([]);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [isReplaying, setIsReplaying] = useState(false);

  const sendFnRef = useRef(sendFn);
  sendFnRef.current = sendFn;

  // Refresh queue state from IndexedDB
  const refresh = useCallback(async () => {
    try {
      const [newStatus, newEvents] = await Promise.all([
        getQueueStatus(),
        getQueuedEvents(),
      ]);
      setStatus(newStatus);
      setEvents(newEvents);
    } catch (err) {
      console.error('[offline-queue] Failed to refresh queue state:', err);
    }
  }, []);

  // Replay pending items
  const replay = useCallback(async () => {
    if (isReplaying) return;
    setIsReplaying(true);

    try {
      await replayQueue(sendFnRef.current);
      await refresh();
    } catch (err) {
      console.error('[offline-queue] Replay failed:', err);
    } finally {
      setIsReplaying(false);
    }
  }, [isReplaying, refresh]);

  // Enqueue a new scan
  const enqueue = useCallback(
    async (cardId: string, location?: { lat: number; lng: number }) => {
      const event = await enqueueScan(cardId, location);
      await refresh();
      return event;
    },
    [refresh],
  );

  // Discard a queue item
  const discard = useCallback(
    async (id: string) => {
      await removeQueueItem(id);
      await refresh();
    },
    [refresh],
  );

  // Clear synced items
  const clearSynced = useCallback(async () => {
    await clearSyncedItems();
    await refresh();
  }, [refresh]);

  // Subscribe to online/offline events
  useEffect(() => {
    const unsubscribe = subscribeToConnectivity((online) => {
      setIsOnline(online);
      if (online && autoReplay) {
        // Small delay to let network settle
        setTimeout(() => {
          replay();
        }, 1000);
      }
    });

    return unsubscribe;
  }, [autoReplay, replay]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Periodic status polling
  useEffect(() => {
    if (pollInterval <= 0) return;

    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval, refresh]);

  return {
    status,
    events,
    isOnline,
    isReplaying,
    enqueue,
    replay,
    discard,
    clearSynced,
    refresh,
  };
}
