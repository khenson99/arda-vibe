import { Badge } from "@/components/ui";
import { PO_STATUS_META } from "@/types";
import type { POStatus, WOStatus, TOStatus, OrderType } from "@/types";
import { cn } from "@/lib/utils";

/* ── Work Order status meta ─────────────────────────────────── */

const WO_STATUS_META: Record<WOStatus, { label: string; colorClass: string }> = {
  draft: { label: "Draft", colorClass: "bg-muted text-muted-foreground border-border" },
  scheduled: { label: "Scheduled", colorClass: "bg-accent/10 text-[hsl(var(--accent))] border-accent/20" },
  in_progress: { label: "In Progress", colorClass: "bg-accent/10 text-[hsl(var(--accent))] border-accent/20" },
  completed: { label: "Completed", colorClass: "bg-[hsl(var(--arda-success-light))] text-[hsl(var(--arda-success))] border-[hsl(var(--arda-success))]/20" },
  cancelled: { label: "Cancelled", colorClass: "bg-destructive/10 text-destructive border-destructive/20" },
};

/* ── Transfer Order status meta ─────────────────────────────── */

const TO_STATUS_META: Record<TOStatus, { label: string; colorClass: string }> = {
  draft: { label: "Draft", colorClass: "bg-muted text-muted-foreground border-border" },
  requested: { label: "Requested", colorClass: "bg-[hsl(var(--arda-warning-light))] text-[hsl(var(--arda-warning))] border-[hsl(var(--arda-warning))]/20" },
  approved: { label: "Approved", colorClass: "bg-[hsl(var(--arda-success-light))] text-[hsl(var(--arda-success))] border-[hsl(var(--arda-success))]/20" },
  picking: { label: "Picking", colorClass: "bg-secondary text-secondary-foreground border-border" },
  shipped: { label: "Shipped", colorClass: "bg-accent/10 text-[hsl(var(--accent))] border-accent/20" },
  in_transit: { label: "In Transit", colorClass: "bg-accent/10 text-[hsl(var(--accent))] border-accent/20" },
  received: { label: "Received", colorClass: "bg-[hsl(var(--arda-success-light))] text-[hsl(var(--arda-success))] border-[hsl(var(--arda-success))]/20" },
  closed: { label: "Closed", colorClass: "bg-muted text-muted-foreground border-border" },
  cancelled: { label: "Cancelled", colorClass: "bg-destructive/10 text-destructive border-destructive/20" },
};

/* ── PO status → tailwind color ─────────────────────────────── */

const PO_STATUS_COLORS: Record<POStatus, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  pending_approval: "bg-[hsl(var(--arda-warning-light))] text-[hsl(var(--arda-warning))] border-[hsl(var(--arda-warning))]/20",
  approved: "bg-[hsl(var(--arda-success-light))] text-[hsl(var(--arda-success))] border-[hsl(var(--arda-success))]/20",
  sent: "bg-accent/10 text-[hsl(var(--accent))] border-accent/20",
  acknowledged: "bg-accent/10 text-[hsl(var(--accent))] border-accent/20",
  partially_received: "bg-[hsl(var(--arda-warning-light))] text-[hsl(var(--arda-warning))] border-[hsl(var(--arda-warning))]/20",
  received: "bg-[hsl(var(--arda-success-light))] text-[hsl(var(--arda-success))] border-[hsl(var(--arda-success))]/20",
  closed: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-destructive/10 text-destructive border-destructive/20",
};

/* ── Component ──────────────────────────────────────────────── */

interface OrderStatusBadgeProps {
  status: string;
  type: OrderType;
  className?: string;
}

export function OrderStatusBadge({ status, type, className }: OrderStatusBadgeProps) {
  let label: string;
  let colorClass: string;

  if (type === "purchase") {
    const meta = PO_STATUS_META[status as POStatus];
    label = meta?.label ?? status;
    colorClass = PO_STATUS_COLORS[status as POStatus] ?? "bg-muted text-muted-foreground border-border";
  } else if (type === "work") {
    const meta = WO_STATUS_META[status as WOStatus];
    label = meta?.label ?? status;
    colorClass = meta?.colorClass ?? "bg-muted text-muted-foreground border-border";
  } else {
    const meta = TO_STATUS_META[status as TOStatus];
    label = meta?.label ?? status;
    colorClass = meta?.colorClass ?? "bg-muted text-muted-foreground border-border";
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        "border font-medium text-xs",
        colorClass,
        className,
      )}
    >
      {label}
    </Badge>
  );
}

/* ── Order type badge ───────────────────────────────────────── */

const ORDER_TYPE_META: Record<OrderType, { label: string; colorClass: string }> = {
  purchase: { label: "Purchase", colorClass: "bg-accent/10 text-[hsl(var(--accent))] border-accent/20" },
  work: { label: "Work", colorClass: "bg-secondary text-secondary-foreground border-border" },
  transfer: { label: "Transfer", colorClass: "bg-[hsl(var(--arda-warning-light))] text-[hsl(var(--arda-warning))] border-[hsl(var(--arda-warning))]/20" },
};

interface OrderTypeBadgeProps {
  type: OrderType;
  className?: string;
}

export function OrderTypeBadge({ type, className }: OrderTypeBadgeProps) {
  const meta = ORDER_TYPE_META[type];

  return (
    <Badge
      variant="outline"
      className={cn(
        "border font-medium text-xs",
        meta.colorClass,
        className,
      )}
    >
      {meta.label}
    </Badge>
  );
}
