import * as React from "react";
import {
  Printer,
  ChevronRight,
  ArrowRight,
  MoreHorizontal,
  Loader2,
} from "lucide-react";
import type { KanbanCard, CardStage } from "@/types";
import { CARD_STAGES, CARD_STAGE_META, LOOP_META } from "@/types";
import type { LoopType } from "@/types";
import { cn } from "@/lib/utils";
import { Button, Badge, Skeleton } from "@/components/ui";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui";
import {
  isUnauthorized,
  parseApiError,
  transitionCard,
  createPrintJob,
} from "@/lib/api-client";
import { toast } from "sonner";

/* ── Helpers ─────────────────────────────────────────────────── */

function formatTimeInStage(enteredAt: string): string {
  const ms = Date.now() - new Date(enteredAt).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60000))}m`;
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Return the next valid stage or null if at the end. */
function getNextStage(current: CardStage): CardStage | null {
  const idx = CARD_STAGES.indexOf(current);
  if (idx < 0 || idx >= CARD_STAGES.length - 1) return null;
  return CARD_STAGES[idx + 1];
}

/** Loop type badge colors (without relying on meta color). */
const LOOP_TYPE_CLASSES: Record<LoopType, { bg: string; text: string }> = {
  procurement: { bg: "bg-blue-50", text: "text-blue-700" },
  production: { bg: "bg-violet-50", text: "text-violet-700" },
  transfer: { bg: "bg-amber-50", text: "text-amber-700" },
};

/* ── Props ───────────────────────────────────────────────────── */

interface CardsTableProps {
  cards: KanbanCard[];
  isLoading: boolean;
  token: string;
  onUnauthorized: () => void;
  onRefresh: () => Promise<void>;
  onCardClick?: (card: KanbanCard) => void;
}

/* ── Component ───────────────────────────────────────────────── */

export function CardsTable({
  cards,
  isLoading,
  token,
  onUnauthorized,
  onRefresh,
  onCardClick,
}: CardsTableProps) {
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  /* ── Transition handler ─────────────────────────────────────── */

  const handleTransition = React.useCallback(
    async (card: KanbanCard, toStage: CardStage) => {
      setActionLoading(card.id);
      try {
        await transitionCard(token, card.id, { toStage, method: "manual" });
        toast.success(
          `Card #${card.cardNumber} moved to ${CARD_STAGE_META[toStage].label}`,
        );
        await onRefresh();
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        toast.error(parseApiError(err));
      } finally {
        setActionLoading(null);
      }
    },
    [token, onUnauthorized, onRefresh],
  );

  /* ── Print handler ──────────────────────────────────────────── */

  const handlePrint = React.useCallback(
    async (card: KanbanCard) => {
      setActionLoading(card.id);
      try {
        await createPrintJob(token, { cardIds: [card.id] });
        toast.success(`Print job created for card #${card.cardNumber}`);
        await onRefresh();
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        toast.error(parseApiError(err));
      } finally {
        setActionLoading(null);
      }
    },
    [token, onUnauthorized, onRefresh],
  );

  /* ── Loading skeleton ───────────────────────────────────────── */

  if (isLoading) {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted">
              {["Card #", "Part Name", "Loop Type", "Stage", "Time in Stage", "Cycles", "Last Printed", "Actions"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-t border-border">
                {Array.from({ length: 8 }).map((_, j) => (
                  <td key={j} className="px-4 py-3">
                    <Skeleton className="h-4 w-full" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  /* ── Empty state ────────────────────────────────────────────── */

  if (cards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card p-12 shadow-sm">
        <p className="text-sm text-muted-foreground">No cards found</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try adjusting your filters or create some kanban loops first.
        </p>
      </div>
    );
  }

  /* ── Table ──────────────────────────────────────────────────── */

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted">
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
              Card #
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
              Part Name
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
              Loop Type
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
              Stage
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
              Time in Stage
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
              Cycles
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
              Last Printed
            </th>
            <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => {
            const nextStage = getNextStage(card.currentStage);
            const stageMeta = CARD_STAGE_META[card.currentStage];
            const loopType = card.loopType;
            const loopClasses = loopType ? LOOP_TYPE_CLASSES[loopType] : null;
            const loopLabel = loopType ? LOOP_META[loopType]?.label : null;
            const isActing = actionLoading === card.id;

            return (
              <tr
                key={card.id}
                className={cn(
                  "border-t border-border hover:bg-muted/50 transition-colors",
                  onCardClick && "cursor-pointer",
                )}
                onClick={() => onCardClick?.(card)}
              >
                {/* Card # */}
                <td className="px-4 py-3 font-semibold text-[hsl(var(--link))] whitespace-nowrap">
                  #{card.cardNumber}
                </td>

                {/* Part Name */}
                <td className="px-4 py-3 whitespace-nowrap max-w-[200px] truncate">
                  {card.partName || (
                    <span className="text-muted-foreground italic">--</span>
                  )}
                </td>

                {/* Loop Type */}
                <td className="px-4 py-3 whitespace-nowrap">
                  {loopType && loopClasses && loopLabel ? (
                    <Badge
                      className={cn(
                        "border-transparent text-xs font-medium",
                        loopClasses.bg,
                        loopClasses.text,
                      )}
                    >
                      {loopLabel}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">--</span>
                  )}
                </td>

                {/* Stage */}
                <td className="px-4 py-3 whitespace-nowrap">
                  <Badge
                    className={cn(
                      "border-transparent text-xs font-medium",
                      stageMeta.bgClass,
                      stageMeta.textClass,
                    )}
                  >
                    {stageMeta.label}
                  </Badge>
                </td>

                {/* Time in Stage */}
                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground tabular-nums">
                  {formatTimeInStage(card.currentStageEnteredAt)}
                </td>

                {/* Completed Cycles */}
                <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                  {card.completedCycles}
                </td>

                {/* Last Printed */}
                <td className="px-4 py-3 whitespace-nowrap text-muted-foreground text-xs">
                  {formatDate(card.lastPrintedAt)}
                </td>

                {/* Actions */}
                <td className="px-4 py-3 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    {/* Print button */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      disabled={isActing}
                      onClick={() => handlePrint(card)}
                      title="Print card"
                    >
                      {isActing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Printer className="h-3.5 w-3.5" />
                      )}
                    </Button>

                    {/* Transition dropdown */}
                    {nextStage ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs"
                            disabled={isActing}
                          >
                            <ArrowRight className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Move</span>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-52 p-2" align="end">
                          <p className="px-2 pb-1.5 text-xs font-semibold text-muted-foreground">
                            Transition to
                          </p>
                          {/* Show the immediate next stage prominently */}
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium hover:bg-muted/50 transition-colors"
                            onClick={() => handleTransition(card, nextStage)}
                          >
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{
                                backgroundColor:
                                  CARD_STAGE_META[nextStage].color,
                              }}
                            />
                            {CARD_STAGE_META[nextStage].label}
                            <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                          </button>

                          {/* Remaining stages after nextStage */}
                          {CARD_STAGES.slice(
                            CARD_STAGES.indexOf(nextStage) + 1,
                          ).map((stage) => (
                            <button
                              key={stage}
                              type="button"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
                              onClick={() => handleTransition(card, stage)}
                            >
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{
                                  backgroundColor:
                                    CARD_STAGE_META[stage].color,
                                }}
                              />
                              {CARD_STAGE_META[stage].label}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 opacity-30"
                        disabled
                        title="No further stages"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
