/**
 * WorkOrderDetail — Full work order execution panel
 *
 * Renders the complete view for a single work order including:
 * - Header with WO number, status, and primary actions
 * - Summary metrics (quantities, timestamps, priority)
 * - Routing step tracker with step-level actions
 * - Hold/resume/expedite/split/cancel actions
 *
 * This is the primary operator view for executing production work.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { WOStatusBadge } from './wo-status-badge';
import { RoutingStepTracker } from './routing-step-tracker';
import type {
  WorkOrderDetail as WorkOrderDetailType,
  WOStatus,
  WOHoldReason,
  RoutingStepStatus,
} from './types';

// ─── Hold Reason Labels ─────────────────────────────────────────────

const holdReasonOptions: { value: WOHoldReason; label: string }[] = [
  { value: 'material_shortage', label: 'Material Shortage' },
  { value: 'equipment_failure', label: 'Equipment Failure' },
  { value: 'quality_hold', label: 'Quality Hold' },
  { value: 'labor_unavailable', label: 'Labor Unavailable' },
  { value: 'other', label: 'Other' },
];

// ─── Helpers ────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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

// ─── Valid transitions for action button visibility ─────────────────

const WO_TRANSITIONS: Record<WOStatus, WOStatus[]> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

function canTransitionTo(from: WOStatus, to: WOStatus): boolean {
  return WO_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Sub-Components ─────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  subValue,
  className,
}: {
  label: string;
  value: string | number;
  subValue?: string;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-muted/30 px-3 py-2', className)}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
      {subValue && (
        <div className="text-xs text-muted-foreground">{subValue}</div>
      )}
    </div>
  );
}

// ─── Hold Dialog ────────────────────────────────────────────────────

function HoldDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (reason: WOHoldReason, notes: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = React.useState<WOHoldReason>('material_shortage');
  const [notes, setNotes] = React.useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <Card className="w-full max-w-md rounded-xl shadow-lg">
        <CardHeader>
          <CardTitle className="text-base">Place Work Order on Hold</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Hold Reason</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as WOHoldReason)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {holdReasonOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Notes (optional)</label>
            <Input
              placeholder="Additional details..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="default" onClick={() => onConfirm(reason, notes)}>
              Confirm Hold
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Split Dialog ───────────────────────────────────────────────────

function SplitDialog({
  remaining,
  onConfirm,
  onCancel,
}: {
  remaining: number;
  onConfirm: (quantity: number) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = React.useState<number>(Math.floor(remaining / 2));

  const isValid = qty > 0 && qty < remaining;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <Card className="w-full max-w-sm rounded-xl shadow-lg">
        <CardHeader>
          <CardTitle className="text-base">Split Work Order</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Split off a portion of the remaining {remaining} units into a new work order.
          </p>
          <div className="space-y-2">
            <label className="text-sm font-medium">Quantity for new WO</label>
            <Input
              type="number"
              min={1}
              max={remaining - 1}
              value={qty}
              onChange={(e) => setQty(parseInt(e.target.value) || 0)}
            />
            <p className="text-xs text-muted-foreground">
              Original WO will retain {remaining - qty} units
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" disabled={!isValid} onClick={() => onConfirm(qty)}>
              Split
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export interface WorkOrderDetailProps {
  workOrder: WorkOrderDetailType;
  loading?: boolean;
  onTransitionStatus?: (toStatus: WOStatus, options?: {
    holdReason?: WOHoldReason;
    holdNotes?: string;
    cancelReason?: string;
  }) => Promise<void>;
  onExpedite?: () => Promise<void>;
  onSplit?: (splitQuantity: number) => Promise<void>;
  onTransitionStep?: (stepId: string, toStatus: RoutingStepStatus, options?: {
    actualMinutes?: number;
    notes?: string;
  }) => Promise<void>;
  onClose?: () => void;
}

export function WorkOrderDetailPanel({
  workOrder: wo,
  loading,
  onTransitionStatus,
  onExpedite,
  onSplit,
  onTransitionStep,
  onClose,
}: WorkOrderDetailProps) {
  const [showHoldDialog, setShowHoldDialog] = React.useState(false);
  const [showSplitDialog, setShowSplitDialog] = React.useState(false);
  const [actionLoading, setActionLoading] = React.useState(false);

  const remaining = wo.quantityToProduce - wo.quantityProduced;
  const canSplit = remaining > 1 && wo.status !== 'completed' && wo.status !== 'cancelled';
  const isTerminal = wo.status === 'completed' || wo.status === 'cancelled';

  async function handleAction(fn: () => Promise<void>) {
    setActionLoading(true);
    try {
      await fn();
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <>
      <Card className="rounded-xl shadow-sm">
        {/* Header */}
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <CardTitle className="text-lg font-bold truncate">
                {wo.woNumber}
              </CardTitle>
              <WOStatusBadge
                status={wo.status}
                holdReason={wo.holdReason}
                isExpedited={wo.isExpedited}
                showDot
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Primary status actions */}
              {canTransitionTo(wo.status, 'in_progress') && wo.status === 'scheduled' && (
                <Button
                  size="sm"
                  variant="accent"
                  disabled={actionLoading}
                  onClick={() =>
                    handleAction(() => onTransitionStatus?.('in_progress') ?? Promise.resolve())
                  }
                >
                  Start
                </Button>
              )}
              {canTransitionTo(wo.status, 'in_progress') && wo.status === 'on_hold' && (
                <Button
                  size="sm"
                  variant="accent"
                  disabled={actionLoading}
                  onClick={() =>
                    handleAction(() => onTransitionStatus?.('in_progress') ?? Promise.resolve())
                  }
                >
                  Resume
                </Button>
              )}
              {canTransitionTo(wo.status, 'scheduled') && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionLoading}
                  onClick={() =>
                    handleAction(() => onTransitionStatus?.('scheduled') ?? Promise.resolve())
                  }
                >
                  Schedule
                </Button>
              )}
              {canTransitionTo(wo.status, 'on_hold') && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionLoading}
                  onClick={() => setShowHoldDialog(true)}
                >
                  Hold
                </Button>
              )}
              {canTransitionTo(wo.status, 'completed') && (
                <Button
                  size="sm"
                  disabled={actionLoading}
                  onClick={() =>
                    handleAction(() => onTransitionStatus?.('completed') ?? Promise.resolve())
                  }
                >
                  Complete
                </Button>
              )}
              {!wo.isExpedited && !isTerminal && onExpedite && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={actionLoading}
                  onClick={() => handleAction(() => onExpedite())}
                >
                  Expedite
                </Button>
              )}
              {onClose && (
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Close
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Part info */}
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{wo.partNumber}</span>
            <span className="text-muted-foreground">{wo.partName}</span>
            {wo.isRework && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                REWORK
              </span>
            )}
            {wo.parentWorkOrderId && (
              <Badge variant="secondary" className="text-[10px]">Split from parent</Badge>
            )}
          </div>

          {/* Metric cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <MetricCard
              label="Quantity"
              value={`${wo.quantityProduced}/${wo.quantityToProduce}`}
              subValue={`${remaining} remaining`}
            />
            <MetricCard
              label="Scrap"
              value={wo.quantityScrapped}
              className={wo.quantityScrapped > 0 ? 'border-red-200' : undefined}
            />
            <MetricCard
              label="Priority"
              value={wo.priorityScore.toFixed(0)}
              subValue={wo.isExpedited ? 'EXPEDITED' : `Manual: ${wo.manualPriority}`}
            />
            <MetricCard
              label="Steps"
              value={`${wo.completedSteps}/${wo.totalSteps}`}
              subValue={
                wo.totalSteps > 0
                  ? `${Math.round((wo.completedSteps / wo.totalSteps) * 100)}% complete`
                  : 'No steps'
              }
            />
          </div>

          {/* Timestamps */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span className="name-value-pair">
              <span className="text-muted-foreground">Entered Queue:</span>{' '}
              <span className="font-semibold">{formatRelativeTime(wo.enteredQueueAt)}</span>
            </span>
            <span className="name-value-pair">
              <span className="text-muted-foreground">Started:</span>{' '}
              <span className="font-semibold">{formatDate(wo.startedAt)}</span>
            </span>
            {wo.scheduledStartDate && (
              <span className="name-value-pair">
                <span className="text-muted-foreground">Scheduled:</span>{' '}
                <span className="font-semibold">{formatDate(wo.scheduledStartDate)}</span>
              </span>
            )}
            {wo.completedAt && (
              <span className="name-value-pair">
                <span className="text-muted-foreground">Completed:</span>{' '}
                <span className="font-semibold">{formatDate(wo.completedAt)}</span>
              </span>
            )}
            <span className="name-value-pair">
              <span className="text-muted-foreground">Facility:</span>{' '}
              <span className="font-semibold">{wo.facilityName}</span>
            </span>
          </div>

          {/* Hold info */}
          {wo.status === 'on_hold' && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="text-sm font-medium text-amber-800">
                On Hold: {wo.holdReason?.replace(/_/g, ' ') || 'Unknown reason'}
              </div>
              {wo.holdNotes && (
                <p className="mt-1 text-xs text-amber-700">{wo.holdNotes}</p>
              )}
            </div>
          )}

          {/* Cancel info */}
          {wo.status === 'cancelled' && wo.cancelReason && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <div className="text-sm font-medium text-red-800">Cancellation Reason</div>
              <p className="mt-1 text-xs text-red-700">{wo.cancelReason}</p>
            </div>
          )}

          <Separator />

          {/* Routing Steps */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Routing Steps</h3>
              {canSplit && onSplit && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => setShowSplitDialog(true)}
                >
                  Split WO
                </Button>
              )}
            </div>
            <RoutingStepTracker
              steps={wo.steps}
              showProgressBar
              onTransitionStep={
                onTransitionStep && !isTerminal
                  ? (stepId, toStatus, opts) => onTransitionStep(stepId, toStatus, opts)
                  : undefined
              }
            />
          </div>

          {/* Cancel action (always available for non-terminal) */}
          {canTransitionTo(wo.status, 'cancelled') && (
            <>
              <Separator />
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-destructive hover:text-destructive"
                  disabled={actionLoading}
                  onClick={() =>
                    handleAction(
                      () =>
                        onTransitionStatus?.('cancelled', {
                          cancelReason: 'Cancelled from work order detail',
                        }) ?? Promise.resolve()
                    )
                  }
                >
                  Cancel Work Order
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      {showHoldDialog && (
        <HoldDialog
          onConfirm={(reason, notes) => {
            setShowHoldDialog(false);
            handleAction(
              () =>
                onTransitionStatus?.('on_hold', {
                  holdReason: reason,
                  holdNotes: notes,
                }) ?? Promise.resolve()
            );
          }}
          onCancel={() => setShowHoldDialog(false)}
        />
      )}

      {showSplitDialog && (
        <SplitDialog
          remaining={remaining}
          onConfirm={(qty) => {
            setShowSplitDialog(false);
            handleAction(() => onSplit?.(qty) ?? Promise.resolve());
          }}
          onCancel={() => setShowSplitDialog(false)}
        />
      )}
    </>
  );
}
