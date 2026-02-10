import * as React from "react";
import {
  Clock,
  Zap,
  BarChart3,
  RotateCw,
  Pencil,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Skeleton } from "@/components/ui";
import type { KanbanCard, LoopCardSummary, LoopVelocity } from "@/types";
import { CARD_STAGE_META, CARD_STAGES } from "@/types";
import type { ExpandedLoopDetail } from "@/hooks/use-kanban-loops";
import { LoopParameterForm } from "./loop-parameter-form";

/* ── Velocity metrics display ───────────────────────────────── */

function VelocityMetrics({ velocity }: { velocity: LoopVelocity | null }) {
  if (!velocity) {
    return <p className="text-xs text-muted-foreground italic">Velocity data unavailable.</p>;
  }

  const metrics = [
    {
      icon: Clock,
      label: "Avg Cycle Time",
      value: velocity.avgCycleTimeHours != null
        ? `${velocity.avgCycleTimeHours.toFixed(1)}h`
        : "--",
    },
    {
      icon: Zap,
      label: "Avg Lead Time",
      value: velocity.avgLeadTimeHours != null
        ? `${velocity.avgLeadTimeHours.toFixed(1)}h`
        : "--",
    },
    {
      icon: BarChart3,
      label: "Throughput / Day",
      value: velocity.throughputPerDay != null
        ? velocity.throughputPerDay.toFixed(2)
        : "--",
    },
    {
      icon: RotateCw,
      label: "Cycles (30d)",
      value: String(velocity.completedCyclesLast30d),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {metrics.map((m) => (
        <div
          key={m.label}
          className="rounded-lg border border-border bg-muted/30 px-3 py-2"
        >
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <m.icon className="h-3 w-3" />
            {m.label}
          </div>
          <div className="mt-0.5 text-sm font-semibold">{m.value}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Card stages summary table ──────────────────────────────── */

function CardStagesTable({ summary }: { summary: LoopCardSummary | null }) {
  if (!summary || summary.totalCards === 0) {
    return <p className="text-xs text-muted-foreground italic">No cards in this loop.</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {CARD_STAGES.map((stage) => {
        const count = summary.byStage[stage] ?? 0;
        return (
          <div
            key={stage}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
              CARD_STAGE_META[stage].bgClass,
              CARD_STAGE_META[stage].textClass,
            )}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: CARD_STAGE_META[stage].color }}
            />
            {CARD_STAGE_META[stage].label}
            <span className="font-semibold">{count}</span>
          </div>
        );
      })}
      <div className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
        Total <span className="font-semibold">{summary.totalCards}</span>
      </div>
    </div>
  );
}

/* ── Cards list ─────────────────────────────────────────────── */

function CardsList({ cards }: { cards: KanbanCard[] }) {
  if (cards.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No cards found.</p>;
  }

  return (
    <div className="max-h-48 overflow-y-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted sticky top-0">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">#</th>
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Stage</th>
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Cycles</th>
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Stage Since</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => {
            const stageMeta = CARD_STAGE_META[card.currentStage] ?? CARD_STAGE_META.created;
            const stageDate = new Date(card.currentStageEnteredAt);
            const stageAgo = formatRelativeTime(stageDate);

            return (
              <tr key={card.id} className="border-t border-border hover:bg-muted/30">
                <td className="px-2 py-1.5 font-mono">{card.cardNumber}</td>
                <td className="px-2 py-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
                      stageMeta.bgClass,
                      stageMeta.textClass,
                    )}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: stageMeta.color }}
                    />
                    {stageMeta.label}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-muted-foreground">{card.completedCycles}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{stageAgo}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Parameter history ──────────────────────────────────────── */

function ParameterHistory({
  history,
}: {
  history?: Array<{
    parameter: string;
    oldValue: string;
    newValue: string;
    changedAt: string;
  }>;
}) {
  if (!history || history.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No parameter changes recorded.</p>;
  }

  return (
    <div className="max-h-36 overflow-y-auto space-y-1.5">
      {history.map((entry, idx) => {
        const date = new Date(entry.changedAt);
        return (
          <div
            key={idx}
            className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs"
          >
            <History className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="font-medium">{entry.parameter}</span>
            <span className="text-muted-foreground">
              {entry.oldValue} &rarr; {entry.newValue}
            </span>
            <span className="ml-auto text-muted-foreground whitespace-nowrap">
              {date.toLocaleDateString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Main component ─────────────────────────────────────────── */

interface LoopDetailPanelProps {
  detail: ExpandedLoopDetail | null;
  isLoading: boolean;
  token: string;
  onUnauthorized: () => void;
  onParametersSaved: () => void;
}

export function LoopDetailPanel({
  detail,
  isLoading,
  token,
  onUnauthorized,
  onParametersSaved,
}: LoopDetailPanelProps) {
  const [isEditing, setIsEditing] = React.useState(false);

  // Reset editing state when detail changes
  React.useEffect(() => {
    setIsEditing(false);
  }, [detail?.loop.id]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="p-4 text-xs text-muted-foreground italic">
        Unable to load loop details.
      </div>
    );
  }

  const { loop, cardSummary, velocity } = detail;

  return (
    <div className="space-y-4 p-4">
      {/* Section: Card stages */}
      <section>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Card Distribution
        </h4>
        <CardStagesTable summary={cardSummary} />
      </section>

      {/* Section: Cards list */}
      {loop.cards && loop.cards.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Cards ({loop.cards.length})
          </h4>
          <CardsList cards={loop.cards} />
        </section>
      )}

      {/* Section: Velocity */}
      <section>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Velocity Metrics
        </h4>
        <VelocityMetrics velocity={velocity} />
      </section>

      {/* Section: Parameters */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Parameters
          </h4>
          {!isEditing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs gap-1"
              onClick={() => setIsEditing(true)}
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
          )}
        </div>

        {isEditing ? (
          <LoopParameterForm
            loop={loop}
            token={token}
            onUnauthorized={onUnauthorized}
            onSaved={() => {
              setIsEditing(false);
              onParametersSaved();
            }}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <ParamDisplay label="Min Quantity" value={loop.minQuantity} />
            <ParamDisplay label="Order Quantity" value={loop.orderQuantity} />
            <ParamDisplay label="Number of Cards" value={loop.numberOfCards} />
            <ParamDisplay label="Lead Time" value={loop.statedLeadTimeDays != null ? `${loop.statedLeadTimeDays}d` : "--"} />
            <ParamDisplay label="Safety Stock" value={loop.safetyStockDays != null ? `${loop.safetyStockDays}d` : "--"} />
            <ParamDisplay label="Reorder Point" value={loop.reorderPoint ?? "--"} />
          </div>
        )}
      </section>

      {/* Section: Parameter history */}
      <section>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Parameter History
        </h4>
        <ParameterHistory history={loop.parameterHistory} />
      </section>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */

function ParamDisplay({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-semibold text-card-foreground">{value ?? "--"}</div>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
