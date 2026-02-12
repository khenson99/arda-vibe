import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { AuthSession, TOStatus, TransferOrder, TransferOrderLine } from "@/types";
import { isUnauthorized, parseApiError, fetchTransferOrder, fetchTransferOrderTransitions, updateTransferOrderStatus } from "@/lib/api-client";
import {
  Button,
  Card,
  CardContent,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Skeleton,
} from "@/components/ui";
import {
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  Package,
  TruckIcon,
  XCircle,
  MapPin,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TOShipModal } from "@/components/orders/to-ship-modal";
import { TOReceiveModal } from "@/components/orders/to-receive-modal";

/* ── Props ─────────────────────────────────────────────────── */

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

/* ── Status helpers ────────────────────────────────────────── */

const STATUS_BADGE: Record<TOStatus, { label: string; variant: "default" | "secondary" | "success" | "warning" | "accent" | "destructive" }> = {
  draft: { label: "Draft", variant: "secondary" },
  requested: { label: "Requested", variant: "accent" },
  approved: { label: "Approved", variant: "accent" },
  picking: { label: "Picking", variant: "warning" },
  shipped: { label: "Shipped", variant: "warning" },
  in_transit: { label: "In Transit", variant: "warning" },
  received: { label: "Received", variant: "success" },
  closed: { label: "Closed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ── Tab type ──────────────────────────────────────────────── */

type DetailTab = "overview" | "lines";

/* ── Skeleton ─────────────────────────────────────────────── */

function TODetailSkeleton() {
  return (
    <div className="space-y-4">
      <Card className="rounded-xl">
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-10 w-72" />
      <Card className="rounded-xl">
        <CardContent className="p-4 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Component ─────────────────────────────────────────────── */

export function TODetailRoute({ session, onUnauthorized }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = React.useState<DetailTab>("overview");

  const [to, setTo] = React.useState<TransferOrder | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [validTransitions, setValidTransitions] = React.useState<TOStatus[]>([]);
  const [transitioning, setTransitioning] = React.useState(false);

  const [shipModalOpen, setShipModalOpen] = React.useState(false);
  const [receiveModalOpen, setReceiveModalOpen] = React.useState(false);

  const isMountedRef = React.useRef(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadData = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [toRes, transRes] = await Promise.all([
        fetchTransferOrder(session.tokens.accessToken, id),
        fetchTransferOrderTransitions(session.tokens.accessToken, id),
      ]);
      if (!isMountedRef.current) return;
      setTo(toRes.data);
      setValidTransitions(transRes.data.validTransitions);
    } catch (err) {
      if (!isMountedRef.current) return;
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [id, session.tokens.accessToken, onUnauthorized]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const handleBack = React.useCallback(() => {
    navigate("/orders");
  }, [navigate]);

  const handleStatusChange = React.useCallback(
    async (status: TOStatus, reason?: string) => {
      if (!to) return;
      setTransitioning(true);
      try {
        const res = await updateTransferOrderStatus(session.tokens.accessToken, to.id, { status, reason });
        if (!isMountedRef.current) return;
        setTo(res.data);

        const transRes = await fetchTransferOrderTransitions(session.tokens.accessToken, to.id);
        if (isMountedRef.current) {
          setValidTransitions(transRes.data.validTransitions);
        }

        const label = STATUS_BADGE[status]?.label ?? status;
        toast.success(`Status updated to ${label}`);
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        toast.error(parseApiError(err));
      } finally {
        if (isMountedRef.current) setTransitioning(false);
      }
    },
    [to, session.tokens.accessToken, onUnauthorized],
  );

  const handleShipClick = React.useCallback(() => {
    setShipModalOpen(true);
  }, []);

  const handleReceiveClick = React.useCallback(() => {
    setReceiveModalOpen(true);
  }, []);

  const handleShipped = React.useCallback(() => {
    setShipModalOpen(false);
    loadData();
  }, [loadData]);

  const handleReceived = React.useCallback(() => {
    setReceiveModalOpen(false);
    loadData();
  }, [loadData]);

  /* Loading state */
  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <TODetailSkeleton />
      </div>
    );
  }

  /* Error state */
  if (error) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-400" />
            <p className="text-sm text-red-600 mb-3">{error}</p>
            <Button variant="outline" size="sm" onClick={loadData}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* No TO found */
  if (!to) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Transfer order not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  const badge = STATUS_BADGE[to.status] ?? { label: to.status, variant: "secondary" as const };
  const canEdit = to.status === "draft";
  const canShip = validTransitions.includes("shipped") || validTransitions.includes("in_transit");
  const canReceive = validTransitions.includes("received");

  return (
    <div className="space-y-4 p-4">
      {/* Back navigation */}
      <Button variant="ghost" size="sm" onClick={handleBack}>
        <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
      </Button>

      {/* Header card */}
      <Card className="rounded-xl">
        <CardContent className="p-4">
          {/* Title row */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h1 className="text-lg font-semibold">{to.toNumber}</h1>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>

          {/* Location info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 mb-1">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs font-semibold text-muted-foreground">Source</p>
              </div>
              <p className="text-sm font-semibold">{to.sourceFacilityName ?? to.sourceFacilityId}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 mb-1">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs font-semibold text-muted-foreground">Destination</p>
              </div>
              <p className="text-sm font-semibold">{to.destinationFacilityName ?? to.destinationFacilityId}</p>
            </div>
          </div>

          {/* Metric cards row */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <MetricCard label="Line Items" value={String(to.lines?.length ?? 0)} />
            <MetricCard
              label="Shipped"
              value={formatDate(to.shippedDate)}
              accent={to.shippedDate !== null}
            />
            <MetricCard
              label="Received"
              value={formatDate(to.receivedDate)}
              accent={to.receivedDate !== null}
            />
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm mb-4">
            <div className="name-value-pair">
              <span className="text-muted-foreground">Requested:</span>{" "}
              <span className="font-semibold">{formatDate(to.requestedDate)}</span>
            </div>
            <div className="name-value-pair">
              <span className="text-muted-foreground">Created:</span>{" "}
              <span className="font-semibold">{formatDateTime(to.createdAt)}</span>
            </div>
          </div>

          {/* Notes */}
          {to.notes && (
            <p className="text-sm text-muted-foreground mb-4">{to.notes}</p>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <Button size="sm" variant="outline" onClick={() => navigate(`/orders/to/${to.id}/edit`)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
              </Button>
            )}
            {canShip && (
              <Button size="sm" onClick={handleShipClick} disabled={transitioning}>
                <TruckIcon className="mr-1.5 h-3.5 w-3.5" /> Ship
              </Button>
            )}
            {canReceive && (
              <Button size="sm" onClick={handleReceiveClick} disabled={transitioning}>
                <Package className="mr-1.5 h-3.5 w-3.5" /> Receive
              </Button>
            )}
            {validTransitions.includes("cancelled") && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => handleStatusChange("cancelled", "Cancelled from TO detail page")}
                disabled={transitioning}
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" /> Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs>
        <TabsList>
          <TabsTrigger active={activeTab === "overview"} onClick={() => setActiveTab("overview")}>
            Overview
          </TabsTrigger>
          <TabsTrigger active={activeTab === "lines"} onClick={() => setActiveTab("lines")}>
            Line Items{to.lines?.length ? ` (${to.lines.length})` : ""}
          </TabsTrigger>
        </TabsList>

        {activeTab === "overview" && (
          <TabsContent>
            <OverviewTab to={to} />
          </TabsContent>
        )}

        {activeTab === "lines" && (
          <TabsContent>
            <LineItemsTab lines={to.lines ?? []} />
          </TabsContent>
        )}
      </Tabs>

      {/* Modals */}
      {to && (
        <>
          <TOShipModal
            open={shipModalOpen}
            onClose={() => setShipModalOpen(false)}
            transferOrder={to}
            token={session.tokens.accessToken}
            onShipped={handleShipped}
            onUnauthorized={onUnauthorized}
          />
          <TOReceiveModal
            open={receiveModalOpen}
            onClose={() => setReceiveModalOpen(false)}
            transferOrder={to}
            token={session.tokens.accessToken}
            onReceived={handleReceived}
            onUnauthorized={onUnauthorized}
          />
        </>
      )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────── */

function MetricCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center">
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className={cn(
        "text-sm font-semibold",
        accent && "text-[hsl(var(--arda-success))]",
      )}>{value}</p>
    </div>
  );
}

/* ── Overview Tab ──────────────────────────────────────────── */

function OverviewTab({ to }: { to: TransferOrder }) {
  return (
    <Card className="rounded-xl">
      <CardContent className="p-4 space-y-3 text-sm">
        <h3 className="font-semibold text-base">Details</h3>
        <div className="grid grid-cols-1 gap-y-2 gap-x-8 sm:grid-cols-2">
          <NameValue label="TO Number" value={to.toNumber} />
          <NameValue label="Status" value={STATUS_BADGE[to.status]?.label ?? to.status} />
          <NameValue label="Source Facility" value={to.sourceFacilityName ?? to.sourceFacilityId} />
          <NameValue label="Destination Facility" value={to.destinationFacilityName ?? to.destinationFacilityId} />
          <NameValue label="Requested" value={formatDateTime(to.requestedDate)} />
          <NameValue label="Shipped" value={formatDateTime(to.shippedDate)} />
          <NameValue label="Received" value={formatDateTime(to.receivedDate)} />
          <NameValue label="Created" value={formatDateTime(to.createdAt)} />
          <NameValue label="Updated" value={formatDateTime(to.updatedAt)} />
          {to.createdBy && <NameValue label="Created By" value={to.createdBy} />}
        </div>
      </CardContent>
    </Card>
  );
}

function NameValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="name-value-pair">
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className="font-semibold text-card-foreground">{value}</span>
    </div>
  );
}

/* ── Line Items Tab ────────────────────────────────────────── */

function LineItemsTab({ lines }: { lines: TransferOrderLine[] }) {
  if (lines.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No line items found for this transfer order.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Part</th>
                <th className="px-4 py-3 text-right font-semibold">Requested</th>
                <th className="px-4 py-3 text-right font-semibold">Shipped</th>
                <th className="px-4 py-3 text-right font-semibold">Received</th>
                <th className="px-4 py-3 text-left font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-t border-border hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <p className="font-semibold">{line.partName ?? line.partId}</p>
                  </td>
                  <td className="px-4 py-3 text-right">{line.quantityRequested.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    {line.quantityShipped > 0 ? (
                      <span className="font-semibold text-[hsl(var(--arda-success))]">
                        {line.quantityShipped.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {line.quantityReceived > 0 ? (
                      <span className="font-semibold text-[hsl(var(--arda-success))]">
                        {line.quantityReceived.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground italic">
                    {line.notes || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
