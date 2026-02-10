import * as React from "react";
import type {
  KanbanLoop,
  KanbanCard,
  LoopType,
  LoopCardSummary,
  LoopVelocity,
} from "@/types";
import {
  isUnauthorized,
  parseApiError,
  fetchLoops,
  fetchLoop,
  fetchLoopCardSummary,
  fetchLoopVelocity,
} from "@/lib/api-client";

/* ── Expanded detail ────────────────────────────────────────── */

export interface ExpandedLoopDetail {
  loop: KanbanLoop & {
    cards?: KanbanCard[];
    parameterHistory?: Array<{
      parameter: string;
      oldValue: string;
      newValue: string;
      changedAt: string;
    }>;
  };
  cardSummary: LoopCardSummary | null;
  velocity: LoopVelocity | null;
}

/* ── Hook return ────────────────────────────────────────────── */

export interface UseKanbanLoopsReturn {
  loops: KanbanLoop[];
  isLoading: boolean;
  error: string | null;
  pagination: { page: number; pageSize: number; total: number; totalPages: number } | null;

  /** Currently expanded loop id */
  expandedLoopId: string | null;
  /** Detail data for the expanded loop */
  expandedLoopDetail: ExpandedLoopDetail | null;
  /** Whether the expanded detail is still loading */
  isDetailLoading: boolean;

  /** Filter loops by type */
  filterType: LoopType | "all";
  setFilterType: (t: LoopType | "all") => void;

  /** Pagination controls */
  page: number;
  setPage: (p: number) => void;

  /** Expand / collapse a loop */
  toggleExpanded: (loopId: string) => void;
  openLoopById: (loopId: string) => Promise<void>;
  collapseExpanded: () => void;

  /** Re-fetch the list */
  refresh: () => Promise<void>;

  /** Re-fetch expanded detail (e.g. after parameter update) */
  refreshDetail: () => Promise<void>;
}

/* ── Hook implementation ────────────────────────────────────── */

export function useKanbanLoops(
  token: string | null,
  onUnauthorized: () => void,
): UseKanbanLoopsReturn {
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [loops, setLoops] = React.useState<KanbanLoop[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [pagination, setPagination] = React.useState<{
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  } | null>(null);

  const [filterType, setFilterType] = React.useState<LoopType | "all">("all");
  const [page, setPage] = React.useState(1);

  const [expandedLoopId, setExpandedLoopId] = React.useState<string | null>(null);
  const [expandedLoopDetail, setExpandedLoopDetail] = React.useState<ExpandedLoopDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = React.useState(false);

  /* ── List fetch ─────────────────────────────────────────── */

  const loadLoops = React.useCallback(async () => {
    if (!token) {
      setLoops([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchLoops(token, {
        loopType: filterType === "all" ? undefined : filterType,
        page,
        pageSize: 20,
      });

      if (!isMountedRef.current) return;

      setLoops(() => {
        const hasExpandedLoopInPage =
          expandedLoopId && result.data.some((loop) => loop.id === expandedLoopId);

        if (
          expandedLoopDetail?.loop &&
          expandedLoopDetail.loop.id === expandedLoopId &&
          !hasExpandedLoopInPage
        ) {
          const withoutExpanded = result.data.filter((loop) => loop.id !== expandedLoopId);
          return [expandedLoopDetail.loop, ...withoutExpanded];
        }

        return result.data;
      });
      setPagination(result.pagination);
    } catch (err) {
      if (!isMountedRef.current) return;
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, [token, filterType, page, onUnauthorized, expandedLoopId, expandedLoopDetail]);

  React.useEffect(() => {
    loadLoops();
  }, [loadLoops]);

  // Reset page when filter changes
  React.useEffect(() => {
    setPage(1);
  }, [filterType]);

  /* ── Detail fetch ──────────────────────────────────────── */

  const loadDetail = React.useCallback(
    async (loopId: string, ensureInList = false) => {
      if (!token) return;

      setIsDetailLoading(true);

      try {
        const [loopDetail, cardSummary, velocity] = await Promise.all([
          fetchLoop(token, loopId),
          fetchLoopCardSummary(token, loopId).catch(() => null),
          fetchLoopVelocity(token, loopId).catch(() => null),
        ]);

        if (!isMountedRef.current) return;

        setExpandedLoopDetail({
          loop: loopDetail,
          cardSummary,
          velocity,
        });
        if (ensureInList) {
          setLoops((currentLoops) =>
            currentLoops.some((loop) => loop.id === loopDetail.id)
              ? currentLoops
              : [loopDetail, ...currentLoops]
          );
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        // Keep expanded but show partial data
        setExpandedLoopDetail(null);
      } finally {
        if (isMountedRef.current) setIsDetailLoading(false);
      }
    },
    [token, onUnauthorized],
  );

  const collapseExpanded = React.useCallback(() => {
    setExpandedLoopId(null);
    setExpandedLoopDetail(null);
  }, []);

  const toggleExpanded = React.useCallback(
    (loopId: string) => {
      if (expandedLoopId === loopId) {
        collapseExpanded();
      } else {
        setExpandedLoopId(loopId);
        setExpandedLoopDetail(null);
        loadDetail(loopId);
      }
    },
    [expandedLoopId, collapseExpanded, loadDetail],
  );

  const openLoopById = React.useCallback(
    async (loopId: string) => {
      if (!loopId) return;
      setExpandedLoopId(loopId);
      setExpandedLoopDetail(null);
      await loadDetail(loopId, true);
    },
    [loadDetail],
  );

  const refreshDetail = React.useCallback(async () => {
    if (expandedLoopId) {
      await loadDetail(expandedLoopId);
    }
  }, [expandedLoopId, loadDetail]);

  return {
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
    toggleExpanded,
    openLoopById,
    collapseExpanded,
    refresh: loadLoops,
    refreshDetail,
  };
}
