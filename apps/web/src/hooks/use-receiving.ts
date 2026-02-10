import * as React from "react";
import type {
  PurchaseOrder,
  Receipt,
  ReceivingException,
  ReceivingMetrics,
  ExceptionResolution,
} from "@/types";
import {
  isUnauthorized,
  parseApiError,
  fetchPurchaseOrders,
  fetchPurchaseOrder,
  createReceipt,
  fetchReceivingMetrics,
  fetchReceivingExceptions,
  resolveReceivingException,
  fetchReceiptsForOrder,
} from "@/lib/api-client";

/* ── Tab type ──────────────────────────────────────────────── */

export type ReceivingTab = "expected" | "receive" | "exceptions" | "history" | "metrics";

/* ── Line quantity form state ─────────────────────────────── */

export interface ReceiveLineState {
  partId: string;
  partName: string;
  quantityOrdered: number;
  quantityPreviouslyReceived: number;
  quantityRemaining: number;
  quantityAccepted: number;
  quantityDamaged: number;
  quantityRejected: number;
}

/* ── Hook return type ─────────────────────────────────────── */

export interface UseReceivingReturn {
  /* Tab navigation */
  activeTab: ReceivingTab;
  setActiveTab: (tab: ReceivingTab) => void;

  /* Expected deliveries */
  expectedPOs: PurchaseOrder[];
  expectedLoading: boolean;
  expectedError: string | null;
  refreshExpected: () => Promise<void>;

  /* Receive form */
  selectedPO: PurchaseOrder | null;
  selectPOForReceiving: (poId: string) => Promise<void>;
  clearSelectedPO: () => void;
  receiveLines: ReceiveLineState[];
  updateReceiveLine: (partId: string, field: "quantityAccepted" | "quantityDamaged" | "quantityRejected", value: number) => void;
  receiveNotes: string;
  setReceiveNotes: (notes: string) => void;
  submitReceipt: () => Promise<string | null>;
  receiveLoading: boolean;
  receiveSubmitting: boolean;
  receiveError: string | null;

  /* Exceptions */
  exceptions: ReceivingException[];
  exceptionsLoading: boolean;
  exceptionsError: string | null;
  refreshExceptions: () => Promise<void>;
  resolveException: (exceptionId: string, resolution: ExceptionResolution, notes?: string) => Promise<boolean>;
  resolvingId: string | null;

  /* History */
  receipts: Receipt[];
  historyLoading: boolean;
  historyError: string | null;
  refreshHistory: () => Promise<void>;
  selectedReceipt: Receipt | null;
  selectReceipt: (receipt: Receipt | null) => void;

  /* Metrics */
  metrics: ReceivingMetrics | null;
  metricsLoading: boolean;
  metricsError: string | null;
  refreshMetrics: () => Promise<void>;
}

/* ── Hook ────────────────────────────────────────────────── */

