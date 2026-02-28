import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeftRight,
  Building2,
  Clock,
  DollarSign,
  Factory,
  Loader2,
  Package,
  PackageCheck,
  SquareKanban,
  Triangle,
} from "lucide-react";
import { Badge, Button, Card, CardContent, Skeleton } from "@/components/ui";
import { MetricCard } from "@/components/metric-card";
import { ErrorBanner } from "@/components/error-banner";
import { useCrossLocationMatrix, useCrossLocationSummary } from "@/hooks/use-cross-location-inventory";
import {
  fetchLoops,
  fetchReceivingMetrics,
  fetchWorkOrders,
  isUnauthorized,
  parseApiError,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { AuthSession, CrossLocationMatrixCell } from "@/types";

interface CrossLocationInventoryPageProps {
  session: AuthSession;
  onUnauthorized: () => void;
}

interface IntegrationSnapshot {
  activeWorkOrders: number;
  totalReceipts: number;
  openReceivingExceptions: number;
  loopsTracked: number;
  kanbanStatusCounts: Array<{ status: string; count: number }>;
  refreshedAt: string;
}

export function CrossLocationInventoryPage({
  session,
  onUnauthorized,
}: CrossLocationInventoryPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = session.tokens.accessToken;
  const [page, setPage] = React.useState(1);
  const [pageSize] = React.useState(50);
  const [selectedCell, setSelectedCell] = React.useState<CrossLocationMatrixCell | null>(null);
  const [integrationSnapshot, setIntegrationSnapshot] = React.useState<IntegrationSnapshot | null>(null);
  const [integrationLoading, setIntegrationLoading] = React.useState(true);
  const [integrationError, setIntegrationError] = React.useState<Error | null>(null);

  const facilityFilter = searchParams.get("facilityId") ?? undefined;
  const partFilter = searchParams.get("partId") ?? undefined;

  const {
    data: summaryData,
    loading: summaryLoading,
    error: summaryError,
    refetch: refetchSummary,
  } = useCrossLocationSummary(token);

  const {
    data: matrixData,
    loading: matrixLoading,
    error: matrixError,
    refetch: refetchMatrix,
  } = useCrossLocationMatrix(token, {
    page,
    pageSize,
    facilityId: facilityFilter,
    partId: partFilter,
  });

  const refreshIntegration = React.useCallback(async () => {
    if (!token) {
      setIntegrationLoading(false);
      return;
    }

    setIntegrationError(null);
    setIntegrationLoading(true);

    try {
      const scopedFacilityIds = matrixData?.facilities.map((facility) => facility.id)
        ?? (facilityFilter ? [facilityFilter] : []);

      const [receivingMetrics, workOrdersResponse, loopsResponse] = await Promise.all([
        fetchReceivingMetrics(token),
        fetchWorkOrders(token, { page: 1, pageSize: 1, status: "in_progress" }),
        (async () => {
          const firstPage = await fetchLoops(token, { page: 1, pageSize: 200 });
          let loops = [...firstPage.data];
          const maxPages = Math.min(firstPage.pagination.totalPages, 5);
          for (let loopPage = 2; loopPage <= maxPages; loopPage += 1) {
            const nextPage = await fetchLoops(token, { page: loopPage, pageSize: 200 });
            loops = loops.concat(nextPage.data);
          }
          return loops;
        })(),
      ]);

      const scopedLoops = scopedFacilityIds.length > 0
        ? loopsResponse.filter((loop) => scopedFacilityIds.includes(loop.facilityId))
        : loopsResponse;

      const byStatus = new Map<string, number>();
      for (const loop of scopedLoops) {
        const key = loop.status || "unknown";
        byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
      }

      setIntegrationSnapshot({
        activeWorkOrders: workOrdersResponse.pagination.total,
        totalReceipts: receivingMetrics.totalReceipts,
        openReceivingExceptions: receivingMetrics.totalExceptions,
        loopsTracked: scopedLoops.length,
        kanbanStatusCounts: Array.from(byStatus.entries())
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => b.count - a.count),
        refreshedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setIntegrationError(new Error(parseApiError(err)));
    } finally {
      setIntegrationLoading(false);
    }
  }, [facilityFilter, matrixData?.facilities, onUnauthorized, token]);

  const error = summaryError || matrixError || integrationError;
  const handleRefresh = React.useCallback(() => {
    void refetchSummary();
    void refetchMatrix();
    void refreshIntegration();
  }, [refetchSummary, refetchMatrix, refreshIntegration]);

  const handleCellClick = React.useCallback((cell: CrossLocationMatrixCell) => {
    setSelectedCell(cell);
  }, []);

  const handleFacilityClick = React.useCallback((facilityId: string) => {
    navigate(`/inventory/facilities/${facilityId}`);
  }, [navigate]);

  const handleCloseCellDetail = React.useCallback(() => {
    setSelectedCell(null);
  }, []);

  const handlePageChange = React.useCallback((newPage: number) => {
    setPage(newPage);
  }, []);

  React.useEffect(() => {
    void refreshIntegration();
  }, [refreshIntegration]);

  React.useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refetchSummary();
      void refetchMatrix();
      void refreshIntegration();
    }, 30_000);

    return () => window.clearInterval(intervalId);
  }, [refetchMatrix, refetchSummary, refreshIntegration]);

  React.useEffect(() => {
    const handleFocus = () => {
      void refetchSummary();
      void refetchMatrix();
      void refreshIntegration();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refetchMatrix, refetchSummary, refreshIntegration]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cross-Location Inventory</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Network-wide stock visibility connected to orders, transfers, receiving, and production
        </p>
      </div>

      {error && <ErrorBanner message={error.message} onRetry={handleRefresh} />}

      {(facilityFilter || partFilter) && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="text-xs text-muted-foreground">
              Filtered view:
              {facilityFilter && (
                <span className="ml-2 rounded-full bg-muted px-2 py-1">facility: {facilityFilter}</span>
              )}
              {partFilter && (
                <span className="ml-2 rounded-full bg-muted px-2 py-1">part: {partFilter}</span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate("/inventory/cross-location")}>
              Clear filters
            </Button>
          </CardContent>
        </Card>
      )}

      {/* KPI Cards */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {summaryLoading ? (
          <>
            {Array.from({ length: 4 }).map((_, idx) => (
              <Card key={idx}>
                <CardContent className="space-y-3 p-4">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-8 w-16" />
                  <Skeleton className="h-3 w-32" />
                </CardContent>
              </Card>
            ))}
          </>
        ) : (
          <>
            <MetricCard
              label="In-Transit Value"
              value={`$${summaryData?.totalInTransitValue.toLocaleString() ?? 0}`}
              detail="Total network in-transit"
              icon={DollarSign}
            />
            <MetricCard
              label="Pending Transfers"
              value={String(summaryData?.pendingTransferCount ?? 0)}
              detail="Active transfer orders"
              icon={ArrowLeftRight}
            />
            <MetricCard
              label="Avg Lead Time"
              value={`${summaryData?.averageNetworkLeadTime.toFixed(1) ?? 0}d`}
              detail="Network-wide average"
              icon={Clock}
            />
            <MetricCard
              label="Below Reorder"
              value={String(summaryData?.facilitiesBelowReorder ?? 0)}
              detail="Facilities needing stock"
              icon={Triangle}
              tone={
                (summaryData?.facilitiesBelowReorder ?? 0) > 0 ? "warning" : "default"
              }
            />
          </>
        )}
      </section>

      <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <Button variant="outline" className="justify-start" onClick={() => navigate("/queue")}>
          <ArrowLeftRight className="mr-2 h-4 w-4" />
          Order Queue
        </Button>
        <Button variant="outline" className="justify-start" onClick={() => navigate("/transfer-orders")}>
          <ArrowLeftRight className="mr-2 h-4 w-4" />
          Transfer Workflows
        </Button>
        <Button variant="outline" className="justify-start" onClick={() => navigate("/receiving")}>
          <PackageCheck className="mr-2 h-4 w-4" />
          Receiving
        </Button>
        <Button variant="outline" className="justify-start" onClick={() => navigate("/loops")}>
          <SquareKanban className="mr-2 h-4 w-4" />
          Kanban Loops
        </Button>
        <Button variant="outline" className="justify-start" onClick={() => navigate("/cards")}>
          <Factory className="mr-2 h-4 w-4" />
          Production Cards
        </Button>
      </section>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Module Integration Snapshot</h2>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              Refresh
            </Button>
          </div>

          {integrationLoading && !integrationSnapshot ? (
            <div className="grid gap-3 md:grid-cols-3">
              {Array.from({ length: 3 }).map((_, idx) => (
                <Skeleton key={idx} className="h-12 w-full" />
              ))}
            </div>
          ) : integrationSnapshot ? (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">Active Production Work Orders</p>
                  <p className="mt-1 text-lg font-semibold">{integrationSnapshot.activeWorkOrders}</p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">Receiving Receipts Processed</p>
                  <p className="mt-1 text-lg font-semibold">{integrationSnapshot.totalReceipts}</p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">Open Receiving Exceptions</p>
                  <p className="mt-1 text-lg font-semibold">{integrationSnapshot.openReceivingExceptions}</p>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Kanban loop statuses across visible facilities ({integrationSnapshot.loopsTracked} tracked)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {integrationSnapshot.kanbanStatusCounts.length > 0 ? (
                    integrationSnapshot.kanbanStatusCounts.map((entry) => (
                      <Badge key={entry.status} variant="outline">
                        {entry.status}: {entry.count}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="secondary">No loops in current scope</Badge>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Last refreshed {new Date(integrationSnapshot.refreshedAt).toLocaleTimeString()}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No integration data available.</p>
          )}
        </CardContent>
      </Card>

      {/* Facility-Part Matrix */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">Facility x Part Matrix</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Stock levels across network (qtyOnHand / available)
                </p>
              </div>
              {matrixData && (
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 rounded-sm bg-[hsl(var(--arda-error)/0.15)]" />
                    <span>Below reorder</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 rounded-sm bg-[hsl(var(--arda-warning)/0.15)]" />
                    <span>Near reorder</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {matrixLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="flex items-center gap-3 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Loading matrix...</span>
              </div>
            </div>
          ) : !matrixData || matrixData.data.length === 0 ? (
            <div className="flex items-center justify-center p-12">
              <div className="text-center">
                <Package className="mx-auto h-12 w-12 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">No inventory data</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Stock data will appear here once inventory is tracked
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <MatrixTable
                  facilities={matrixData.facilities}
                  parts={matrixData.parts}
                  cells={matrixData.data}
                  onCellClick={handleCellClick}
                  onFacilityClick={handleFacilityClick}
                />
              </div>

              {/* Pagination Controls */}
              {matrixData.pagination.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    Page {matrixData.pagination.page} of {matrixData.pagination.totalPages}
                    {" · "}
                    {matrixData.pagination.total} total parts
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(page - 1)}
                      disabled={page === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(page + 1)}
                      disabled={page === matrixData.pagination.totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Cell Detail Modal */}
      {selectedCell && (
        <CellDetailModal
          cell={selectedCell}
          onClose={handleCloseCellDetail}
          onOpenFacility={() => navigate(`/inventory/facilities/${selectedCell.facilityId}`)}
          onOpenTransferOrders={() => navigate("/transfer-orders")}
          onOpenQueue={() => navigate("/queue")}
          onOpenKanban={() => navigate("/loops")}
          onOpenReceiving={() => navigate("/receiving")}
        />
      )}
    </div>
  );
}

interface MatrixTableProps {
  facilities: Array<{ id: string; name: string }>;
  parts: Array<{ id: string; partNumber: string; name: string }>;
  cells: CrossLocationMatrixCell[];
  onCellClick: (cell: CrossLocationMatrixCell) => void;
  onFacilityClick: (facilityId: string) => void;
}

function MatrixTable({
  facilities,
  parts,
  cells,
  onCellClick,
  onFacilityClick,
}: MatrixTableProps) {
  const cellMap = React.useMemo(() => {
    const map = new Map<string, CrossLocationMatrixCell>();
    cells.forEach((cell) => {
      const key = `${cell.facilityId}:${cell.partId}`;
      map.set(key, cell);
    });
    return map;
  }, [cells]);

  const getCell = React.useCallback(
    (facilityId: string, partId: string) => {
      return cellMap.get(`${facilityId}:${partId}`);
    },
    [cellMap],
  );

  return (
    <table className="w-full border-collapse">
      <thead className="sticky top-0 z-10 bg-muted">
        <tr>
          <th className="border-r border-border bg-muted px-3 py-2 text-left text-xs font-semibold">
            Facility
          </th>
          {parts.map((part) => (
            <th
              key={part.id}
              className="min-w-[100px] border-r border-border px-2 py-2 text-left text-xs font-medium"
            >
              <div className="truncate" title={`${part.partNumber} - ${part.name}`}>
                {part.partNumber}
              </div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {facilities.map((facility) => (
          <tr key={facility.id} className="hover:bg-muted/50">
            <td className="border-r border-t border-border bg-muted/30 px-3 py-2">
              <button
                type="button"
                onClick={() => onFacilityClick(facility.id)}
                className="text-left text-sm font-semibold text-[hsl(var(--link))] hover:underline"
              >
                <div className="flex items-center gap-2">
                  <Building2 className="h-3.5 w-3.5" />
                  {facility.name}
                </div>
              </button>
            </td>
            {parts.map((part) => {
              const cell = getCell(facility.id, part.id);
              return (
                <MatrixCell
                  key={`${facility.id}:${part.id}`}
                  cell={cell}
                  onClick={() => cell && onCellClick(cell)}
                />
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface MatrixCellProps {
  cell: CrossLocationMatrixCell | undefined;
  onClick: () => void;
}

function MatrixCell({ cell, onClick }: MatrixCellProps) {
  if (!cell) {
    return (
      <td className="border-r border-t border-border px-2 py-2 text-center">
        <span className="text-xs text-muted-foreground">—</span>
      </td>
    );
  }

  return (
    <td
      className={cn(
        "border-r border-t border-border px-2 py-2 text-center",
        cell.isBelowReorder && "bg-[hsl(var(--arda-error)/0.08)]",
        cell.isNearReorder && !cell.isBelowReorder && "bg-[hsl(var(--arda-warning)/0.08)]",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full rounded px-1.5 py-1 text-xs font-medium hover:bg-muted/50",
          cell.isBelowReorder && "text-[hsl(var(--arda-error))]",
          cell.isNearReorder &&
            !cell.isBelowReorder &&
            "text-[hsl(var(--arda-warning))]",
        )}
      >
        {cell.qtyOnHand} / {cell.available}
      </button>
    </td>
  );
}

interface CellDetailModalProps {
  cell: CrossLocationMatrixCell;
  onClose: () => void;
  onOpenFacility: () => void;
  onOpenTransferOrders: () => void;
  onOpenQueue: () => void;
  onOpenKanban: () => void;
  onOpenReceiving: () => void;
}

function CellDetailModal({
  cell,
  onClose,
  onOpenFacility,
  onOpenTransferOrders,
  onOpenQueue,
  onOpenKanban,
  onOpenReceiving,
}: CellDetailModalProps) {
  React.useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-md"
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
      >
        <CardContent className="space-y-4 p-6">
          <div>
            <h3 className="text-lg font-semibold">Inventory Detail</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {cell.facilityName} · {cell.partNumber}
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <span className="text-sm text-muted-foreground">Part Name</span>
              <span className="text-sm font-semibold">{cell.partName}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <span className="text-sm text-muted-foreground">On Hand</span>
              <span className="text-sm font-semibold">{cell.qtyOnHand}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <span className="text-sm text-muted-foreground">Reserved</span>
              <span className="text-sm font-semibold">{cell.qtyReserved}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <span className="text-sm text-muted-foreground">Available</span>
              <span className="text-sm font-semibold">{cell.available}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <span className="text-sm text-muted-foreground">In Transit</span>
              <span className="text-sm font-semibold">{cell.qtyInTransit}</span>
            </div>
            {cell.reorderPoint !== null && (
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <span className="text-sm text-muted-foreground">Reorder Point</span>
                <span className="text-sm font-semibold">{cell.reorderPoint}</span>
              </div>
            )}
            {cell.isBelowReorder && (
              <div className="rounded-md border border-[hsl(var(--arda-error))] bg-[hsl(var(--arda-error)/0.08)] p-3">
                <Badge variant="destructive">Below Reorder Point</Badge>
              </div>
            )}
            {cell.isNearReorder && !cell.isBelowReorder && (
              <div className="rounded-md border border-[hsl(var(--arda-warning))] bg-[hsl(var(--arda-warning)/0.08)] p-3">
                <Badge variant="warning">Near Reorder Point</Badge>
              </div>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="outline" onClick={onOpenFacility}>Facility Inventory</Button>
            <Button variant="outline" onClick={onOpenTransferOrders}>Transfer Orders</Button>
            <Button variant="outline" onClick={onOpenQueue}>Order Queue</Button>
            <Button variant="outline" onClick={onOpenKanban}>Kanban Loops</Button>
            <Button variant="outline" className="sm:col-span-2" onClick={onOpenReceiving}>
              Receiving
            </Button>
          </div>

          <Button onClick={onClose} className="w-full">
            Close
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function CrossLocationInventoryRoute(props: CrossLocationInventoryPageProps) {
  return <CrossLocationInventoryPage {...props} />;
}
