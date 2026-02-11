import * as React from "react";
import type { AuthSession, TOStatus, TransferOrder, TransferOrderLine, SourceRecommendation, PartRecord } from "@/types";
import { useTransferOrders } from "@/hooks/use-transfer-orders";
import type { TransferTab } from "@/hooks/use-transfer-orders";
import { fetchParts } from "@/lib/api-client";
import { OrderStatusBadge } from "@/components/order-history/order-status-badge";
import {
  Button,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
} from "@/components/ui";
import {
  ArrowLeft,
  Plus,
  Trash2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  PackageCheck,
  ArrowRightLeft,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ================================================================
   Shared helpers
   ================================================================ */

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

const ALL_STATUSES: Array<TOStatus | "all"> = [
  "all",
  "draft",
  "requested",
  "approved",
  "picking",
  "shipped",
  "in_transit",
  "received",
  "closed",
  "cancelled",
];

const STATUS_LABELS: Record<string, string> = {
  all: "All",
  draft: "Draft",
  requested: "Requested",
  approved: "Approved",
  picking: "Picking",
  shipped: "Shipped",
  in_transit: "In Transit",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
};

/* ================================================================
   QueueView
   ================================================================ */

interface QueueViewProps {
  orders: TransferOrder[];
  ordersLoading: boolean;
  ordersError: string | null;
  ordersPage: number;
  ordersTotalPages: number;
  setOrdersPage: (page: number) => void;
  statusFilter: TOStatus | "all";
  setStatusFilter: (s: TOStatus | "all") => void;
  refreshOrders: () => void;
  selectOrder: (order: TransferOrder) => void;
  setActiveTab: (tab: TransferTab) => void;
}

function QueueView({
  orders,
  ordersLoading,
  ordersError,
  ordersPage,
  ordersTotalPages,
  setOrdersPage,
  statusFilter,
  setStatusFilter,
  refreshOrders,
  selectOrder,
  setActiveTab,
}: QueueViewProps) {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Transfer Orders</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshOrders}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setActiveTab("new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Transfer
          </Button>
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium border transition-colors",
              statusFilter === s
                ? "bg-primary text-white border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted/50",
            )}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {/* List */}
      {ordersLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : ordersError ? (
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-destructive">{ordersError}</CardContent>
        </Card>
      ) : orders.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="py-12 text-center">
            <ArrowRightLeft className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No transfer orders found.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => (
            <Card
              key={order.id}
              className="rounded-xl shadow-sm cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => selectOrder(order)}
            >
              <CardContent className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{order.toNumber}</span>
                      <OrderStatusBadge status={order.status} type="transfer" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {order.sourceFacilityName && order.destinationFacilityName
                        ? `${order.sourceFacilityName} → ${order.destinationFacilityName}`
                        : order.sourceFacilityName ?? order.destinationFacilityName ?? "—"}
                    </p>
                  </div>
                  <div className="text-right space-y-1">
                    <p className="text-xs text-muted-foreground">{formatDate(order.createdAt)}</p>
                    {order.lines && (
                      <p className="text-xs text-muted-foreground">{order.lines.length} line(s)</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {ordersTotalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={ordersPage <= 1}
            onClick={() => setOrdersPage(ordersPage - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {ordersPage} of {ordersTotalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={ordersPage >= ordersTotalPages}
            onClick={() => setOrdersPage(ordersPage + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </>
  );
}

/* ================================================================
   DetailView
   ================================================================ */

interface DetailViewProps {
  order: TransferOrder | null;
  detailLoading: boolean;
  detailError: string | null;
  validTransitions: TOStatus[];
  transitionsLoading: boolean;
  transitioning: boolean;
  transitionOrder: (status: TOStatus, reason?: string) => Promise<boolean>;
  onBack: () => void;
}

function DetailView({
  order,
  detailLoading,
  detailError,
  validTransitions,
  transitionsLoading,
  transitioning,
  transitionOrder,
  onBack,
}: DetailViewProps) {
  const [reason, setReason] = React.useState("");

  const handleTransition = React.useCallback(
    async (status: TOStatus) => {
      const ok = await transitionOrder(status, reason || undefined);
      if (ok) setReason("");
    },
    [transitionOrder, reason],
  );

  if (detailLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  if (detailError) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-destructive">{detailError}</CardContent>
        </Card>
      </div>
    );
  }

  if (!order) return null;

  return (
    <div className="space-y-4">
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Queue
      </Button>

      {/* Header card */}
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{order.toNumber}</CardTitle>
            <OrderStatusBadge status={order.status} type="transfer" />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Source:</span>{" "}
              <span className="font-semibold">{order.sourceFacilityName ?? "—"}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Destination:</span>{" "}
              <span className="font-semibold">{order.destinationFacilityName ?? "—"}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Created:</span>{" "}
              <span className="font-semibold">{formatDate(order.createdAt)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Requested:</span>{" "}
              <span className="font-semibold">{formatDate(order.requestedDate)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Shipped:</span>{" "}
              <span className="font-semibold">{formatDate(order.shippedDate)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Received:</span>{" "}
              <span className="font-semibold">{formatDate(order.receivedDate)}</span>
            </div>
          </div>
          {order.notes && (
            <div className="text-sm">
              <span className="text-muted-foreground">Notes:</span>{" "}
              <span>{order.notes}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lines table */}
      {order.lines && order.lines.length > 0 && (
        <Card className="rounded-xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Lines</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted">
                    <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Part</th>
                    <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Requested</th>
                    <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Shipped</th>
                    <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Received</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {order.lines.map((line: TransferOrderLine) => (
                    <tr key={line.id} className="hover:bg-muted/50">
                      <td className="px-3 py-2 font-medium">{line.partName ?? line.partId}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{line.quantityRequested}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span
                          className={cn(
                            line.quantityShipped >= line.quantityRequested
                              ? "text-[hsl(var(--arda-success))]"
                              : line.quantityShipped > 0
                                ? "text-[hsl(var(--arda-warning))]"
                                : "text-muted-foreground",
                          )}
                        >
                          {line.quantityShipped}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span
                          className={cn(
                            line.quantityReceived >= line.quantityRequested
                              ? "text-[hsl(var(--arda-success))]"
                              : line.quantityReceived > 0
                                ? "text-[hsl(var(--arda-warning))]"
                                : "text-muted-foreground",
                          )}
                        >
                          {line.quantityReceived}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lifecycle actions */}
      {validTransitions.length > 0 && (
        <Card className="rounded-xl shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Reason / notes (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="text-sm"
            />
            <div className="flex flex-wrap gap-2">
              {transitionsLoading ? (
                <Skeleton className="h-9 w-32" />
              ) : (
                validTransitions.map((status) => (
                  <Button
                    key={status}
                    size="sm"
                    variant={status === "cancelled" ? "destructive" : "default"}
                    disabled={transitioning}
                    onClick={() => handleTransition(status)}
                  >
                    {transitioning && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    {STATUS_LABELS[status] ?? status}
                  </Button>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ================================================================
   NewTransferView
   ================================================================ */

interface NewTransferViewProps {
  token: string;
  facilities: Array<{ id: string; name: string }>;
  facilitiesLoading: boolean;
  sourceRecommendations: SourceRecommendation[];
  recommendationsLoading: boolean;
  fetchRecommendations: (destId: string, partId: string) => void;
  createOrder: (input: {
    sourceFacilityId: string;
    destinationFacilityId: string;
    notes?: string;
    lines: Array<{ partId: string; quantityRequested: number; notes?: string }>;
  }) => Promise<boolean>;
  creating: boolean;
  createError: string | null;
  onCancel: () => void;
}

interface LineItem {
  partId: string;
  quantityRequested: number;
  notes: string;
}

function NewTransferView({
  token,
  facilities,
  facilitiesLoading,
  sourceRecommendations,
  recommendationsLoading,
  fetchRecommendations,
  createOrder,
  creating,
  createError,
  onCancel,
}: NewTransferViewProps) {
  const [destinationId, setDestinationId] = React.useState("");
  const [sourceId, setSourceId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState<LineItem[]>([
    { partId: "", quantityRequested: 1, notes: "" },
  ]);
  const [parts, setParts] = React.useState<PartRecord[]>([]);
  const [partsLoading, setPartsLoading] = React.useState(false);

  /* Load parts for dropdown */
  React.useEffect(() => {
    let cancelled = false;
    setPartsLoading(true);
    fetchParts(token)
      .then((res) => {
        if (!cancelled) setParts(res.data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPartsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  /* Fetch recommendations when dest + first line partId are set */
  React.useEffect(() => {
    const firstPartId = lines[0]?.partId;
    if (destinationId && firstPartId) {
      fetchRecommendations(destinationId, firstPartId);
    }
  }, [destinationId, lines[0]?.partId, fetchRecommendations]);

  const addLine = () => {
    setLines((prev) => [...prev, { partId: "", quantityRequested: 1, notes: "" }]);
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateLine = (idx: number, field: keyof LineItem, value: string | number) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  };

  const canSubmit =
    destinationId &&
    sourceId &&
    destinationId !== sourceId &&
    lines.length > 0 &&
    lines.every((l) => l.partId && l.quantityRequested > 0);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await createOrder({
      sourceFacilityId: sourceId,
      destinationFacilityId: destinationId,
      notes: notes || undefined,
      lines: lines.map((l) => ({
        partId: l.partId,
        quantityRequested: l.quantityRequested,
        notes: l.notes || undefined,
      })),
    });
  };

  const filteredSourceFacilities = facilities.filter((f) => f.id !== destinationId);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">New Transfer Order</h1>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {/* Facilities */}
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Facilities</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Destination Facility
              </label>
              {facilitiesLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={destinationId}
                  onChange={(e) => {
                    setDestinationId(e.target.value);
                    if (sourceId === e.target.value) setSourceId("");
                  }}
                >
                  <option value="">Select destination…</option>
                  {facilities.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Source Facility
              </label>
              {facilitiesLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                  disabled={!destinationId}
                >
                  <option value="">Select source…</option>
                  {filteredSourceFacilities.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Source recommendations */}
          {destinationId && sourceRecommendations.length > 0 && (
            <div className="rounded-lg border border-border p-3 bg-accent/5">
              <p className="text-xs font-semibold text-muted-foreground mb-2">
                Recommended Sources
              </p>
              <div className="space-y-1">
                {recommendationsLoading ? (
                  <Skeleton className="h-6 w-full" />
                ) : (
                  sourceRecommendations.map((rec) => (
                    <button
                      key={rec.facilityId}
                      className={cn(
                        "flex items-center justify-between w-full rounded-md px-2 py-1.5 text-xs transition-colors",
                        sourceId === rec.facilityId
                          ? "bg-primary/10 border border-primary/30"
                          : "hover:bg-muted/50",
                      )}
                      onClick={() => setSourceId(rec.facilityId)}
                    >
                      <span className="font-medium">{rec.facilityName}</span>
                      <span className="text-muted-foreground">
                        {rec.qtyAvailable} avail
                        {rec.avgLeadTimeDays != null && ` · ${rec.avgLeadTimeDays}d lead`}
                        {rec.distanceKm != null && ` · ${Math.round(rec.distanceKm)}km`}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Notes</label>
            <Input
              placeholder="Optional notes…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* Line items */}
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Line Items</CardTitle>
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add Line
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.map((line, idx) => (
            <div key={idx} className="flex items-end gap-2">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground mb-1 block">Part</label>
                {partsLoading ? (
                  <Skeleton className="h-9 w-full" />
                ) : (
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={line.partId}
                    onChange={(e) => updateLine(idx, "partId", e.target.value)}
                  >
                    <option value="">Select part…</option>
                    {parts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.partNumber} — {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="w-24">
                <label className="text-xs text-muted-foreground mb-1 block">Qty</label>
                <Input
                  type="number"
                  min={1}
                  value={line.quantityRequested}
                  onChange={(e) => updateLine(idx, "quantityRequested", Math.max(1, Number(e.target.value)))}
                  className="text-sm"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
                <Input
                  placeholder="Optional"
                  value={line.notes}
                  onChange={(e) => updateLine(idx, "notes", e.target.value)}
                  className="text-sm"
                />
              </div>
              {lines.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive/80"
                  onClick={() => removeLine(idx)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Error */}
      {createError && (
        <p className="text-sm text-destructive px-1">{createError}</p>
      )}

      {/* Submit */}
      <div className="flex justify-end">
        <Button disabled={!canSubmit || creating} onClick={handleSubmit}>
          {creating && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          <PackageCheck className="mr-1.5 h-4 w-4" />
          Create Transfer Order
        </Button>
      </div>
    </div>
  );
}

/* ================================================================
   Main Route Component
   ================================================================ */

export function TransferOrdersRoute({ session, onUnauthorized }: Props) {
  const hook = useTransferOrders(session.tokens.accessToken, onUnauthorized);

  const handleBack = React.useCallback(() => {
    hook.clearSelectedOrder();
    hook.setActiveTab("queue");
  }, [hook.clearSelectedOrder, hook.setActiveTab]);

  const handleCancelNew = React.useCallback(() => {
    hook.setActiveTab("queue");
  }, [hook.setActiveTab]);

  return (
    <div className="space-y-4 p-4">
      {hook.activeTab === "queue" && (
        <QueueView
          orders={hook.orders}
          ordersLoading={hook.ordersLoading}
          ordersError={hook.ordersError}
          ordersPage={hook.ordersPage}
          ordersTotalPages={hook.ordersTotalPages}
          setOrdersPage={hook.setOrdersPage}
          statusFilter={hook.statusFilter}
          setStatusFilter={hook.setStatusFilter}
          refreshOrders={hook.refreshOrders}
          selectOrder={hook.selectOrder}
          setActiveTab={hook.setActiveTab}
        />
      )}

      {hook.activeTab === "detail" && (
        <DetailView
          order={hook.selectedOrder}
          detailLoading={hook.detailLoading}
          detailError={hook.detailError}
          validTransitions={hook.validTransitions}
          transitionsLoading={hook.transitionsLoading}
          transitioning={hook.transitioning}
          transitionOrder={hook.transitionOrder}
          onBack={handleBack}
        />
      )}

      {hook.activeTab === "new" && (
        <NewTransferView
          token={session.tokens.accessToken}
          facilities={hook.facilities}
          facilitiesLoading={hook.facilitiesLoading}
          sourceRecommendations={hook.sourceRecommendations}
          recommendationsLoading={hook.recommendationsLoading}
          fetchRecommendations={hook.fetchRecommendations}
          createOrder={hook.createOrder}
          creating={hook.creating}
          createError={hook.createError}
          onCancel={handleCancelNew}
        />
      )}
    </div>
  );
}
