import { useState, useEffect, useCallback, useRef } from "react";
import {
  isUnauthorized,
  fetchPurchaseOrders,
  fetchPurchaseOrder,
  fetchWorkOrders,
  fetchTransferOrders,
  fetchReceiptsForOrder,
  updatePurchaseOrderStatus,
} from "@/lib/api-client";
import type {
  PurchaseOrder,
  WorkOrder,
  TransferOrder,
  UnifiedOrder,
  POStatus,
  Receipt,
} from "@/types";

/* ── Tab types ───────────────────────────────────────────────── */

export type OrderTab = "all" | "purchase" | "work" | "transfer";

export type DateRange = "7d" | "30d" | "90d" | "all";

/* ── Pagination ──────────────────────────────────────────────── */

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const DEFAULT_PAGINATION: Pagination = {
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
};

/* ── Converters ──────────────────────────────────────────────── */

function poToUnified(po: PurchaseOrder): UnifiedOrder {
  return {
    id: po.id,
    orderNumber: po.poNumber,
    type: "purchase",
    status: po.status,
    sourceName: po.supplierName ?? null,
    totalAmount: po.totalAmount,
    currency: po.currency,
    createdAt: po.createdAt,
    updatedAt: po.updatedAt,
    expectedDate: po.expectedDeliveryDate,
  };
}

function woToUnified(wo: WorkOrder): UnifiedOrder {
  return {
    id: wo.id,
    orderNumber: wo.woNumber,
    type: "work",
    status: wo.status,
    sourceName: wo.partName ?? null,
    totalAmount: null,
    currency: "USD",
    createdAt: wo.createdAt,
    updatedAt: wo.updatedAt,
    expectedDate: wo.scheduledDate,
  };
}

function toToUnified(to: TransferOrder): UnifiedOrder {
  return {
    id: to.id,
    orderNumber: to.toNumber,
    type: "transfer",
    status: to.status,
    sourceName:
      to.sourceFacilityName && to.destinationFacilityName
        ? `${to.sourceFacilityName} → ${to.destinationFacilityName}`
        : to.sourceFacilityName ?? to.destinationFacilityName ?? null,
    totalAmount: null,
    currency: "USD",
    createdAt: to.createdAt,
    updatedAt: to.updatedAt,
    expectedDate: to.shippedDate,
  };
}

/* ── Hook ────────────────────────────────────────────────────── */

interface UseOrderHistoryOptions {
  token: string;
  onUnauthorized: () => void;
}

