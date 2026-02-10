import * as React from "react";
import { RefreshCw, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button, Skeleton } from "@/components/ui";
import { TabsList, TabsTrigger } from "@/components/ui";
import type { AuthSession, LoopType } from "@/types";
import { LOOP_ORDER, LOOP_META } from "@/types";
import { useKanbanLoops } from "@/hooks/use-kanban-loops";
import { LoopCard, LoopDetailPanel, CreateLoopDialog } from "@/components/kanban-loops";

/* ── Filter type options ────────────────────────────────────── */

const FILTER_OPTIONS: Array<{ value: LoopType | "all"; label: string }> = [
  { value: "all", label: "All Loops" },
  ...LOOP_ORDER.map((lt) => ({ value: lt, label: LOOP_META[lt].label })),
];

/* ── Page component ─────────────────────────────────────────── */

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

export function LoopsRoute({ session, onUnauthorized }: Props) {
  const token = session.tokens.accessToken;
  const navigate = useNavigate();
  const { loopId } = useParams<{ loopId: string }>();

  const {
    loops,
    isLoading,
    error,
    pagination,
    expandedLoopId,
    expandedLoopDetail,
    isDetailLoading,
    filterType,
    setFilterType,
    page,
    setPage,
    openLoopById,
    collapseExpanded,
    refresh,
    refreshDetail,
  } = useKanbanLoops(token, onUnauthorized);

  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refresh();
    setIsRefreshing(false);
  };

  const handleLoopCreated = async () => {
    await refresh();
  };

  const handleOpenExistingLoop = React.useCallback((existingLoopId: string) => {
    navigate(`/loops/${existingLoopId}`);
  }, [navigate]);

  const handleParametersSaved = async () => {
    await refreshDetail();
    await refresh();
  };

  React.useEffect(() => {
    if (loopId) {
      void openLoopById(loopId);
      return;
    }
    collapseExpanded();
  }, [loopId, openLoopById, collapseExpanded]);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Kanban Loops</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure and monitor physical kanban card cycles.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="gap-1.5"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
            Refresh
          </Button>
          <CreateLoopDialog
            token={token}
            onUnauthorized={onUnauthorized}
            onCreated={handleLoopCreated}
            onOpenExistingLoop={handleOpenExistingLoop}
          />
        </div>
      </div>

      {/* Filter tabs */}
      <TabsList className="w-fit">
        {FILTER_OPTIONS.map((opt) => (
          <TabsTrigger
            key={opt.value}
            active={filterType === opt.value}
            onClick={() => setFilterType(opt.value as LoopType | "all")}
          >
            {opt.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={handleRefresh} className="ml-auto h-7 text-xs">
            Retry
          </Button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && !error && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-5 w-20" />
              </div>
              <div className="flex items-center gap-3">
                <Skeleton className="h-2 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && loops.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium">No loops found</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {filterType === "all"
              ? "Create your first kanban loop to get started."
              : `No ${LOOP_META[filterType as LoopType]?.label ?? filterType} loops exist yet.`}
          </p>
        </div>
      )}

      {/* Loop list */}
      {!isLoading && loops.length > 0 && (
        <div className="space-y-3">
          {loops.map((loop) => {
            const isExpanded = expandedLoopId === loop.id;
            // When expanded, we can derive a card summary from the detail
            const summaryFromDetail = isExpanded && expandedLoopDetail?.cardSummary
              ? expandedLoopDetail.cardSummary
              : undefined;

            return (
              <LoopCard
                key={loop.id}
                loop={loop}
                cardSummary={summaryFromDetail}
                isExpanded={isExpanded}
                onToggle={() => navigate(isExpanded ? "/loops" : `/loops/${loop.id}`)}
              >
                {isExpanded && (
                  <LoopDetailPanel
                    detail={expandedLoopDetail}
                    isLoading={isDetailLoading}
                    token={token}
                    onUnauthorized={onUnauthorized}
                    onParametersSaved={handleParametersSaved}
                  />
                )}
              </LoopCard>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
            {" "}({pagination.total} loop{pagination.total !== 1 ? "s" : ""})
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="h-7 w-7 p-0"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage(page + 1)}
              className="h-7 w-7 p-0"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
