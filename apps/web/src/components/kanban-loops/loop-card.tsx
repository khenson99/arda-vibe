import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui";
import type { KanbanLoop, LoopCardSummary } from "@/types";
import { LOOP_META, CARD_STAGES, CARD_STAGE_META } from "@/types";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui";

/* ── Loop type → badge variant mapping ──────────────────────── */

const LOOP_TYPE_VARIANT: Record<string, "default" | "accent" | "warning" | "secondary"> = {
  procurement: "accent",
  production: "warning",
  transfer: "secondary",
};

const STATUS_VARIANT: Record<string, "success" | "warning" | "secondary" | "destructive"> = {
  active: "success",
  paused: "warning",
  draft: "secondary",
  archived: "destructive",
};

/* ── Stage dot sparkline ────────────────────────────────────── */

function StageDistribution({ summary }: { summary?: LoopCardSummary | null }) {
  if (!summary || summary.totalCards === 0) {
    return <span className="text-xs text-muted-foreground">No cards</span>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-0.5">
        {CARD_STAGES.map((stage) => {
          const count = summary.byStage?.[stage] ?? 0;
          if (count === 0) return null;

          return Array.from({ length: count }).map((_, i) => (
            <Tooltip key={`${stage}-${i}`}>
              <TooltipTrigger asChild>
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: CARD_STAGE_META[stage].color }}
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {CARD_STAGE_META[stage].label}: {count}
              </TooltipContent>
            </Tooltip>
          ));
        })}
      </div>
    </TooltipProvider>
  );
}

/* ── Main component ─────────────────────────────────────────── */

interface LoopCardProps {
  loop: KanbanLoop;
  cardSummary?: LoopCardSummary | null;
  isExpanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}

export function LoopCard({ loop, cardSummary, isExpanded, onToggle, children }: LoopCardProps) {
  const meta = LOOP_META[loop.loopType];
  const Icon = meta?.icon;

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card shadow-sm transition-shadow",
        isExpanded && "ring-1 ring-[hsl(var(--link))] shadow-md",
      )}
    >
      {/* Clickable header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors rounded-t-xl"
      >
        {/* Expand chevron */}
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Row 1: Name + badges */}
          <div className="flex items-center gap-2 flex-wrap">
            {Icon && <Icon className="h-4 w-4 text-muted-foreground shrink-0" />}
            <span className="text-sm font-semibold truncate">
              {loop.partName || loop.partId}
            </span>
            <Badge variant={LOOP_TYPE_VARIANT[loop.loopType] ?? "secondary"} className="text-[10px] px-1.5 py-0">
              {meta?.label ?? loop.loopType}
            </Badge>
            <Badge variant={STATUS_VARIANT[loop.status] ?? "secondary"} className="text-[10px] px-1.5 py-0">
              {loop.status}
            </Badge>
            {loop.cardMode && (
              <span className="text-xs text-muted-foreground">
                {loop.cardMode}
              </span>
            )}
          </div>

          {/* Row 2: Stage distribution + key params */}
          <div className="mt-2 flex items-center gap-4 flex-wrap">
            <StageDistribution summary={cardSummary} />

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                Min: <span className="font-semibold text-card-foreground">{loop.minQuantity}</span>
              </span>
              <span>
                Order: <span className="font-semibold text-card-foreground">{loop.orderQuantity}</span>
              </span>
              <span>
                Cards: <span className="font-semibold text-card-foreground">{loop.numberOfCards}</span>
              </span>
              {loop.statedLeadTimeDays != null && (
                <span>
                  Lead: <span className="font-semibold text-card-foreground">{loop.statedLeadTimeDays}d</span>
                </span>
              )}
            </div>
          </div>

          {/* Row 3: Facility */}
          {loop.facilityName && (
            <div className="mt-1 text-xs text-muted-foreground">
              Facility: {loop.facilityName}
            </div>
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {isExpanded && children && (
        <div className="border-t border-border">{children}</div>
      )}
    </div>
  );
}