export function useOrderHistory({ token, onUnauthorized }: UseOrderHistoryOptions) {
  /* State */
  const [activeTab, setActiveTab] = useState<OrderTab>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>("all");

  const [orders, setOrders] = useState<UnifiedOrder[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [transferOrders, setTransferOrders] = useState<TransferOrder[]>([]);

  const [pagination, setPagination] = useState<Pagination>(DEFAULT_PAGINATION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Detail drawer state */
  const [selectedOrder, setSelectedOrder] = useState<UnifiedOrder | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<PurchaseOrder | WorkOrder | TransferOrder | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  /* Status update */
  const [statusUpdating, setStatusUpdating] = useState(false);

  /* Abort controller for cancelling inflight requests */
  const fetchIdRef = useRef(0);

  /* ── Fetch orders ──────────────────────────────────────────── */

  const fetchOrders = useCallback(
    async (page = 1) => {
      const id = ++fetchIdRef.current;
      setLoading(true);
      setError(null);

      try {
        if (activeTab === "all") {
          const [poRes, woRes, toRes] = await Promise.all([
            fetchPurchaseOrders(token, { page: 1, pageSize: 100 }),
            fetchWorkOrders(token, { page: 1, pageSize: 100 }),
            fetchTransferOrders(token, { page: 1, pageSize: 100 }),
          ]);

          if (id !== fetchIdRef.current) return;

          setPurchaseOrders(poRes.data);
          setWorkOrders(woRes.data);
          setTransferOrders(toRes.data);

          let unified: UnifiedOrder[] = [
            ...poRes.data.map(poToUnified),
            ...woRes.data.map(woToUnified),
            ...toRes.data.map(toToUnified),
          ];

          /* Apply status filter */
          if (statusFilter !== "all") {
            unified = unified.filter((o) => o.status === statusFilter);
          }

          /* Apply date range filter */
          if (dateRange !== "all") {
            const days = dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90;
            const cutoff = Date.now() - days * 86400000;
            unified = unified.filter((o) => new Date(o.createdAt).getTime() >= cutoff);
          }

          /* Sort by date desc */
          unified.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

          /* Client-side pagination for "all" tab */
          const pageSize = 20;
          const total = unified.length;
          const totalPages = Math.max(1, Math.ceil(total / pageSize));
          const safePage = Math.min(page, totalPages);
          const start = (safePage - 1) * pageSize;

          setOrders(unified.slice(start, start + pageSize));
          setPagination({ page: safePage, pageSize, total, totalPages });
        } else if (activeTab === "purchase") {
          const poStatus = statusFilter !== "all" ? (statusFilter as POStatus) : undefined;
          const res = await fetchPurchaseOrders(token, { status: poStatus, page, pageSize: 20 });
          if (id !== fetchIdRef.current) return;

          setPurchaseOrders(res.data);
          setOrders(res.data.map(poToUnified));
          setPagination(res.pagination);
        } else if (activeTab === "work") {
          const res = await fetchWorkOrders(token, { page, pageSize: 20 });
          if (id !== fetchIdRef.current) return;

          setWorkOrders(res.data);
          let unified = res.data.map(woToUnified);
          if (statusFilter !== "all") {
            unified = unified.filter((o) => o.status === statusFilter);
          }
          setOrders(unified);
          setPagination(res.pagination);
        } else if (activeTab === "transfer") {
          const res = await fetchTransferOrders(token, { page, pageSize: 20 });
          if (id !== fetchIdRef.current) return;

          setTransferOrders(res.data);
          let unified = res.data.map(toToUnified);
          if (statusFilter !== "all") {
            unified = unified.filter((o) => o.status === statusFilter);
          }
          setOrders(unified);
          setPagination(res.pagination);
        }
      } catch (err) {
        if (id !== fetchIdRef.current) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load orders");
      } finally {
        if (id === fetchIdRef.current) {
          setLoading(false);
        }
      }
    },
    [token, activeTab, statusFilter, dateRange, onUnauthorized],
  );

  /* ── Fetch on mount / tab change ───────────────────────────── */

  useEffect(() => {
    fetchOrders(1);
  }, [fetchOrders]);

  /* ── Page change ───────────────────────────────────────────── */

  const goToPage = useCallback(
    (page: number) => {
      fetchOrders(page);
    },
    [fetchOrders],
  );

  /* ── Open detail drawer ────────────────────────────────────── */

  const openDetail = useCallback(
    async (order: UnifiedOrder) => {
      setSelectedOrder(order);
      setDrawerOpen(true);
      setDetailLoading(true);
      setSelectedDetail(null);
      setReceipts([]);

      try {
        let detail: PurchaseOrder | WorkOrder | TransferOrder | null = null;

        if (order.type === "purchase") {
          detail = await fetchPurchaseOrder(token, order.id);
        } else if (order.type === "work") {
          detail = workOrders.find((wo) => wo.id === order.id) ?? null;
        } else if (order.type === "transfer") {
          detail = transferOrders.find((to) => to.id === order.id) ?? null;
        }

        setSelectedDetail(detail);

        /* Fetch receipts */
        try {
          const r = await fetchReceiptsForOrder(token, order.id);
          setReceipts(r);
        } catch {
          /* Receipts may not exist — not blocking */
          setReceipts([]);
        }
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load order details");
      } finally {
        setDetailLoading(false);
      }
    },
    [token, workOrders, transferOrders, onUnauthorized],
  );

  /* ── Close detail drawer ───────────────────────────────────── */

  const closeDetail = useCallback(() => {
    setDrawerOpen(false);
    setSelectedOrder(null);
    setSelectedDetail(null);
    setReceipts([]);
  }, []);

  /* ── Update PO status ──────────────────────────────────────── */

  const updateStatus = useCallback(
    async (poId: string, status: POStatus, notes?: string) => {
      setStatusUpdating(true);
      try {
        const updated = await updatePurchaseOrderStatus(token, poId, { status, notes });
        setSelectedDetail(updated);
        setSelectedOrder((prev) => (prev ? { ...prev, status: updated.status } : null));
        /* Refresh list */
        await fetchOrders(pagination.page);
        return true;
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
          return false;
        }
        throw err;
      } finally {
        setStatusUpdating(false);
      }
    },
    [token, pagination.page, fetchOrders, onUnauthorized],
  );

  /* ── Tab change (resets filters) ───────────────────────────── */

  const changeTab = useCallback((tab: OrderTab) => {
    setActiveTab(tab);
    setStatusFilter("all");
  }, []);

  return {
    /* Tab / filter state */
    activeTab,
    changeTab,
    statusFilter,
    setStatusFilter,
    dateRange,
    setDateRange,

    /* Order list */
    orders,
    purchaseOrders,
    workOrders,
    transferOrders,
    pagination,
    loading,
    error,
    goToPage,
    refresh: () => fetchOrders(pagination.page),

    /* Detail drawer */
    selectedOrder,
    selectedDetail,
    receipts,
    detailLoading,
    drawerOpen,
    openDetail,
    closeDetail,

    /* Status updates */
    updateStatus,
    statusUpdating,
  };
}
