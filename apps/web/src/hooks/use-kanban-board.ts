import * as React from "react";
import type { KanbanCard, CardStage } from "@/types";
import {
  isUnauthorized,
  parseApiError,
  fetchCards,
  transitionCard,
} from "@/lib/api-client";

/* ── Grouped cards type ─────────────────────────────────────── */

export type GroupedCards = Record<CardStage, KanbanCard[]>;
export type GroupedCardsByItem = Record<
  CardStage,
  Array<{
    itemKey: string;
    itemLabel: string;
    cards: KanbanCard[];
  }>
>;

function emptyGrouped(): GroupedCards {
  return {
    created: [],
    triggered: [],
    ordered: [],
    in_transit: [],
    received: [],
    restocked: [],
  };
}

function emptyGroupedByItem(): GroupedCardsByItem {
  return {
    created: [],
    triggered: [],
    ordered: [],
    in_transit: [],
    received: [],
    restocked: [],
  };
}

function groupCards(cards: KanbanCard[]): GroupedCards {
  const grouped = emptyGrouped();
  for (const card of cards) {
    if (card.currentStage in grouped) {
      grouped[card.currentStage].push(card);
    }
  }
  return grouped;
}

function groupCardsByItem(cards: KanbanCard[]): GroupedCardsByItem {
  const grouped = emptyGroupedByItem();

  for (const stage of Object.keys(grouped) as CardStage[]) {
    const cardsInStage = cards.filter((card) => card.currentStage === stage);
    const byItem = new Map<string, { itemKey: string; itemLabel: string; cards: KanbanCard[] }>();

    for (const card of cardsInStage) {
      const itemLabel = card.partName?.trim() || card.partNumber?.trim() || card.partId || "Unassigned item";
      const itemKey = `${card.partNumber ?? ""}|${card.partName ?? ""}|${card.partId ?? card.id}`;
      const existing = byItem.get(itemKey);
      if (existing) {
        existing.cards.push(card);
      } else {
        byItem.set(itemKey, { itemKey, itemLabel, cards: [card] });
      }
    }

    grouped[stage] = Array.from(byItem.values())
      .map((group) => ({
        ...group,
        cards: [...group.cards].sort((a, b) => a.cardNumber - b.cardNumber),
      }))
      .sort((a, b) => a.itemLabel.localeCompare(b.itemLabel));
  }

  return grouped;
}

/* ── Hook return type ───────────────────────────────────────── */

export interface UseKanbanBoardReturn {
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  allCards: KanbanCard[];
  grouped: GroupedCards;
  groupedByItem: GroupedCardsByItem;
  moveCard: (cardId: string, toStage: CardStage) => Promise<boolean>;
  refresh: () => Promise<void>;
}

/* ── Hook ────────────────────────────────────────────────────── */

export function useKanbanBoard(
  token: string | null,
  onUnauthorized: () => void,
): UseKanbanBoardReturn {
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [isLoading, setIsLoading] = React.useState(true);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [allCards, setAllCards] = React.useState<KanbanCard[]>([]);

  const grouped = React.useMemo(() => groupCards(allCards), [allCards]);
  const groupedByItem = React.useMemo(() => groupCardsByItem(allCards), [allCards]);

  /* ── Fetch all cards ─────────────────────────────────────── */

  const fetchAllCards = React.useCallback(async () => {
    if (!token) {
      setAllCards([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    try {
      // Fetch a large page to get all cards at once
      const result = await fetchCards(token, { pageSize: 500 });
      if (!isMountedRef.current) return;
      setAllCards(result.data);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    }
  }, [token, onUnauthorized]);

  const refresh = React.useCallback(async () => {
    setIsRefreshing(true);
    try {
      await fetchAllCards();
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [fetchAllCards]);

  /* ── Initial load ────────────────────────────────────────── */

  React.useEffect(() => {
    setIsLoading(true);
    fetchAllCards().finally(() => {
      if (isMountedRef.current) setIsLoading(false);
    });
  }, [fetchAllCards]);

  /* ── Move card (optimistic update) ───────────────────────── */

  const moveCard = React.useCallback(
    async (cardId: string, toStage: CardStage): Promise<boolean> => {
      if (!token) return false;

      const card = allCards.find((c) => c.id === cardId);
      if (!card) return false;

      // Optimistic update
      const previousCards = [...allCards];
      setAllCards((prev) =>
        prev.map((c) =>
          c.id === cardId
            ? { ...c, currentStage: toStage, currentStageEnteredAt: new Date().toISOString() }
            : c,
        ),
      );

      try {
        await transitionCard(token, cardId, {
          toStage,
          method: "manual",
        });
        return true;
      } catch (err) {
        // Rollback on error
        if (isMountedRef.current) {
          setAllCards(previousCards);
        }
        if (isUnauthorized(err)) {
          onUnauthorized();
        }
        throw err;
      }
    },
    [token, allCards, onUnauthorized],
  );

  return {
    isLoading,
    isRefreshing,
    error,
    allCards,
    grouped,
    groupedByItem,
    moveCard,
    refresh,
  };
}
