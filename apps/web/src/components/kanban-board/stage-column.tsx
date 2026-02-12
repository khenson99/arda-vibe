import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { BoardCard } from "./board-card";
import type { KanbanCard, CardStage } from "@/types";
import { CARD_STAGE_META } from "@/types";

/* ── StageColumn component ──────────────────────────────────── */

interface StageColumnProps {
  stage: CardStage;
  cards: KanbanCard[];
  onCardClick: (card: KanbanCard) => void;
  onMoveNext: (card: KanbanCard) => Promise<void>;
  onMovePrevious: (card: KanbanCard) => Promise<void>;
  onCreateOrder: (card: KanbanCard) => Promise<void>;
}

export const StageColumn = React.memo(function StageColumn({
  stage,
  cards,
  onCardClick,
  onMoveNext,
  onMovePrevious,
  onCreateOrder,
}: StageColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: stage,
    data: { stage },
  });

  const meta = CARD_STAGE_META[stage];
  const groupedCards = React.useMemo(() => {
    const groups = new Map<string, { key: string; label: string; cards: KanbanCard[] }>();
    for (const card of cards) {
      const label = card.partName?.trim() || card.partNumber?.trim() || card.partId || "Unassigned item";
      const key = `${card.partNumber ?? ""}|${card.partName ?? ""}|${card.partId ?? card.id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.cards.push(card);
      } else {
        groups.set(key, { key, label, cards: [card] });
      }
    }

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        cards: [...group.cards].sort((a, b) => a.cardNumber - b.cardNumber),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [cards]);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-full min-w-[240px] flex-col rounded-xl border transition-colors",
        isOver
          ? "border-primary/50 bg-primary/5 ring-2 ring-primary/20"
          : "border-border/60 bg-muted/20",
      )}
    >
      {/* Column header */}
      <div
        className={cn(
          "flex items-center justify-between rounded-t-xl px-3 py-2.5",
          meta.bgClass,
        )}
      >
        <div className="flex items-center gap-2">
          <div
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: meta.color }}
          />
          <h3 className={cn("text-sm font-semibold", meta.textClass)}>
            {meta.label}
          </h3>
        </div>
        <Badge variant="secondary" className="text-[10px]">
          {cards.length}
        </Badge>
      </div>

      {/* Cards list */}
      <div className="flex-1 space-y-2 overflow-y-auto p-2" style={{ maxHeight: "calc(100vh - 260px)" }}>
        {cards.length === 0 ? (
          <div
            className={cn(
              "flex items-center justify-center rounded-lg border border-dashed px-3 py-8 text-center text-xs",
              isOver
                ? "border-primary/40 text-primary/70"
                : "border-border/50 text-muted-foreground",
            )}
          >
            {isOver ? "Drop here" : "No cards"}
          </div>
        ) : (
          groupedCards.map((group) => (
            <div key={group.key} className="space-y-1.5 rounded-lg border border-border/60 bg-background/70 p-2">
              <div className="flex items-center justify-between">
                <p className="truncate text-[11px] font-semibold text-foreground">{group.label}</p>
                <span className="text-[10px] text-muted-foreground">{group.cards.length}</span>
              </div>
              {group.cards.map((card) => (
                <BoardCard
                  key={card.id}
                  card={card}
                  onClick={onCardClick}
                  onMoveNext={onMoveNext}
                  onMovePrevious={onMovePrevious}
                  onCreateOrder={onCreateOrder}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
});
