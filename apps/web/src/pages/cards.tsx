import * as React from "react";
import { RefreshCw, ChevronLeft, ChevronRight, CreditCard } from "lucide-react";
import type { AuthSession, KanbanCard, LoopType } from "@/types";
import { CARD_STAGES, LOOP_META, LOOP_ORDER } from "@/types";
import { useKanbanCards } from "@/hooks/use-kanban-cards";
import { useKanbanBoard } from "@/hooks/use-kanban-board";
import type { GroupedCards } from "@/hooks/use-kanban-board";
import { CardFilters, CardsTable, ViewToggle, useViewMode } from "@/components/kanban-cards";
import {
  BoardContainer,
  CardDetailDrawer,
} from "@/components/kanban-board";
import type { BoardFilterState } from "@/components/kanban-board";
import { createPurchaseOrderFromCards, parseApiError } from "@/lib/api-client";
import { Button, Input, Skeleton } from "@/components/ui";

/* ── Board filter logic (from board.tsx) ───────────────────── */

function matchesCard(card: KanbanCard, search: string, activeLoopTypes: Set<LoopType>): boolean {
  if (activeLoopTypes.size > 0 && card.loopType && !activeLoopTypes.has(card.loopType)) {
    return false;
  }
  if (search) {
    const cardNum = String(card.cardNumber);
    const partName = (card.partName ?? "").toLowerCase();
    if (!cardNum.includes(search) && !partName.includes(search)) {
      return false;
    }
  }
  return true;
}

function applyBoardFilters(
  grouped: GroupedCards,
  allCards: KanbanCard[],
  filters: BoardFilterState,
): { filteredGrouped: GroupedCards; filteredAllCards: KanbanCard[] } {
  const search = filters.searchTerm.trim().toLowerCase();
  const matches = (card: KanbanCard) => matchesCard(card, search, filters.activeLoopTypes);

  const filteredAllCards = allCards.filter(matches);
  const filteredGrouped = {} as GroupedCards;
  for (const stage of CARD_STAGES) {
    filteredGrouped[stage] = grouped[stage].filter(matches);
  }

  return { filteredGrouped, filteredAllCards };
}

function LoopTypeFilterPill({
  loopType,
  isActive,
  count,
  onClick,
}: {
  loopType: LoopType;
  isActive: boolean;
  count: number;
  onClick: () => void;
}) {
  const meta = LOOP_META[loopType];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        isActive
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
      <span className="opacity-70">({count})</span>
    </button>
  );
}

/* ── Board loading skeleton ────────────────────────────────── */

function BoardSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4">
      <Skeleton className="h-[88px] w-full rounded-xl" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="w-[260px] shrink-0">
            <Skeleton className="h-10 w-full rounded-t-xl" />
            <div className="space-y-2 p-2">
              {Array.from({ length: 3 }).map((_, j) => (
                <Skeleton key={j} className="h-[72px] w-full rounded-xl" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Props ───────────────────────────────────────────────────── */

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

/* ── Page ─────────────────────────────────────────────────────── */

export function CardsRoute({ session, onUnauthorized }: Props) {
  const token = session.tokens.accessToken;
  const [viewMode, setViewMode] = useViewMode();

  /* ── Table view data ─────────────────────────────────────── */
  const tableData = useKanbanCards(token, onUnauthorized);

  /* ── Board view data (only fetches when board is active) ─── */
  const boardData = useKanbanBoard(
    viewMode === "board" ? token : null,
    onUnauthorized,
  );

  /* ── Board filters ───────────────────────────────────────── */
  const [boardFilters, setBoardFilters] = React.useState<BoardFilterState>({
    searchTerm: "",
    activeLoopTypes: new Set<LoopType>(),
  });

  const { filteredGrouped, filteredAllCards } = React.useMemo(
    () => applyBoardFilters(boardData.grouped, boardData.allCards, boardFilters),
    [boardData.grouped, boardData.allCards, boardFilters],
  );

  const countByLoop = React.useMemo(() => {
    const counts: Record<LoopType, number> = {
      procurement: 0,
      production: 0,
      transfer: 0,
    };
    for (const card of boardData.allCards) {
      if (card.loopType && card.loopType in counts) {
        counts[card.loopType] += 1;
      }
    }
    return counts;
  }, [boardData.allCards]);

  /* ── Card detail drawer ──────────────────────────────────── */
  const [selectedCard, setSelectedCard] = React.useState<KanbanCard | null>(null);

  /* ── Refresh logic ───────────────────────────────────────── */
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const handleRefresh = React.useCallback(async () => {
    setIsRefreshing(true);
    if (viewMode === "board") {
      await boardData.refresh();
    } else {
      await tableData.refresh();
    }
    setIsRefreshing(false);
  }, [viewMode, boardData, tableData]);

  const handleBoardSearchChange = React.useCallback((value: string) => {
    setBoardFilters((prev) => ({ ...prev, searchTerm: value }));
  }, []);

  const handleToggleLoopType = React.useCallback((loopType: LoopType) => {
    setBoardFilters((prev) => {
      const next = new Set(prev.activeLoopTypes);
      if (next.has(loopType)) {
        next.delete(loopType);
      } else {
        next.add(loopType);
      }
      return { ...prev, activeLoopTypes: next };
    });
  }, []);

  const handleCreateOrder = React.useCallback(
    async (card: KanbanCard): Promise<boolean> => {
      if (card.currentStage !== "triggered" || card.loopType !== "procurement") {
        return false;
      }
      try {
        await createPurchaseOrderFromCards(token, { cardIds: [card.id] });
        await boardData.refresh();
        return true;
      } catch (error) {
        throw new Error(parseApiError(error));
      }
    },
    [boardData, token],
  );

  /* ── Derived state ────────────────────────────────────────── */
  const error = viewMode === "board" ? boardData.error : tableData.error;
  const totalCards = viewMode === "board" ? boardData.allCards.length : tableData.pagination.total;

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <CreditCard className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Kanban Cards</h1>
              <p className="text-xs text-muted-foreground">
                {totalCards > 0
                  ? `${totalCards} card${totalCards !== 1 ? "s" : ""} total`
                  : "Manage physical kanban cards"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {viewMode === "board" && (
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/20 p-3">
            <Input
              value={boardFilters.searchTerm}
              onChange={(event) => handleBoardSearchChange(event.target.value)}
              placeholder="Search by card # or part name"
              className="h-9 bg-background"
            />
            <div className="flex flex-wrap items-center gap-2">
              {LOOP_ORDER.map((loopType) => (
                <LoopTypeFilterPill
                  key={loopType}
                  loopType={loopType}
                  isActive={boardFilters.activeLoopTypes.has(loopType)}
                  count={countByLoop[loopType]}
                  onClick={() => handleToggleLoopType(loopType)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── Table View ─────────────────────────────────────── */}
      {viewMode === "table" && (
        <>
          <CardFilters filters={tableData.filters} onFiltersChange={tableData.setFilters} />

          <CardsTable
            cards={tableData.cards}
            isLoading={tableData.isLoading}
            token={token}
            tenantName={session.user.tenantName}
            tenantLogoUrl={session.user.tenantLogo}
            onUnauthorized={onUnauthorized}
            onRefresh={tableData.refresh}
            onCardClick={setSelectedCard}
          />

          {tableData.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Page {tableData.pagination.page} of {tableData.pagination.totalPages}
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => tableData.setFilters((f) => ({ ...f, page: f.page - 1 }))}
                  disabled={tableData.pagination.page <= 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => tableData.setFilters((f) => ({ ...f, page: f.page + 1 }))}
                  disabled={tableData.pagination.page >= tableData.pagination.totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Board View ──────────────────────────────────────── */}
      {viewMode === "board" && (
        <>
          {boardData.isLoading ? (
            <BoardSkeleton />
          ) : (
            <BoardContainer
              grouped={filteredGrouped}
              allCards={filteredAllCards}
              moveCard={boardData.moveCard}
              onCreateOrder={handleCreateOrder}
              onCardClick={setSelectedCard}
            />
          )}
        </>
      )}

      {/* Card detail drawer -- available in both views */}
      <CardDetailDrawer
        card={selectedCard}
        token={token}
        tenantName={session.user.tenantName}
        tenantLogoUrl={session.user.tenantLogo}
        onUnauthorized={onUnauthorized}
        onClose={() => setSelectedCard(null)}
      />
    </div>
  );
}
