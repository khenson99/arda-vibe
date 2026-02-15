import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeftRight,
  Building2,
  Clock,
  DollarSign,
  Loader2,
  Package,
  Triangle,
} from "lucide-react";
import { Badge, Button, Card, CardContent, Skeleton } from "@/components/ui";
import { MetricCard } from "@/components/metric-card";
import { ErrorBanner } from "@/components/error-banner";
import { useCrossLocationMatrix, useCrossLocationSummary } from "@/hooks/use-cross-location-inventory";
import { cn } from "@/lib/utils";
import type { AuthSession, CrossLocationMatrixCell } from "@/types";

interface CrossLocationInventoryPageProps {
  session: AuthSession;
  onUnauthorized: () => void;
}

export function CrossLocationInventoryPage({ session }: CrossLocationInventoryPageProps) {
  const navigate = useNavigate();
  const token = session.tokens.accessToken;
  const [page, setPage] = React.useState(1);
  const [pageSize] = React.useState(50);
  const [selectedCell, setSelectedCell] = React.useState<CrossLocationMatrixCell | null>(null);

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
  } = useCrossLocationMatrix(token, { page, pageSize });

  const error = summaryError || matrixError;
  const handleRefresh = React.useCallback(() => {
    void refetchSummary();
    void refetchMatrix();
  }, [refetchSummary, refetchMatrix]);

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cross-Location Inventory</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Network-wide stock visibility with facility-part matrix
        </p>
      </div>

      {error && <ErrorBanner message={error.message} onRetry={handleRefresh} />}

      {/* KPI Cards */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {summaryLoading ? (
          <>
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
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
        <CellDetailModal cell={selectedCell} onClose={handleCloseCellDetail} />
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
}

function CellDetailModal({ cell, onClose }: CellDetailModalProps) {
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
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
