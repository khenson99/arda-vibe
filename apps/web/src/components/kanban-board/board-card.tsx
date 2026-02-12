import * as React from "react";
import { useDraggable } from "@dnd-kit/core";
import { Truck, Factory, Package2, Clock, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KanbanCard, LoopType, CardStage } from "@/types";

/* ── Loop type visual config ────────────────────────────────── */

const LOOP_TYPE_CONFIG: Record<
  LoopType,
  { label: string; icon: typeof Truck; badgeClass: string }
> = {
  procurement: {
    label: "Procurement",
    icon: Truck,
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  production: {
    label: "Production",
    icon: Factory,
    badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  },
  transfer: {
    label: "Transfer",
    icon: Package2,
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  },
};

/* ── Age helpers ─────────────────────────────────────────────── */

function formatAge(isoTimestamp: string): string {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function ageHours(isoTimestamp: string): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60)),
  );
}

/* ── BoardCard component ────────────────────────────────────── */

interface BoardCardProps {
  card: KanbanCard;
  onClick: (card: KanbanCard) => void;
  onMoveNext: (card: KanbanCard) => Promise<void>;
  onMovePrevious: (card: KanbanCard) => Promise<void>;
  onCreateOrder: (card: KanbanCard) => Promise<void>;
  isDragOverlay?: boolean;
}

const TRANSITION_MATRIX: Record<CardStage, CardStage[]> = {
  created: ["triggered"],
  triggered: ["ordered"],
  ordered: ["in_transit", "received"],
  in_transit: ["received"],
  received: ["restocked"],
  restocked: ["triggered"],
};

function getNextStage(card: KanbanCard): CardStage | null {
  const options = TRANSITION_MATRIX[card.currentStage] ?? [];
  if (options.length === 0) return null;

  if (card.currentStage === "ordered") {
    if (card.loopType === "production") return "received";
    return "in_transit";
  }

  return options[0] ?? null;
}

function getPreviousStage(card: KanbanCard): CardStage | null {
  if (card.currentStage === "triggered") return "created";
  if (card.currentStage === "ordered") return "triggered";
  if (card.currentStage === "in_transit") return "ordered";
  if (card.currentStage === "received") return "in_transit";
  if (card.currentStage === "restocked") return "received";
  return null;
}

export const BoardCard = React.memo(function BoardCard({
  card,
  onClick,
  onMoveNext,
  onMovePrevious,
  onCreateOrder,
  isDragOverlay = false,
}: BoardCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    data: { card },
    disabled: isDragOverlay,
  });

  const style: React.CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  const loopConfig = card.loopType ? LOOP_TYPE_CONFIG[card.loopType] : null;
  const LoopIcon = loopConfig?.icon ?? Package2;
  const age = formatAge(card.currentStageEnteredAt);
  const isAging = ageHours(card.currentStageEnteredAt) >= 24;
  const nextStage = getNextStage(card);
  const previousStage = getPreviousStage(card);
  const canMoveNext =
    !!nextStage && (TRANSITION_MATRIX[card.currentStage] ?? []).includes(nextStage);
  const canMovePrevious =
    !!previousStage && (TRANSITION_MATRIX[card.currentStage] ?? []).includes(previousStage);
  const canCreateOrder = card.currentStage === "triggered" && card.loopType === "procurement";

  const blockDragFromButton = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  return (
    <div
      ref={!isDragOverlay ? setNodeRef : undefined}
      style={style}
      className={cn(
        "group relative cursor-grab rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-all",
        "hover:shadow-md active:cursor-grabbing",
        "min-h-[60px]",
        isAging && "border-amber-400 dark:border-amber-600",
        isDragging && "opacity-40",
        isDragOverlay && "rotate-2 shadow-xl ring-2 ring-primary/30",
        !isAging && "border-border",
      )}
      {...(!isDragOverlay ? attributes : {})}
      {...(!isDragOverlay ? listeners : {})}
    >
      {/* Grip handle indicator */}
      <div className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-40">
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
      </div>

      {/* Card content (clickable area) */}
      <button
        type="button"
        className="w-full text-left"
        onClick={(e) => {
          e.stopPropagation();
          onClick(card);
        }}
      >
        {/* Top row: card number + age */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-[hsl(var(--link))]">
            #{card.cardNumber}
          </span>
          <div className="flex items-center gap-1">
            <Clock className={cn("h-3 w-3", isAging ? "text-amber-500" : "text-muted-foreground")} />
            <span
              className={cn(
                "text-xs font-medium",
                isAging ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
              )}
            >
              {age}
            </span>
          </div>
        </div>

        {/* Part name */}
        <p className="mt-1 truncate text-xs text-card-foreground">
          {card.partName ?? `Part ${card.partId?.slice(0, 8) ?? "—"}...`}
        </p>

        {/* Loop type badge */}
        {loopConfig && (
          <div className="mt-1.5 flex items-center gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                loopConfig.badgeClass,
              )}
            >
              <LoopIcon className="h-3 w-3" />
              {loopConfig.label}
            </span>
          </div>
        )}
      </button>

      <div className="mt-2 flex flex-wrap gap-1">
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          onPointerDown={blockDragFromButton}
          onClick={(event) => {
            event.stopPropagation();
            onClick(card);
          }}
        >
          View
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={canMovePrevious ? "Move to previous stage" : "Previous stage is not allowed by lifecycle rules"}
          disabled={!canMovePrevious}
          onPointerDown={blockDragFromButton}
          onClick={(event) => {
            event.stopPropagation();
            void onMovePrevious(card);
          }}
        >
          Prev
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={canMoveNext ? "Move to next stage" : "Next stage is not allowed by lifecycle rules"}
          disabled={!canMoveNext}
          onPointerDown={blockDragFromButton}
          onClick={(event) => {
            event.stopPropagation();
            void onMoveNext(card);
          }}
        >
          Next
        </button>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          title={canCreateOrder ? "Create order" : "Create Order is available for triggered procurement cards only"}
          disabled={!canCreateOrder}
          onPointerDown={blockDragFromButton}
          onClick={(event) => {
            event.stopPropagation();
            void onCreateOrder(card);
          }}
        >
          Create Order
        </button>
      </div>
    </div>
  );
});
