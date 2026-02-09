/**
 * ProductionQueueItem — Individual queue item card
 *
 * Renders a single work order from the production queue with
 * priority score, step progress, status badge, and quick actions.
 * Follows Arda design system: rounded-xl, shadow-sm, name-value pairs.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { WOStatusBadge } from './wo-status-badge';
import type { ProductionQueueItem as QueueItemType, WOStatus } from './types';

// ─── Helpers ────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffHrs < 1) return 'just now';
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

function getPriorityColor(score: number): string {
  if (score >= 80) return 'text-red-600 font-bold';
  if (score >= 60) return 'text-amber-600 font-bold';
  if (score >= 40) return 'text-blue-600 font-semibold';
  return 'text-muted-foreground font-semibold';
}

function getProgressPercent(completed: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}

// ─── Component ──────────────────────────────────────────────────────

export interface ProductionQueueItemProps {
  item: QueueItemType;
  selected?: boolean;
  onSelect?: (workOrderId: string) => void;
  onViewDetail?: (workOrderId: string) => void;
  onQuickExpedite?: (workOrderId: string) => void;
  onQuickHold?: (workOrderId: string) => void;
  onQuickResume?: (workOrderId: string) => void;
}

export function ProductionQueueItemCard({
  item,
  selected = false,
  onSelect,
  onViewDetail,
  onQuickExpedite,
  onQuickHold,
  onQuickResume,
}: ProductionQueueItemProps) {
  const progressPct = getProgressPercent(item.completedSteps, item.totalSteps);
  const qtyRemaining = item.quantityToProduce - item.quantityProduced;

  return (
    <Card
      className={cn(
        'px-4 py-3 transition-colors cursor-pointer',
        selected && 'ring-2 ring-primary/50 bg-primary/5',
        !selected && 'hover:bg-muted/50',
        item.isExpedited && 'border-l-4 border-l-red-500'
      )}
      onClick={() => onViewDetail?.(item.workOrderId)}
    >
      <div className="flex items-start gap-3">
        {/* Selection checkbox */}
        <div className="flex items-center pt-0.5">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect?.(item.workOrderId)}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            onClick={(e) => e.stopPropagation()}
          />
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Top row: WO number + status + priority */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                className="text-sm font-semibold text-[hsl(var(--link))] hover:underline truncate"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewDetail?.(item.workOrderId);
                }}
              >
                {item.woNumber}
              </button>
              <WOStatusBadge
                status={item.status}
                holdReason={item.holdReason}
                isExpedited={item.isExpedited}
              />
            </div>
            <span className={cn('text-sm tabular-nums shrink-0', getPriorityColor(item.priorityScore))}>
              {item.priorityScore.toFixed(0)}
            </span>
          </div>

          {/* Part info row */}
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className="font-medium text-foreground truncate">
              {item.partNumber}
            </span>
            <span className="text-muted-foreground truncate">
              {item.partName}
            </span>
            {item.isRework && (
              <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700">
                REWORK
              </span>
            )}
          </div>

          {/* Metrics row */}
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="name-value-pair">
              <span className="text-muted-foreground">Qty:</span>{' '}
              <span className="font-semibold">
                {item.quantityProduced}/{item.quantityToProduce}
              </span>
            </span>

            {item.quantityScrapped > 0 && (
              <span className="name-value-pair">
                <span className="text-muted-foreground">Scrap:</span>{' '}
                <span className="font-semibold text-red-600">{item.quantityScrapped}</span>
              </span>
            )}

            <span className="name-value-pair">
              <span className="text-muted-foreground">Steps:</span>{' '}
              <span className="font-semibold">
                {item.completedSteps}/{item.totalSteps}
              </span>
            </span>

            <span className="name-value-pair">
              <span className="text-muted-foreground">Age:</span>{' '}
              <span className="font-semibold">{formatRelativeTime(item.enteredQueueAt)}</span>
            </span>

            <span className="name-value-pair">
              <span className="text-muted-foreground">Facility:</span>{' '}
              <span className="font-semibold">{item.facilityName}</span>
            </span>
          </div>

          {/* Step progress bar (mini) */}
          {item.totalSteps > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {progressPct}%
              </span>
            </div>
          )}

          {/* Hold info */}
          {item.status === 'on_hold' && item.holdNotes && (
            <p className="mt-1 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
              {item.holdNotes}
            </p>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex flex-col items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {item.status === 'in_progress' && !item.isExpedited && onQuickExpedite && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 px-2"
              onClick={() => onQuickExpedite(item.workOrderId)}
              title="Expedite"
            >
              Rush
            </Button>
          )}
          {item.status === 'in_progress' && onQuickHold && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 px-2"
              onClick={() => onQuickHold(item.workOrderId)}
              title="Hold"
            >
              Hold
            </Button>
          )}
          {item.status === 'on_hold' && onQuickResume && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 px-2"
              onClick={() => onQuickResume(item.workOrderId)}
              title="Resume"
            >
              Resume
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
