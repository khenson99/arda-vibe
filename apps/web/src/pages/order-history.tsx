import type { AuthSession } from "@/types";
import { useOrderHistory } from "@/hooks/use-order-history";
import {
  OrderFilters,
  OrderTable,
  OrderDetailDrawer,
} from "@/components/order-history";
import { AlertCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { useNavigate } from "react-router-dom";

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

export function OrderHistoryRoute({ session, onUnauthorized }: Props) {
  const navigate = useNavigate();
  const {
    activeTab,
    changeTab,
    statusFilter,
    setStatusFilter,
    dateRange,
    setDateRange,
    orders,
    pagination,
    loading,
    error,
    goToPage,
    refresh,
    selectedOrder,
    selectedDetail,
    receipts,
    detailLoading,
    drawerOpen,
    openDetail,
    closeDetail,
    updateStatus,
    statusUpdating,
  } = useOrderHistory({
    token: session.tokens.accessToken,
    onUnauthorized,
  });

  return (
    <div className="space-y-4 p-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Order History</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Track purchase orders, work orders, and transfer orders across your supply chain.
          </p>
        </div>
        {activeTab === "purchase" && (
          <Button
            size="sm"
            onClick={() => navigate("/orders/po/new")}
            className="text-xs"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create PO
          </Button>
        )}
      </div>

      {/* Filters */}
      <OrderFilters
        activeTab={activeTab}
        onTabChange={changeTab}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        onRefresh={refresh}
        loading={loading}
      />

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            className="ml-auto h-7 text-xs"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Orders table */}
      <div className="rounded-xl border border-border bg-background shadow-sm overflow-hidden">
        <OrderTable
          orders={orders}
          loading={loading}
          pagination={pagination}
          onRowClick={openDetail}
          onPageChange={goToPage}
        />
      </div>

      {/* Detail drawer */}
      <OrderDetailDrawer
        open={drawerOpen}
        onClose={closeDetail}
        order={selectedOrder}
        detail={selectedDetail}
        receipts={receipts}
        loading={detailLoading}
        onUpdateStatus={updateStatus}
        statusUpdating={statusUpdating}
      />
    </div>
  );
}
