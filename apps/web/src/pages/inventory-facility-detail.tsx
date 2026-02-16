import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRightLeft, Boxes, Factory, PackageCheck, SquareKanban } from "lucide-react";
import { Button, Card, CardContent, Skeleton } from "@/components/ui";
import { ErrorBanner } from "@/components/error-banner";
import { fetchCrossLocationMatrix, fetchInventoryByFacility, isUnauthorized, parseApiError } from "@/lib/api-client";
import type { AuthSession, CrossLocationMatrixCell, InventoryLedgerEntry } from "@/types";

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

interface FacilityInventoryResult {
  data: InventoryLedgerEntry[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export function FacilityInventoryDetailRoute({ session, onUnauthorized }: Props) {
  const { facilityId } = useParams<{ facilityId: string }>();
  const navigate = useNavigate();
  const token = session.tokens.accessToken;
  const [page, setPage] = React.useState(1);
  const [result, setResult] = React.useState<FacilityInventoryResult | null>(null);
  const [matrixCells, setMatrixCells] = React.useState<CrossLocationMatrixCell[]>([]);
  const [facilityName, setFacilityName] = React.useState<string>("Facility");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchData = React.useCallback(async () => {
    if (!facilityId) {
      setError("Missing facility ID.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [inventoryRes, matrixRes] = await Promise.all([
        fetchInventoryByFacility(token, facilityId, { page, pageSize: 50 }),
        fetchCrossLocationMatrix(token, { facilityId, page: 1, pageSize: 500 }),
      ]);

      setResult(inventoryRes);
      setMatrixCells(matrixRes.data);
      const matchedFacility = matrixRes.facilities.find((facility) => facility.id === facilityId);
      if (matchedFacility?.name) {
        setFacilityName(matchedFacility.name);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, [facilityId, onUnauthorized, page, token]);

  React.useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const partMetaById = React.useMemo(() => {
    const map = new Map<string, { partNumber: string; partName: string }>();
    for (const cell of matrixCells) {
      if (!map.has(cell.partId)) {
        map.set(cell.partId, {
          partNumber: cell.partNumber,
          partName: cell.partName,
        });
      }
    }
    return map;
  }, [matrixCells]);

  const rows = React.useMemo(
    () =>
      (result?.data ?? []).map((entry) => {
        const meta = partMetaById.get(entry.partId);
        return {
          ...entry,
          displayPartNumber: meta?.partNumber ?? entry.partId.slice(0, 8),
          displayPartName: meta?.partName ?? entry.partName ?? "Unknown part",
        };
      }),
    [partMetaById, result?.data],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/inventory/cross-location")}
            className="px-2"
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to Network Inventory
          </Button>
          <h1 className="text-2xl font-bold">{facilityName}</h1>
          <p className="text-sm text-muted-foreground">
            Location-specific inventory drill-down with connected operational actions
          </p>
        </div>
      </div>

      <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Button variant="outline" className="justify-start" onClick={() => navigate("/transfer-orders")}>
          <ArrowRightLeft className="mr-2 h-4 w-4" />
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

      {error && <ErrorBanner message={error} onRetry={fetchData} />}

      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">Facility Inventory</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Click a part to focus it in the network matrix
            </p>
          </div>

          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 8 }).map((_, idx) => (
                <Skeleton key={idx} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              <Boxes className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
              No inventory rows found for this facility.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead className="bg-muted">
                    <tr>
                      <th className="border-r border-border px-3 py-2 text-left text-xs font-semibold">Part</th>
                      <th className="border-r border-border px-3 py-2 text-right text-xs font-semibold">On Hand</th>
                      <th className="border-r border-border px-3 py-2 text-right text-xs font-semibold">Reserved</th>
                      <th className="border-r border-border px-3 py-2 text-right text-xs font-semibold">Available</th>
                      <th className="border-r border-border px-3 py-2 text-right text-xs font-semibold">In Transit</th>
                      <th className="border-r border-border px-3 py-2 text-right text-xs font-semibold">Reorder Point</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className="border-t border-border hover:bg-muted/40">
                        <td className="border-r border-border px-3 py-2">
                          <button
                            type="button"
                            className="text-left text-sm text-[hsl(var(--link))] hover:underline"
                            onClick={() =>
                              navigate(
                                `/inventory/cross-location?facilityId=${encodeURIComponent(row.facilityId)}&partId=${encodeURIComponent(row.partId)}`,
                              )
                            }
                          >
                            <div className="font-semibold">{row.displayPartNumber}</div>
                            <div className="text-xs text-muted-foreground">{row.displayPartName}</div>
                          </button>
                        </td>
                        <td className="border-r border-border px-3 py-2 text-right text-sm">{row.qtyOnHand}</td>
                        <td className="border-r border-border px-3 py-2 text-right text-sm">{row.qtyReserved}</td>
                        <td className="border-r border-border px-3 py-2 text-right text-sm">
                          {row.qtyOnHand - row.qtyReserved}
                        </td>
                        <td className="border-r border-border px-3 py-2 text-right text-sm">{row.qtyInTransit}</td>
                        <td className="border-r border-border px-3 py-2 text-right text-sm">
                          {row.reorderPoint ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {new Date(row.updatedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {result && result.pagination.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    Page {result.pagination.page} of {result.pagination.totalPages}
                    {" · "}
                    {result.pagination.total} rows
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={result.pagination.page <= 1}
                      onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={result.pagination.page >= result.pagination.totalPages}
                      onClick={() => setPage((prev) => prev + 1)}
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
    </div>
  );
}
