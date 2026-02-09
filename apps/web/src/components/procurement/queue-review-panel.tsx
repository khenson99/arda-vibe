/**
 * QueueReviewPanel — Full queue review interface
 *
 * Displays a filterable, selectable list of triggered Kanban cards
 * waiting for procurement action. Includes summary stats, criticality
 * filter buttons, search, and bulk PO generation.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { QueueItemCard } from './queue-item-card';
import type { QueueItem, CriticalityLevel } from './types';

// ─── Component ───────────────────────────────────────────────────────

export interface QueueReviewPanelProps {
  items: QueueItem[];
  onGeneratePO?: (cardIds: string[]) => void;
  onViewSupplier?: (supplierId: string) => void;
  onViewPart?: (partId: string) => void;
  loading?: boolean;
}

export function QueueReviewPanel({
  items,
  onGeneratePO,
  onViewSupplier,
  onViewPart,
  loading = false,
}: QueueReviewPanelProps) {
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = React.useState('');
  const [criticalityFilter, setCriticalityFilter] = React.useState<CriticalityLevel | null>(null);

  // ─── Derived Data ────────────────────────────────────────────────
  const criticalityCounts = React.useMemo(() => {
    const counts: Record<CriticalityLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const item of items) {
      counts[item.criticality]++;
    }
    return counts;
  }, [items]);

  const filteredItems = React.useMemo(() => {
    let result = items;

    if (criticalityFilter) {
      result = result.filter((i) => i.criticality === criticalityFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (i) =>
          i.partNumber.toLowerCase().includes(q) ||
          i.partName.toLowerCase().includes(q) ||
          (i.supplierName?.toLowerCase().includes(q) ?? false) ||
          i.facilityName.toLowerCase().includes(q)
      );
    }

    return result;
  }, [items, criticalityFilter, searchQuery]);

  const selectedCount = selectedIds.size;
  const uniqueSuppliers = React.useMemo(() => {
    const suppliers = new Set<string>();
    for (const id of selectedIds) {
      const item = items.find((i) => i.cardId === id);
      if (item?.supplierId) suppliers.add(item.supplierId);
    }
    return suppliers.size;
  }, [selectedIds, items]);

  // ─── Handlers ────────────────────────────────────────────────────
  const toggleItem = (cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(filteredItems.map((i) => i.cardId)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleGeneratePO = () => {
    if (selectedCount > 0 && onGeneratePO) {
      onGeneratePO(Array.from(selectedIds));
    }
  };

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="px-4 py-3">
          <div className="text-xs text-muted-foreground">Total Items</div>
          <div className="text-2xl font-bold">{items.length}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs text-muted-foreground">Critical</div>
          <div className="text-2xl font-bold text-red-600">{criticalityCounts.critical}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs text-muted-foreground">High</div>
          <div className="text-2xl font-bold text-amber-600">{criticalityCounts.high}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs text-muted-foreground">Medium / Low</div>
          <div className="text-2xl font-bold">
            {criticalityCounts.medium + criticalityCounts.low}
          </div>
        </Card>
      </div>

      {/* Filters + Actions Bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Search */}
            <input
              type="text"
              placeholder="Search parts, suppliers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-56 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />

            {/* Criticality Filters */}
            <div className="flex items-center gap-1">
              {(
                [
                  ['critical', 'destructive'],
                  ['high', 'warning'],
                  ['medium', 'accent'],
                  ['low', 'secondary'],
                ] as const
              ).map(([level, variant]) => (
                <button
                  key={level}
                  type="button"
                  onClick={() =>
                    setCriticalityFilter((prev) => (prev === level ? null : level))
                  }
                  className={cn(
                    'px-2 py-1 rounded-md text-xs font-medium transition-colors',
                    criticalityFilter === level
                      ? 'bg-foreground text-background'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  )}
                >
                  {level.charAt(0).toUpperCase() + level.slice(1)} ({criticalityCounts[level]})
                </button>
              ))}
            </div>

            <div className="flex-1" />

            {/* Select All / Deselect */}
            <Button variant="ghost" size="sm" onClick={selectAll}>
              Select All
            </Button>
            <Button variant="ghost" size="sm" onClick={deselectAll}>
              Deselect
            </Button>

            {/* Generate PO */}
            <Button
              onClick={handleGeneratePO}
              disabled={selectedCount === 0 || loading}
              size="sm"
            >
              Generate PO{selectedCount > 0 ? ` (${selectedCount})` : ''}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Queue Item List */}
      <div className="space-y-2">
        {loading && items.length === 0 && (
          <Card className="px-4 py-8 text-center text-sm text-muted-foreground">
            Loading queue items...
          </Card>
        )}

        {!loading && filteredItems.length === 0 && (
          <Card className="px-4 py-8 text-center text-sm text-muted-foreground">
            {items.length === 0
              ? 'No items in the procurement queue.'
              : 'No items match the current filters.'}
          </Card>
        )}

        {filteredItems.map((item) => (
          <QueueItemCard
            key={item.cardId}
            item={item}
            selected={selectedIds.has(item.cardId)}
            onSelect={toggleItem}
            onViewSupplier={onViewSupplier}
            onViewPart={onViewPart}
          />
        ))}
      </div>

      {/* Selection Summary Bar */}
      {selectedCount > 0 && (
        <Card className="sticky bottom-4 px-4 py-3 bg-background/95 backdrop-blur border-primary/20">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="font-semibold">{selectedCount}</span> item{selectedCount !== 1 ? 's' : ''} selected
              {uniqueSuppliers > 0 && (
                <span className="text-muted-foreground">
                  {' '}across <span className="font-semibold">{uniqueSuppliers}</span> supplier{uniqueSuppliers !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={deselectAll}>
                Clear
              </Button>
              <Button size="sm" onClick={handleGeneratePO} disabled={loading}>
                Generate PO{uniqueSuppliers > 1 ? 's' : ''}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