export function useReceiving(
  token: string | null,
  onUnauthorized: () => void,
): UseReceivingReturn {
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /* ── Tab ────────────────────────────────────────────────── */
  const [activeTab, setActiveTab] = React.useState<ReceivingTab>("expected");

  /* ── Expected deliveries ────────────────────────────────── */
  const [expectedPOs, setExpectedPOs] = React.useState<PurchaseOrder[]>([]);
  const [expectedLoading, setExpectedLoading] = React.useState(false);
  const [expectedError, setExpectedError] = React.useState<string | null>(null);

  const refreshExpected = React.useCallback(async () => {
    if (!token) return;
    setExpectedLoading(true);
    setExpectedError(null);
    try {
      const statuses = ["sent", "acknowledged", "partially_received"] as const;
      const results: PurchaseOrder[] = [];
      for (const status of statuses) {
        const response = await fetchPurchaseOrders(token, { status, pageSize: 50 });
        results.push(...response.data);
      }
      if (isMountedRef.current) {
        setExpectedPOs(results);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      if (isMountedRef.current) {
        setExpectedError(parseApiError(err));
      }
    } finally {
      if (isMountedRef.current) {
        setExpectedLoading(false);
      }
    }
  }, [token, onUnauthorized]);

  /* ── Receive form ───────────────────────────────────────── */
  const [selectedPO, setSelectedPO] = React.useState<PurchaseOrder | null>(null);
  const [receiveLines, setReceiveLines] = React.useState<ReceiveLineState[]>([]);
  const [receiveNotes, setReceiveNotes] = React.useState("");
  const [receiveLoading, setReceiveLoading] = React.useState(false);
  const [receiveSubmitting, setReceiveSubmitting] = React.useState(false);
  const [receiveError, setReceiveError] = React.useState<string | null>(null);

  const selectPOForReceiving = React.useCallback(
    async (poId: string) => {
      if (!token) return;
      setReceiveLoading(true);
      setReceiveError(null);
      try {
        const po = await fetchPurchaseOrder(token, poId);
        if (!isMountedRef.current) return;
        setSelectedPO(po);
        setReceiveLines(
          (po.lines ?? []).map((line) => ({
            partId: line.partId,
            partName: line.partName ?? line.partId,
            quantityOrdered: line.quantityOrdered,
            quantityPreviouslyReceived: line.quantityReceived,
            quantityRemaining: Math.max(0, line.quantityOrdered - line.quantityReceived),
            quantityAccepted: 0,
            quantityDamaged: 0,
            quantityRejected: 0,
          })),
        );
        setReceiveNotes("");
        setActiveTab("receive");
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        if (isMountedRef.current) {
          setReceiveError(parseApiError(err));
        }
      } finally {
        if (isMountedRef.current) {
          setReceiveLoading(false);
        }
      }
    },
    [token, onUnauthorized],
  );

  const clearSelectedPO = React.useCallback(() => {
    setSelectedPO(null);
    setReceiveLines([]);
    setReceiveNotes("");
    setReceiveError(null);
  }, []);

  const updateReceiveLine = React.useCallback(
    (partId: string, field: "quantityAccepted" | "quantityDamaged" | "quantityRejected", value: number) => {
      setReceiveLines((prev) =>
        prev.map((line) =>
          line.partId === partId ? { ...line, [field]: Math.max(0, value) } : line,
        ),
      );
    },
    [],
  );

  const submitReceipt = React.useCallback(async (): Promise<string | null> => {
    if (!token || !selectedPO) return null;
    setReceiveSubmitting(true);
    setReceiveError(null);
    try {
      const receipt = await createReceipt(token, {
        orderId: selectedPO.id,
        orderType: "purchase",
        lines: receiveLines
          .filter((l) => l.quantityAccepted > 0 || l.quantityDamaged > 0 || l.quantityRejected > 0)
          .map((l) => ({
            partId: l.partId,
            quantityAccepted: l.quantityAccepted,
            quantityDamaged: l.quantityDamaged || undefined,
            quantityRejected: l.quantityRejected || undefined,
          })),
        notes: receiveNotes.trim() || undefined,
      });
      if (isMountedRef.current) {
        clearSelectedPO();
      }
      return receipt.id;
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return null;
      }
      if (isMountedRef.current) {
        setReceiveError(parseApiError(err));
      }
      return null;
    } finally {
      if (isMountedRef.current) {
        setReceiveSubmitting(false);
      }
    }
  }, [token, selectedPO, receiveLines, receiveNotes, clearSelectedPO, onUnauthorized]);

  /* ── Exceptions ─────────────────────────────────────────── */
  const [exceptions, setExceptions] = React.useState<ReceivingException[]>([]);
  const [exceptionsLoading, setExceptionsLoading] = React.useState(false);
  const [exceptionsError, setExceptionsError] = React.useState<string | null>(null);
  const [resolvingId, setResolvingId] = React.useState<string | null>(null);

  const refreshExceptions = React.useCallback(async () => {
    if (!token) return;
    setExceptionsLoading(true);
    setExceptionsError(null);
    try {
      const response = await fetchReceivingExceptions(token, { pageSize: 50 });
      if (isMountedRef.current) {
        setExceptions(response.data);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      if (isMountedRef.current) {
        setExceptionsError(parseApiError(err));
      }
    } finally {
      if (isMountedRef.current) {
        setExceptionsLoading(false);
      }
    }
  }, [token, onUnauthorized]);

  const resolveExceptionAction = React.useCallback(
    async (exceptionId: string, resolution: ExceptionResolution, notes?: string): Promise<boolean> => {
      if (!token) return false;
      setResolvingId(exceptionId);
      try {
        const updated = await resolveReceivingException(token, exceptionId, {
          resolution,
          notes: notes?.trim() || undefined,
        });
        if (isMountedRef.current) {
          setExceptions((prev) =>
            prev.map((ex) => (ex.id === exceptionId ? updated : ex)),
          );
        }
        return true;
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
        }
        return false;
      } finally {
        if (isMountedRef.current) {
          setResolvingId(null);
        }
      }
    },
    [token, onUnauthorized],
  );

  /* ── History ────────────────────────────────────────────── */
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [selectedReceipt, setSelectedReceipt] = React.useState<Receipt | null>(null);

  const refreshHistory = React.useCallback(async () => {
    if (!token) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      // Fetch receipts for all expected POs + any already loaded POs
      const poIds = new Set<string>();
      expectedPOs.forEach((po) => poIds.add(po.id));

      const allReceipts: Receipt[] = [];
      for (const poId of poIds) {
        try {
          const orderReceipts = await fetchReceiptsForOrder(token, poId);
          allReceipts.push(...orderReceipts);
        } catch {
          // Skip individual PO failures
        }
      }

      // Also try fetching a general list if no PO-specific receipts found
      if (allReceipts.length === 0) {
        // Fall back to fetching from a known endpoint if available
        // For now, we'll show an empty state that prompts the user
      }

      if (isMountedRef.current) {
        // Deduplicate and sort by receivedAt descending
        const uniqueMap = new Map<string, Receipt>();
        for (const r of allReceipts) {
          uniqueMap.set(r.id, r);
        }
        const sorted = Array.from(uniqueMap.values()).sort(
          (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
        );
        setReceipts(sorted);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      if (isMountedRef.current) {
        setHistoryError(parseApiError(err));
      }
    } finally {
      if (isMountedRef.current) {
        setHistoryLoading(false);
      }
    }
  }, [token, expectedPOs, onUnauthorized]);

  /* ── Metrics ────────────────────────────────────────────── */
  const [metrics, setMetrics] = React.useState<ReceivingMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = React.useState(false);
  const [metricsError, setMetricsError] = React.useState<string | null>(null);

  const refreshMetrics = React.useCallback(async () => {
    if (!token) return;
    setMetricsLoading(true);
    setMetricsError(null);
    try {
      const data = await fetchReceivingMetrics(token);
      if (isMountedRef.current) {
        setMetrics(data);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      if (isMountedRef.current) {
        setMetricsError(parseApiError(err));
      }
    } finally {
      if (isMountedRef.current) {
        setMetricsLoading(false);
      }
    }
  }, [token, onUnauthorized]);

  /* ── Auto-fetch on tab change ──────────────────────────── */
  React.useEffect(() => {
    if (!token) return;
    switch (activeTab) {
      case "expected":
        void refreshExpected();
        break;
      case "exceptions":
        void refreshExceptions();
        break;
      case "history":
        void refreshHistory();
        break;
      case "metrics":
        void refreshMetrics();
        break;
    }
  }, [activeTab, token]);

  return {
    activeTab,
    setActiveTab,

    expectedPOs,
    expectedLoading,
    expectedError,
    refreshExpected,

    selectedPO,
    selectPOForReceiving,
    clearSelectedPO,
    receiveLines,
    updateReceiveLine,
    receiveNotes,
    setReceiveNotes,
    submitReceipt,
    receiveLoading,
    receiveSubmitting,
    receiveError,

    exceptions,
    exceptionsLoading,
    exceptionsError,
    refreshExceptions,
    resolveException: resolveExceptionAction,
    resolvingId,

    receipts,
    historyLoading,
    historyError,
    refreshHistory,
    selectedReceipt,
    selectReceipt: setSelectedReceipt,

    metrics,
    metricsLoading,
    metricsError,
    refreshMetrics,
  };
}
