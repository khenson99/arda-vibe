import { useState, useEffect, useCallback, useRef } from "react";
import {
  isUnauthorized,
  parseApiError,
  fetchPurchaseOrder,
  updatePurchaseOrderStatus,
  fetchReceiptsForOrder,
} from "@/lib/api-client";
import type { PurchaseOrder, POStatus, Receipt } from "@/types";

interface UsePurchaseOrderDetailOptions {
  token: string;
  poId: string;
  onUnauthorized: () => void;
}

export function usePurchaseOrderDetail({
  token,
  poId,
  onUnauthorized,
}: UsePurchaseOrderDetailOptions) {
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);

  const [statusUpdating, setStatusUpdating] = useState(false);

  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadPo = useCallback(async () => {
    const id = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const raw = await fetchPurchaseOrder(token, poId);
      if (id !== fetchIdRef.current || !isMountedRef.current) return;
      // fetchPurchaseOrder returns the raw API response; the PO data may be
      // nested under a `data` key depending on the API shape.
      const data = (raw && typeof raw === "object" && "data" in raw)
        ? (raw as unknown as { data: PurchaseOrder }).data
        : raw;
      setPo(data);
    } catch (err) {
      if (id !== fetchIdRef.current || !isMountedRef.current) return;
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    } finally {
      if (id === fetchIdRef.current && isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [token, poId, onUnauthorized]);

  const loadReceipts = useCallback(async () => {
    setReceiptsLoading(true);
    try {
      const data = await fetchReceiptsForOrder(token, poId);
      if (isMountedRef.current) setReceipts(data);
    } catch {
      if (isMountedRef.current) setReceipts([]);
    } finally {
      if (isMountedRef.current) setReceiptsLoading(false);
    }
  }, [token, poId]);

  useEffect(() => {
    loadPo();
    loadReceipts();
  }, [loadPo, loadReceipts]);

  const updateStatus = useCallback(
    async (status: POStatus, notes?: string, cancelReason?: string): Promise<boolean> => {
      if (!po) return false;
      setStatusUpdating(true);
      try {
        const raw = await updatePurchaseOrderStatus(token, po.id, {
          status,
          notes,
          cancelReason,
        } as Parameters<typeof updatePurchaseOrderStatus>[2]);
        if (!isMountedRef.current) return false;
        // Unwrap data if nested
        const updated = (raw && typeof raw === "object" && "data" in raw)
          ? (raw as unknown as { data: PurchaseOrder }).data
          : raw;
        setPo(updated);
        return true;
      } catch (err) {
        if (!isMountedRef.current) return false;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return false;
        }
        throw err;
      } finally {
        if (isMountedRef.current) setStatusUpdating(false);
      }
    },
    [token, po, onUnauthorized],
  );

  const refresh = useCallback(() => {
    loadPo();
    loadReceipts();
  }, [loadPo, loadReceipts]);

  return {
    po,
    loading,
    error,
    receipts,
    receiptsLoading,
    statusUpdating,
    updateStatus,
    refresh,
  };
}
