import { useState, useCallback, useEffect, useRef } from 'react';
import { triggerScan, createReplayAdapter } from '@/lib/scan-api';
import { useOfflineQueue } from '@/hooks/use-offline-queue';
import { errorCodeToConflictType } from '@/components/scan/conflict-resolver';
import type { ScanResultData } from '@/components/scan/scan-result';
import type { ScanConflict, ConflictAction } from '@/components/scan/conflict-resolver';
import { updateQueueItem, removeQueueItem } from '@/lib/offline-queue';

// ─── Types ───────────────────────────────────────────────────────────

export type ScanSessionState = 'idle' | 'scanning' | 'processing' | 'result' | 'conflict';

export interface UseScanSessionReturn {
  /** Current session state */
  state: ScanSessionState;
  /** Current scan result (when state === 'result') */
  result: ScanResultData | null;
  /** Current conflicts needing resolution */
  conflicts: ScanConflict[];
  /** Whether a scan is currently being processed */
  isProcessing: boolean;
  /** Offline queue state */
  queue: ReturnType<typeof useOfflineQueue>;
  /** Process a scanned card ID (from camera or manual lookup) */
  processScan: (cardId: string) => Promise<void>;
  /** Reset session to idle state */
  reset: () => void;
  /** Dismiss the current result */
  dismissResult: () => void;
  /** Resolve a conflict */
  resolveConflict: (queueItemId: string, action: ConflictAction) => Promise<void>;
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useScanSession(): UseScanSessionReturn {
  const [state, setState] = useState<ScanSessionState>('idle');
  const [result, setResult] = useState<ScanResultData | null>(null);
  const [conflicts, setConflicts] = useState<ScanConflict[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const replayAdapter = useRef(createReplayAdapter());

  const queue = useOfflineQueue({
    sendFn: replayAdapter.current,
    autoReplay: true,
    pollInterval: 5000,
  });

  // Build conflicts from failed queue items
  const refreshConflicts = useCallback(() => {
    const failedEvents = queue.events.filter(
      (e) => e.status === 'failed' && e.lastErrorCode,
    );

    const newConflicts: ScanConflict[] = failedEvents.map((event) => ({
      queueItemId: event.id,
      cardId: event.cardId,
      conflictType: errorCodeToConflictType(event.lastErrorCode),
      message: event.lastError ?? 'Unknown error',
      errorCode: event.lastErrorCode,
      scannedAt: event.scannedAt,
      retryCount: event.retryCount,
    }));

    setConflicts(newConflicts);

    if (newConflicts.length > 0) {
      setState((prev) => (prev === 'result' ? prev : 'conflict'));
    }
  }, [queue.events]);

  useEffect(() => {
    refreshConflicts();
  }, [refreshConflicts]);

  // Process a scan (online or offline)
  const processScan = useCallback(
    async (cardId: string) => {
      setIsProcessing(true);
      setState('processing');

      // If offline, queue immediately
      if (!queue.isOnline) {
        try {
          await queue.enqueue(cardId);
          setResult({
            type: 'queued',
            title: 'Scan Queued',
            message: 'You are offline. Scan queued and will sync when reconnected.',
            cardId,
          });
          setState('result');
        } catch (err) {
          setResult({
            type: 'error',
            title: 'Queue Failed',
            message: err instanceof Error ? err.message : 'Failed to queue scan',
            cardId,
          });
          setState('result');
        } finally {
          setIsProcessing(false);
        }
        return;
      }

      // Online: attempt direct trigger
      try {
        const response = await triggerScan(cardId);

        if (response.ok) {
          setResult({
            type: 'success',
            title: 'Card Triggered',
            message: response.data.message,
            cardId: response.data.card.id,
            cardStage: response.data.card.currentStage,
            loopType: response.data.loopType,
            partId: response.data.partId,
          });
          setState('result');
        } else {
          // Check if this is a network error (should queue) or a business error (show immediately)
          if (response.error.code === 'NETWORK_ERROR' || response.error.code === 'TIMEOUT') {
            // Network error: queue for retry
            await queue.enqueue(cardId);
            setResult({
              type: 'queued',
              title: 'Scan Queued',
              message: 'Network error. Scan queued and will retry automatically.',
              cardId,
              errorCode: response.error.code,
            });
          } else if (response.error.code === 'CARD_ALREADY_TRIGGERED') {
            // Duplicate scan: show as warning, not error
            setResult({
              type: 'warning',
              title: 'Already Triggered',
              message: response.error.error,
              cardId,
              errorCode: response.error.code,
            });
          } else {
            // Business error: show immediately
            setResult({
              type: 'error',
              title: 'Scan Failed',
              message: response.error.error,
              cardId,
              errorCode: response.error.code,
            });
          }
          setState('result');
        }
      } catch (err) {
        // Unexpected error: queue for retry
        try {
          await queue.enqueue(cardId);
          setResult({
            type: 'queued',
            title: 'Scan Queued',
            message: 'An unexpected error occurred. Scan queued for retry.',
            cardId,
          });
        } catch {
          setResult({
            type: 'error',
            title: 'Scan Failed',
            message: err instanceof Error ? err.message : 'Unexpected error',
            cardId,
          });
        }
        setState('result');
      } finally {
        setIsProcessing(false);
      }
    },
    [queue],
  );

  // Reset to idle
  const reset = useCallback(() => {
    setState('idle');
    setResult(null);
    setIsProcessing(false);
  }, []);

  // Dismiss current result and check for conflicts
  const dismissResult = useCallback(() => {
    setResult(null);
    const hasQueuedConflicts = queue.events.some(
      (event) => event.status === 'failed' && Boolean(event.lastErrorCode),
    );
    if (hasQueuedConflicts) {
      refreshConflicts();
      setState('conflict');
    } else {
      setConflicts([]);
      setState('idle');
    }
  }, [queue.events, refreshConflicts]);

  // Resolve a conflict
  const resolveConflict = useCallback(
    async (queueItemId: string, action: ConflictAction) => {
      setIsProcessing(true);

      try {
        switch (action) {
          case 'retry': {
            // Reset to pending for next replay cycle
            await updateQueueItem(queueItemId, {
              status: 'pending',
              retryCount: 0,
              lastError: undefined,
              lastErrorCode: undefined,
            });
            break;
          }

          case 'discard': {
            await removeQueueItem(queueItemId);
            break;
          }

          case 'escalate': {
            // Mark as failed with escalation flag in metadata
            await updateQueueItem(queueItemId, {
              status: 'failed',
              lastError: 'Escalated for supervisor review',
              lastErrorCode: 'ESCALATED',
            });
            break;
          }
        }

        // Refresh queue and conflicts
        await queue.refresh();

        // Remove resolved conflict from local state
        setConflicts((prev) => {
          const next = prev.filter((c) => c.queueItemId !== queueItemId);
          if (next.length === 0) {
            setState('idle');
          }
          return next;
        });
      } catch (err) {
        console.error('[scan-session] Failed to resolve conflict:', err);
      } finally {
        setIsProcessing(false);
      }
    },
    [queue],
  );

  return {
    state,
    result,
    conflicts,
    isProcessing,
    queue,
    processScan,
    reset,
    dismissResult,
    resolveConflict,
  };
}
