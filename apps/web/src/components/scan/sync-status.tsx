import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────

export interface SyncStatusCounts {
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
  total: number;
}

export interface SyncStatusProps {
  /** Current queue status counts */
  counts: SyncStatusCounts;
  /** Whether the device is currently online */
  isOnline: boolean;
  /** Whether a replay is currently in progress */
  isReplaying?: boolean;
  /** Called when the operator taps the sync bar to see details */
  onViewDetails?: () => void;
  /** Called when the operator manually triggers a sync */
  onSync?: () => void;
  /** Called when the operator clears synced items */
  onClearSynced?: () => void;
  /** Additional CSS classes */
  className?: string;
}

// ─── Sync Status Bar Component ──────────────────────────────────────

export function SyncStatus({
  counts,
  isOnline,
  isReplaying = false,
  onViewDetails,
  onSync,
  onClearSynced,
  className,
}: SyncStatusProps) {
  // Don't render if queue is empty
  if (counts.total === 0) {
    return null;
  }

  const hasActionItems = counts.pending > 0 || counts.failed > 0 || counts.syncing > 0;

  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-md border px-3 py-2 text-xs',
        !isOnline && 'border-[hsl(var(--arda-warning)/0.3)] bg-[hsl(var(--arda-warning)/0.05)]',
        isOnline && hasActionItems && 'border-border bg-muted/50',
        isOnline && !hasActionItems && 'border-[hsl(var(--arda-success)/0.3)] bg-[hsl(var(--arda-success)/0.05)]',
        className,
      )}
      role="status"
      aria-label="Scan sync status"
    >
      {/* Status indicators */}
      <div className="flex items-center gap-3">
        {/* Online/Offline indicator */}
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'inline-block h-2 w-2 rounded-full',
              isOnline ? 'bg-[hsl(var(--arda-success))]' : 'bg-[hsl(var(--arda-warning))]',
            )}
          />
          <span className="text-muted-foreground">
            {isOnline ? 'Online' : 'Offline'}
          </span>
        </span>

        {/* Queue counts */}
        <div className="flex items-center gap-2">
          {counts.pending > 0 && (
            <Badge variant="warning" className="text-[10px] px-1.5 py-0">
              {counts.pending} pending
            </Badge>
          )}
          {counts.syncing > 0 && (
            <Badge variant="accent" className="text-[10px] px-1.5 py-0">
              <span className="mr-1 inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
              {counts.syncing} syncing
            </Badge>
          )}
          {counts.synced > 0 && (
            <Badge variant="success" className="text-[10px] px-1.5 py-0">
              {counts.synced} synced
            </Badge>
          )}
          {counts.failed > 0 && (
            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
              {counts.failed} failed
            </Badge>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1">
        {isOnline && counts.pending > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSync}
            disabled={isReplaying}
            className="h-6 px-2 text-xs"
          >
            {isReplaying ? (
              <span className="flex items-center gap-1">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Syncing
              </span>
            ) : (
              'Sync Now'
            )}
          </Button>
        )}

        {counts.synced > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearSynced}
            className="h-6 px-2 text-xs text-muted-foreground"
          >
            Clear
          </Button>
        )}

        {onViewDetails && counts.total > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onViewDetails}
            className="h-6 px-2 text-xs text-[hsl(var(--link))]"
          >
            Details
          </Button>
        )}
      </div>
    </div>
  );
}
