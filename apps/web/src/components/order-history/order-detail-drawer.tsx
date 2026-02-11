import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
  Badge,
  Skeleton,
  Separator,
} from "@/components/ui";
import { OrderStatusBadge, OrderTypeBadge } from "./order-status-badge";
import { cn } from "@/lib/utils";
import type {
  PurchaseOrder,
  WorkOrder,
  TransferOrder,
  UnifiedOrder,
  POStatus,
  Receipt,
} from "@/types";
import { PO_STATUS_META } from "@/types";
import {
  Calendar,
  Clock,
  Hash,
  Building2,
  ChevronDown,
  Package,
  Truck,
  CheckCircle2,
  CircleDot,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { parseApiError } from "@/lib/api-client";

/* ── Helpers ─────────────────────────────────────────────────── */

function formatCurrency(amount: number | null, currency = "USD"): string {
  if (amount === null || amount === undefined) return "\u2014";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function formatDate(date: string | null): string {
  if (!date) return "\u2014";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(date: string | null): string {
  if (!date) return "\u2014";
  return new Date(date).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ── PO status transition map ────────────────────────────────── */

const PO_NEXT_STATUSES: Partial<Record<POStatus, POStatus[]>> = {
  draft: ["pending_approval", "approved", "cancelled"],
  pending_approval: ["approved", "cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["acknowledged", "partially_received", "received", "cancelled"],
  acknowledged: ["partially_received", "received", "cancelled"],
  partially_received: ["received", "cancelled"],
  received: ["closed"],
};

/* ── Props ───────────────────────────────────────────────────── */

interface OrderDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  order: UnifiedOrder | null;
  detail: PurchaseOrder | WorkOrder | TransferOrder | null;
  receipts: Receipt[];
  loading: boolean;
  onUpdateStatus: (poId: string, status: POStatus, notes?: string) => Promise<boolean>;
  statusUpdating: boolean;
}

/* ── PO lines table ──────────────────────────────────────────── */

function PurchaseOrderLines({ po }: { po: PurchaseOrder }) {
  if (!po.lines || po.lines.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">
        No line items on this order.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted">
            <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Part</th>
            <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Ordered</th>
            <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Received</th>
            <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Unit Price</th>
            <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Line Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {po.lines.map((line) => (
            <tr key={line.id} className="hover:bg-muted/50">
              <td className="px-3 py-2 font-medium">{line.partName ?? line.partId}</td>
              <td className="px-3 py-2 text-right tabular-nums">{line.quantityOrdered}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                <span
                  className={cn(
                    line.quantityReceived >= line.quantityOrdered
                      ? "text-[hsl(var(--arda-success))]"
                      : line.quantityReceived > 0
                        ? "text-[hsl(var(--arda-warning))]"
                        : "text-muted-foreground",
                  )}
                >
                  {line.quantityReceived}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatCurrency(line.unitPrice, line.currency)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-medium">
                {line.unitPrice !== null
                  ? formatCurrency(line.unitPrice * line.quantityOrdered, line.currency)
                  : "\u2014"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Transfer Order lines table ──────────────────────────────── */

function TransferOrderLines({ to }: { to: TransferOrder }) {
  if (!to.lines || to.lines.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">
        No line items on this transfer.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted">
            <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Part</th>
            <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Ordered</th>
            <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Received</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {to.lines.map((line) => (
            <tr key={line.id} className="hover:bg-muted/50">
              <td className="px-3 py-2 font-medium">{line.partName ?? line.partId}</td>
              <td className="px-3 py-2 text-right tabular-nums">{line.quantityRequested}</td>
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
  );
}

/* ── Receipts list ───────────────────────────────────────────── */

function ReceiptsList({ receipts }: { receipts: Receipt[] }) {
  if (receipts.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Receipts
      </h4>
      <div className="space-y-2">
        {receipts.map((receipt) => (
          <div
            key={receipt.id}
            className="rounded-lg border border-border px-3 py-2 text-xs space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">Receipt #{receipt.id.slice(0, 8)}</span>
              <Badge
                variant={
                  receipt.status === "completed"
                    ? "success"
                    : receipt.status === "rejected"
                      ? "destructive"
                      : "secondary"
                }
                className="text-[10px]"
              >
                {receipt.status}
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <span>Received: {formatDateTime(receipt.receivedAt)}</span>
              {receipt.receivedBy && <span>By: {receipt.receivedBy}</span>}
            </div>
            {receipt.notes && (
              <p className="text-muted-foreground">{receipt.notes}</p>
            )}
            {receipt.lines && receipt.lines.length > 0 && (
              <div className="mt-1 pl-2 border-l-2 border-border space-y-0.5">
                {receipt.lines.map((line) => (
                  <div key={line.id} className="flex items-center gap-2">
                    <span>{line.partName ?? line.partId}</span>
                    <span className="text-[hsl(var(--arda-success))]">+{line.quantityAccepted}</span>
                    {line.quantityDamaged > 0 && (
                      <span className="text-[hsl(var(--arda-warning))]">dmg: {line.quantityDamaged}</span>
                    )}
                    {line.quantityRejected > 0 && (
                      <span className="text-destructive">rej: {line.quantityRejected}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Status timeline ─────────────────────────────────────────── */

function StatusTimeline({ order, detail }: { order: UnifiedOrder; detail: PurchaseOrder | WorkOrder | TransferOrder | null }) {
  if (!detail) return null;

  type TimelineItem = { label: string; date: string | null; active: boolean; completed: boolean };
  const items: TimelineItem[] = [];

  if (order.type === "purchase") {
    const po = detail as PurchaseOrder;
    const statusOrder: POStatus[] = [
      "draft", "pending_approval", "approved", "sent", "acknowledged",
      "partially_received", "received", "closed",
    ];
    const currentIdx = statusOrder.indexOf(po.status as POStatus);

    items.push({ label: "Created", date: po.createdAt, active: false, completed: true });
    if (po.orderedAt) {
      items.push({ label: "Ordered", date: po.orderedAt, active: false, completed: true });
    }
    if (currentIdx >= 3) {
      items.push({ label: "Sent", date: po.updatedAt, active: po.status === "sent", completed: currentIdx > 3 });
    }
    if (po.status === "partially_received" || po.status === "received" || po.status === "closed") {
      items.push({
        label: po.status === "partially_received" ? "Partially Received" : "Received",
        date: po.updatedAt,
        active: po.status === "partially_received" || po.status === "received",
        completed: po.status === "closed",
      });
    }
    if (po.status === "closed") {
      items.push({ label: "Closed", date: po.updatedAt, active: true, completed: true });
    }
    if (po.status === "cancelled") {
      items.push({ label: "Cancelled", date: po.updatedAt, active: true, completed: false });
    }
  } else if (order.type === "work") {
    const wo = detail as WorkOrder;
    items.push({ label: "Created", date: wo.createdAt, active: false, completed: true });
    if (wo.scheduledDate) {
      items.push({ label: "Scheduled", date: wo.scheduledDate, active: wo.status === "scheduled", completed: wo.status !== "draft" && wo.status !== "scheduled" });
    }
    if (wo.status === "in_progress" || wo.status === "completed") {
      items.push({ label: "In Progress", date: wo.updatedAt, active: wo.status === "in_progress", completed: wo.status === "completed" });
    }
    if (wo.completedAt) {
      items.push({ label: "Completed", date: wo.completedAt, active: true, completed: true });
    }
  } else {
    const to = detail as TransferOrder;
    items.push({ label: "Created", date: to.createdAt, active: false, completed: true });
    if (to.status !== "draft") {
      items.push({ label: "Approved", date: to.updatedAt, active: to.status === "approved", completed: to.status !== "approved" });
    }
    if (to.shippedDate) {
      items.push({ label: "Shipped", date: to.shippedDate, active: to.status === "in_transit", completed: to.status === "received" });
    }
    if (to.receivedDate) {
      items.push({ label: "Received", date: to.receivedDate, active: true, completed: true });
    }
  }

  if (items.length <= 1) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Timeline
      </h4>
      <div className="space-y-0">
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-3 pb-3 last:pb-0">
            <div className="flex flex-col items-center">
              {item.completed ? (
                <CheckCircle2 className="h-4 w-4 text-[hsl(var(--arda-success))] shrink-0" />
              ) : item.active ? (
                <CircleDot className="h-4 w-4 text-[hsl(var(--link))] shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 text-muted-foreground/40 shrink-0" />
              )}
              {i < items.length - 1 && (
                <div className="w-px h-4 bg-border mt-0.5" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className={cn(
                "text-xs font-medium leading-4",
                item.active ? "text-foreground" : "text-muted-foreground",
              )}>
                {item.label}
              </p>
              {item.date && (
                <p className="text-[10px] text-muted-foreground">
                  {formatDateTime(item.date)}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Status update dropdown ──────────────────────────────────── */

function StatusUpdateActions({
  po,
  onUpdate,
  updating,
}: {
  po: PurchaseOrder;
  onUpdate: (status: POStatus) => void;
  updating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const nextStatuses = PO_NEXT_STATUSES[po.status as POStatus];

  if (!nextStatuses || nextStatuses.length === 0) return null;

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        disabled={updating}
        className="text-xs gap-1"
      >
        {updating ? "Updating..." : "Update Status"}
        <ChevronDown className="h-3 w-3" />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded-md border border-border bg-background shadow-sm py-1">
            {nextStatuses.map((status) => {
              const meta = PO_STATUS_META[status];
              return (
                <button
                  key={status}
                  onClick={() => {
                    setOpen(false);
                    onUpdate(status);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Main Drawer ─────────────────────────────────────────────── */

export function OrderDetailDrawer({
  open,
  onClose,
  order,
  detail,
  receipts,
  loading,
  onUpdateStatus,
  statusUpdating,
}: OrderDetailDrawerProps) {
  if (!order) return null;

  async function handleStatusUpdate(status: POStatus) {
    try {
      await onUpdateStatus(order!.id, status);
      toast.success(`Status updated to ${PO_STATUS_META[status].label}`);
    } catch (err) {
      toast.error(parseApiError(err));
    }
  }

  const isPO = order.type === "purchase" && detail && "poNumber" in detail;
  const isWO = order.type === "work" && detail && "woNumber" in detail;
  const isTO = order.type === "transfer" && detail && "toNumber" in detail;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base">
                {order.orderNumber}
              </DialogTitle>
              <OrderTypeBadge type={order.type} />
            </div>
            {isPO && (
              <StatusUpdateActions
                po={detail as PurchaseOrder}
                onUpdate={handleStatusUpdate}
                updating={statusUpdating}
              />
            )}
          </div>
          <DialogDescription className="sr-only">
            Details for order {order.orderNumber}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-4 py-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-5 pt-2">
            {/* Header info grid */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Status:</span>
                <OrderStatusBadge status={order.status} type={order.type} />
              </div>

              {order.sourceName && (
                <div className="flex items-center gap-2">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Source:</span>
                  <span className="font-medium truncate">{order.sourceName}</span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Created:</span>
                <span className="font-medium">{formatDate(order.createdAt)}</span>
              </div>

              {order.expectedDate && (
                <div className="flex items-center gap-2">
                  <Truck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Expected:</span>
                  <span className="font-medium">{formatDate(order.expectedDate)}</span>
                </div>
              )}

              {order.totalAmount !== null && (
                <div className="flex items-center gap-2">
                  <Package className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Total:</span>
                  <span className="font-semibold">
                    {formatCurrency(order.totalAmount, order.currency)}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Updated:</span>
                <span className="font-medium">{formatDateTime(order.updatedAt)}</span>
              </div>
            </div>

            {/* Notes */}
            {detail && "notes" in detail && detail.notes && (
              <>
                <Separator />
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                    Notes
                  </h4>
                  <p className="text-sm text-foreground">{detail.notes}</p>
                </div>
              </>
            )}

            {/* Work Order specifics */}
            {isWO && (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground text-xs">Qty Ordered</span>
                    <p className="font-semibold">{(detail as WorkOrder).quantityOrdered}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Qty Completed</span>
                    <p className="font-semibold">{(detail as WorkOrder).quantityCompleted}</p>
                  </div>
                </div>
              </>
            )}

            {/* Line items */}
            {isPO && (
              <>
                <Separator />
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Line Items ({(detail as PurchaseOrder).lines?.length ?? 0})
                  </h4>
                  <PurchaseOrderLines po={detail as PurchaseOrder} />
                </div>
              </>
            )}

            {isTO && (detail as TransferOrder).lines && (detail as TransferOrder).lines!.length > 0 && (
              <>
                <Separator />
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Line Items ({(detail as TransferOrder).lines!.length})
                  </h4>
                  <TransferOrderLines to={detail as TransferOrder} />
                </div>
              </>
            )}

            {/* Receipts */}
            {receipts.length > 0 && (
              <>
                <Separator />
                <ReceiptsList receipts={receipts} />
              </>
            )}

            {/* Timeline */}
            <Separator />
            <StatusTimeline order={order} detail={detail} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
