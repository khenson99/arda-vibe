import * as React from "react";
import {
  DndContext,
  closestCorners,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import { parseApiError } from "@/lib/api-client";
import { StageColumn } from "./stage-column";
import { BoardCard } from "./board-card";
import type { GroupedCards } from "@/hooks/use-kanban-board";
import type { KanbanCard, CardStage } from "@/types";
import { CARD_STAGES, CARD_STAGE_META } from "@/types";

const CARD_TRANSITION_MATRIX: Record<CardStage, CardStage[]> = {
  created: ["triggered"],
  triggered: ["ordered"],
  ordered: ["in_transit", "received"],
  in_transit: ["received"],
  received: ["restocked"],
  restocked: ["triggered"],
};

function getNextStage(card: KanbanCard): CardStage | null {
  const options = CARD_TRANSITION_MATRIX[card.currentStage] ?? [];
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

/* ── Props ──────────────────────────────────────────────────── */

interface BoardContainerProps {
  grouped: GroupedCards;
  allCards: KanbanCard[];
  moveCard: (cardId: string, toStage: CardStage) => Promise<boolean>;
  onCreateOrder: (card: KanbanCard) => Promise<boolean>;
  onCardClick: (card: KanbanCard) => void;
}

/* ── BoardContainer ─────────────────────────────────────────── */

export function BoardContainer({
  grouped,
  allCards,
  moveCard,
  onCreateOrder,
  onCardClick,
}: BoardContainerProps) {
  const [activeCard, setActiveCard] = React.useState<KanbanCard | null>(null);

  /* ── DnD sensors (delay to distinguish click vs drag) ───── */

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 200, tolerance: 6 },
  });
  const sensors = useSensors(pointerSensor, touchSensor);

  const handleMoveNext = React.useCallback(
    async (card: KanbanCard) => {
      const toStage = getNextStage(card);
      if (!toStage) {
        toast.error("No valid next stage for this card.");
        return;
      }
      try {
        await moveCard(card.id, toStage);
        toast.success(`Card #${card.cardNumber} moved to ${CARD_STAGE_META[toStage].label}`);
      } catch (err) {
        toast.error(parseApiError(err));
      }
    },
    [moveCard],
  );

  const handleMovePrevious = React.useCallback(
    async (card: KanbanCard) => {
      const toStage = getPreviousStage(card);
      if (!toStage) {
        toast.error("No valid previous stage for this card.");
        return;
      }
      try {
        await moveCard(card.id, toStage);
        toast.success(`Card #${card.cardNumber} moved to ${CARD_STAGE_META[toStage].label}`);
      } catch (err) {
        toast.error(parseApiError(err));
      }
    },
    [moveCard],
  );

  const handleCreateOrder = React.useCallback(
    async (card: KanbanCard) => {
      try {
        const created = await onCreateOrder(card);
        if (created) {
          toast.success(`Order created from card #${card.cardNumber}`);
          return;
        }
        toast.error("Create Order is only available for triggered procurement cards.");
      } catch (err) {
        toast.error(parseApiError(err));
      }
    },
    [onCreateOrder],
  );

  /* ── Drag handlers ──────────────────────────────────────── */

  const handleDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const cardId = event.active.id as string;
      const card = allCards.find((c) => c.id === cardId) ?? null;
      setActiveCard(card);
    },
    [allCards],
  );

  const handleDragEnd = React.useCallback(
    async (event: DragEndEvent) => {
      setActiveCard(null);

      const { active, over } = event;
      if (!over) return;

      const cardId = active.id as string;
      if (typeof over.id !== "string" || !CARD_STAGES.includes(over.id as CardStage)) {
        return;
      }
      const toStage = over.id as CardStage;

      // Find the card for no-op handling and toast content.
      const card = allCards.find((c) => c.id === cardId);
      if (!card) return;

      // Same column -- no-op
      if (card.currentStage === toStage) return;

      try {
        await moveCard(cardId, toStage);
        const toLabel = CARD_STAGE_META[toStage].label;
        toast.success(`Card #${card.cardNumber} moved to ${toLabel}`);
      } catch (err) {
        toast.error(parseApiError(err));
      }
    },
    [allCards, moveCard],
  );

  const handleDragCancel = React.useCallback(() => {
    setActiveCard(null);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={(e) => void handleDragEnd(e)}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-3 overflow-x-auto pb-4">
        {CARD_STAGES.map((stage) => (
          <div key={stage} className="w-[260px] shrink-0">
            <StageColumn
              stage={stage}
              cards={grouped[stage]}
              onCardClick={onCardClick}
              onMoveNext={handleMoveNext}
              onMovePrevious={handleMovePrevious}
              onCreateOrder={handleCreateOrder}
            />
          </div>
        ))}
      </div>

      {/* Drag overlay — follows the pointer */}
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="w-[240px]">
            <BoardCard
              card={activeCard}
              onClick={() => {}}
              onMoveNext={handleMoveNext}
              onMovePrevious={handleMovePrevious}
              onCreateOrder={handleCreateOrder}
              isDragOverlay
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
