import * as React from "react";
import type { PurchaseOrder, POStatus } from "@/types";
import { PO_STATUS_META } from "@/types";
import { OrderStatusBadge } from "@/components/order-history/order-status-badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
} from "@/components/ui";
import {
  Printer,
  Pencil,
  Send,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ── Valid status transitions ──────────────────────────────── */

const VALID_TRANSITIONS: Partial<Record<POStatus, POStatus[]>> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "cancelled", "draft"],
  approved: ["sent", "cancelled"],
  sent: ["acknowledged", "partially_received", "cancelled"],
  acknowledged: ["partially_received", "cancelled"],
  partially_received: ["received", "cancelled"],
  received: ["closed", "cancelled"],
};

/* ── Helpers ───────────────────────────────────────────────── */

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatCurrency(
  amount: number | string | null | undefined,
  currency = "USD",
): string {
  if (amount === null || amount === undefined) return "—";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    num,
  );
}

/* ── Props ─────────────────────────────────────────────────── */

interface POHeaderProps {
  po: PurchaseOrder;
  onEdit?: () => void;
  onPrint?: () => void;
  onStatusChange: (status: POStatus) => void;
  statusUpdating: boolean;
}

/* ── Status actions dropdown ───────────────────────────────── */

function StatusActionsDropdown({
  po,
  onStatusChange,
  statusUpdating,
}: {
  po: PurchaseOrder;
  onStatusChange: (status: POStatus) => void;
  statusUpdating: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const nextStatuses = VALID_TRANSITIONS[po.status];

  if (!nextStatuses || nextStatuses.length === 0) return null;

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        disabled={statusUpdating}
        className="text-xs gap-1"
      >
        {statusUpdating ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : null}
        {statusUpdating ? "Updating…" : "Update Status"}
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
                    onStatusChange(status);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors",
                    status === "cancelled" && "text-red-600",
                  )}
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

/* ── Component ─────────────────────────────────────────────── */

export function POHeader({
  po,
  onEdit,
  onPrint,
  onStatusChange,
  statusUpdating,
}: POHeaderProps) {
  const canEdit = po.status === "draft" || po.status === "pending_approval";

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base">{po.poNumber}</CardTitle>
            <OrderStatusBadge status={po.status} type="purchase" />
          </div>
          <div className="flex items-center gap-2">
            {canEdit && onEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={onEdit}
                className="text-xs"
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            )}
            {po.status === "draft" && (
              <Button
                size="sm"
                onClick={() => onStatusChange("pending_approval")}
                disabled={statusUpdating}
                className="text-xs"
              >
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Submit for Approval
              </Button>
            )}
            {onPrint && (
              <Button
                variant="outline"
                size="sm"
                onClick={onPrint}
                className="text-xs"
              >
                <Printer className="mr-1.5 h-3.5 w-3.5" />
                Print
              </Button>
            )}
            <StatusActionsDropdown
              po={po}
              onStatusChange={onStatusChange}
              statusUpdating={statusUpdating}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Supplier:</span>{" "}
            <span className="font-semibold">
              {po.supplierName ?? "—"}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Total:</span>{" "}
            <span className="font-semibold">
              {formatCurrency(po.totalAmount, po.currency)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Currency:</span>{" "}
            <span className="font-semibold">{po.currency}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Created:</span>{" "}
            <span className="font-semibold">{formatDate(po.createdAt)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Ordered:</span>{" "}
            <span className="font-semibold">{formatDate(po.orderedAt)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Expected Delivery:</span>{" "}
            <span className="font-semibold">
              {formatDate(po.expectedDeliveryDate)}
            </span>
          </div>
          {po.paymentTerms && (
            <div>
              <span className="text-muted-foreground">Payment Terms:</span>{" "}
              <span className="font-semibold">{po.paymentTerms}</span>
            </div>
          )}
          {po.shippingTerms && (
            <div>
              <span className="text-muted-foreground">Shipping Terms:</span>{" "}
              <span className="font-semibold">{po.shippingTerms}</span>
            </div>
          )}
          {po.sentToEmail && (
            <div>
              <span className="text-muted-foreground">Sent To:</span>{" "}
              <span className="font-semibold">{po.sentToEmail}</span>
            </div>
          )}
        </div>
        {po.notes && (
          <div className="mt-3 text-sm">
            <span className="text-muted-foreground">Notes:</span>{" "}
            <span>{po.notes}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function POHeaderSkeleton() {
  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-8 w-24" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-40" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
