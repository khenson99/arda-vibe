/**
 * ProductionQueueList — Full production queue view with filters and batch triage
 *
 * Renders the production queue with:
 * - Status tab filters (All, Draft, Scheduled, In Progress, On Hold)
 * - Batch selection with triage actions (expedite, hold, resume, cancel)
 * - Sortable by priority score (default), age, or step progress
 * - Expedited-only toggle
 * - Refresh scores action
 *
 * Follows Arda design system with Card containers and density-aware layout.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProductionQueueItemCard } from './production-queue-item';
import type {
  ProductionQueueItem,
  WOStatus,
  TriageAction,
  TriageActionInput,
  TriageResult,
  ProductionQueueFilters,
} from './types';

// ─── Status Tabs ────────────────────────────────────────────────────

type StatusTab = 'all' | WOStatus;

const STATUS_TABS: { value: StatusTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'completed', label: 'Completed' },
];

// ─── Props ──────────────────────────────────────────────────────────

export interface ProductionQueueListProps {
  items: ProductionQueueItem[];
  loading?: boolean;
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  onFilterChange?: (filters: ProductionQueueFilters) => void;
  onViewDetail?: (workOrderId: string) => void;
  onExpedite?: (workOrderId: string) => Promise<void>;
  onHold?: (workOrderId: string) => Promise<void>;
  onResume?: (workOrderId: string) => Promise<void>;
  onBatchTriage?: (actions: TriageActionInput[]) => Promise<TriageResult[]>;
  onRefreshScores?: () => Promise<void>;
}

// ─── Component ──────────────────────────────────────────────────────

export function ProductionQueueList({
  items,
  loading,
  total,
  page = 1,
  pageSize = 50,
  onPageChange,
  onFilterChange,
  onViewDetail,
  onExpedite,
  onHold,
  onResume,
  onBatchTriage,
  onRefreshScores,
}: ProductionQueueListProps) {
  const [activeTab, setActiveTab] = React.useState<StatusTab>('all');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [expeditedOnly, setExpeditedOnly] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [triageLoading, setTriageLoading] = React.useState(false);
  const [triageResults, setTriageResults] = React.useState<TriageResult[] | null>(null);

  // ─── Derived Data ───────────────────────────────────────────────

  const filteredItems = React.useMemo(() => {
    let filtered = items;

    if (activeTab !== 'all') {
      filtered = filtered.filter((item) => item.status === activeTab);
    }

    if (expeditedOnly) {
      filtered = filtered.filter((item) => item.isExpedited);
    }

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase().trim();
      filtered = filtered.filter(
        (item) =>
          item.woNumber.toLowerCase().includes(term) ||
          item.partNumber.toLowerCase().includes(term) ||
          item.partName.toLowerCase().includes(term)
      );
    }

    return filtered;
  }, [items, activeTab, expeditedOnly, searchTerm]);

  const statusCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const item of items) {
      counts[item.status] = (counts[item.status] || 0) + 1;
    }
    return counts;
  }, [items]);

  const selectedItems = filteredItems.filter((item) => selectedIds.has(item.workOrderId));

  // ─── Handlers ─────────────────────────────────────────────────────

  function handleTabChange(tab: StatusTab) {
    setActiveTab(tab);
    setSelectedIds(new Set());
    onFilterChange?.({ status: tab === 'all' ? undefined : tab, expeditedOnly });
  }

  function toggleSelection(workOrderId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(workOrderId)) {
        next.delete(workOrderId);
      } else {
        next.add(workOrderId);
      }
      return next;
    });
  }

  function selectAll() {
    if (selectedIds.size === filteredItems.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredItems.map((i) => i.workOrderId)));
    }
  }

  async function handleBatchAction(action: TriageAction) {
    if (selectedItems.length === 0 || !onBatchTriage) return;

    setTriageLoading(true);
    setTriageResults(null);

    try {
      const actions: TriageActionInput[] = selectedItems.map((item) => ({
        workOrderId: item.workOrderId,
        action,
      }));
      const results = await onBatchTriage(actions);
      setTriageResults(results);

      // Clear successful selections
      const successes = new Set(results.filter((r) => r.success).map((r) => r.workOrderId));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of successes) next.delete(id);
        return next;
      });
    } finally {
      setTriageLoading(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────

  const totalPages = total ? Math.ceil(total / pageSize) : 1;
  const allSelected = filteredItems.length > 0 && selectedIds.size === filteredItems.length;

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-base font-semibold">
            Production Queue
            {total !== undefined && (
              <span className="text-muted-foreground font-normal ml-2">({total})</span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {onRefreshScores && (
              <Button variant="outline" size="sm" className="text-xs" onClick={onRefreshScores}>
                Refresh Scores
              </Button>
            )}
          </div>
        </div>

        {/* Filters row */}
        <div className="mt-3 flex items-center gap-3">
          <Tabs>
            <TabsList>
              {STATUS_TABS.map((tab) => (
                <TabsTrigger
                  key={tab.value}
                  active={activeTab === tab.value}
                  onClick={() => handleTabChange(tab.value)}
                >
                  {tab.label}
                  {statusCounts[tab.value] !== undefined && (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {statusCounts[tab.value]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="mt-2 flex items-center gap-3">
          <Input
            placeholder="Search by WO#, part#, or name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-8 max-w-xs text-sm"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={expeditedOnly}
              onChange={(e) => {
                setExpeditedOnly(e.target.checked);
                onFilterChange?.({
                  status: activeTab === 'all' ? undefined : activeTab,
                  expeditedOnly: e.target.checked,
                });
              }}
              className="h-3.5 w-3.5 rounded border-border text-primary"
            />
            Expedited only
          </label>
        </div>
      </CardHeader>

      {/* Batch action bar */}
      {selectedIds.size > 0 && (
        <div className="border-t border-b border-border bg-muted/50 px-6 py-2 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium">
              {selectedIds.size} selected
            </span>
            <Separator orientation="vertical" className="h-4" />
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={triageLoading}
                onClick={() => handleBatchAction('expedite')}
              >
                Expedite
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={triageLoading}
                onClick={() => handleBatchAction('schedule')}
              >
                Schedule
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={triageLoading}
                onClick={() => handleBatchAction('hold')}
              >
                Hold
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={triageLoading}
                onClick={() => handleBatchAction('resume')}
              >
                Resume
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs text-destructive"
                disabled={triageLoading}
                onClick={() => handleBatchAction('cancel')}
              >
                Cancel
              </Button>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      {/* Triage result banner */}
      {triageResults && (
        <div className="border-b border-border px-6 py-2 bg-muted/30">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-emerald-600 font-medium">
              {triageResults.filter((r) => r.success).length} succeeded
            </span>
            {triageResults.some((r) => !r.success) && (
              <span className="text-red-600 font-medium">
                {triageResults.filter((r) => !r.success).length} failed
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-6 px-1.5"
              onClick={() => setTriageResults(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <CardContent className="pt-2">
        {/* Select all header */}
        {filteredItems.length > 0 && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={selectAll}
              className="h-3.5 w-3.5 rounded border-border text-primary"
            />
            <span className="text-xs text-muted-foreground">
              {allSelected ? 'Deselect all' : 'Select all'}
            </span>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            Loading production queue...
          </div>
        )}

        {/* Empty state */}
        {!loading && filteredItems.length === 0 && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            {items.length === 0
              ? 'No work orders in the production queue.'
              : 'No work orders match the current filters.'}
          </div>
        )}

        {/* Queue items */}
        {!loading && filteredItems.length > 0 && (
          <div className="space-y-2">
            {filteredItems.map((item) => (
              <ProductionQueueItemCard
                key={item.workOrderId}
                item={item}
                selected={selectedIds.has(item.workOrderId)}
                onSelect={toggleSelection}
                onViewDetail={onViewDetail}
                onQuickExpedite={onExpedite}
                onQuickHold={onHold}
                onQuickResume={onResume}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={page <= 1}
                onClick={() => onPageChange?.(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={page >= totalPages}
                onClick={() => onPageChange?.(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
