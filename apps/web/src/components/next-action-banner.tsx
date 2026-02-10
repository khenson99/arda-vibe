import * as React from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, Package } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { QueueSummary, QueueByLoop } from "@/types";

/* ── Action definition ─────────────────────────────────────────────── */

interface NextAction {
  id: string;
  icon: React.ElementType;
  message: string;
  linkTo: string;
  linkLabel: string;
  variant: "urgent" | "info";
}

/* ── Derive the most important action from queue data ───────────────── */

function deriveActions(
  queueSummary: QueueSummary | null,
  queueByLoop: QueueByLoop,
): NextAction[] {
  if (!queueSummary) return [];

  const actions: NextAction[] = [];

  // Count cards aging over 24 hours
  const agingCards = [
    ...queueByLoop.procurement,
    ...queueByLoop.production,
    ...queueByLoop.transfer,
  ].filter((card) => {
    const ageMs = Date.now() - new Date(card.currentStageEnteredAt).getTime();
    return ageMs >= 24 * 60 * 60 * 1000;
  });

  if (agingCards.length > 0) {
    actions.push({
      id: "aging-cards",
      icon: AlertTriangle,
      message: `${agingCards.length} card${agingCards.length > 1 ? "s" : ""} aging over 24h — create orders now`,
      linkTo: "/queue",
      linkLabel: "View Queue",
      variant: "urgent",
    });
  }

  // Cards awaiting orders
  if (queueSummary.totalAwaitingOrders > 0 && agingCards.length === 0) {
    actions.push({
      id: "awaiting-orders",
      icon: Package,
      message: `${queueSummary.totalAwaitingOrders} card${queueSummary.totalAwaitingOrders > 1 ? "s" : ""} awaiting orders`,
      linkTo: "/queue",
      linkLabel: "View Queue",
      variant: "info",
    });
  }

  return actions;
}

/* ── Component ─────────────────────────────────────────────────────── */

interface NextActionBannerProps {
  queueSummary: QueueSummary | null;
  queueByLoop: QueueByLoop;
}

/**
 * Prominent banner surfacing the single most important next action.
 * Renders nothing if there's no actionable item.
 */
export function NextActionBanner({ queueSummary, queueByLoop }: NextActionBannerProps) {
  const actions = React.useMemo(
    () => deriveActions(queueSummary, queueByLoop),
    [queueSummary, queueByLoop],
  );

  if (actions.length === 0) return null;

  // Show the highest priority action (first in the array)
  const action = actions[0];
  const Icon = action.icon;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl border-l-4 px-4 py-3",
        action.variant === "urgent" &&
          "border-primary bg-[hsl(var(--arda-orange)/0.08)] text-foreground",
        action.variant === "info" &&
          "border-[hsl(var(--link))] bg-[hsl(var(--arda-blue)/0.06)] text-foreground",
      )}
      role="status"
      aria-live="polite"
    >
      <Icon
        className={cn(
          "h-5 w-5 shrink-0",
          action.variant === "urgent" && "text-primary",
          action.variant === "info" && "text-[hsl(var(--link))]",
        )}
      />
      <p className="flex-1 text-sm font-medium">{action.message}</p>
      <Button
        asChild
        size="sm"
        variant={action.variant === "urgent" ? "default" : "accent"}
        className="gap-1.5"
      >
        <Link to={action.linkTo}>
          {action.linkLabel}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}
