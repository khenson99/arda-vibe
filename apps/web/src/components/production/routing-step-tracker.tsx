/**
 * RoutingStepTracker — Visual step progression for work order routing
 *
 * Renders a horizontal or vertical timeline of routing steps with
 * status indicators, work center info, and action buttons for
 * transitioning steps (start, complete, skip, hold).
 *
 * Enforces sequential execution: step N cannot start until step N-1
 * is complete or skipped.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { StepStatusBadge } from './wo-status-badge';
import type { RoutingStep, RoutingStepStatus } from './types';

// ─── Helpers ────────────────────────────────────────────────────────

function formatDuration(minutes: number | null): string {
  if (minutes === null) return '--';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function canTransitionTo(
  currentStatus: RoutingStepStatus,
  target: RoutingStepStatus
): boolean {
  const transitions: Record<RoutingStepStatus, RoutingStepStatus[]> = {
    pending: ['in_progress', 'skipped'],
    in_progress: ['complete', 'on_hold', 'skipped'],
    complete: [],
    on_hold: ['in_progress'],
    skipped: [],
  };
  return transitions[currentStatus].includes(target);
}

function isStepActionable(step: RoutingStep, allSteps: RoutingStep[]): boolean {
  // Terminal states are never actionable
  if (step.status === 'complete' || step.status === 'skipped') return false;

  // on_hold steps can always resume
  if (step.status === 'on_hold') return true;

  // in_progress steps can always act
  if (step.status === 'in_progress') return true;

  // pending steps: check if previous step is done (sequential enforcement)
  if (step.status === 'pending') {
    if (step.stepNumber === 1) return true;
    const prevStep = allSteps.find((s) => s.stepNumber === step.stepNumber - 1);
    if (!prevStep) return true;
    return prevStep.status === 'complete' || prevStep.status === 'skipped';
  }

  return false;
}

// ─── Step Row ───────────────────────────────────────────────────────

interface StepRowProps {
  step: RoutingStep;
  isActionable: boolean;
  isLast: boolean;
  onTransition?: (stepId: string, toStatus: RoutingStepStatus, options?: {
    actualMinutes?: number;
    notes?: string;
  }) => void;
}

function StepRow({ step, isActionable, isLast, onTransition }: StepRowProps) {
  const isActive = step.status === 'in_progress';
  const isDone = step.status === 'complete' || step.status === 'skipped';

  return (
    <div className="flex gap-3">
      {/* Timeline column */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-semibold',
            isActive && 'border-[hsl(var(--arda-blue))] bg-[hsl(var(--arda-blue)/0.1)] text-[hsl(var(--arda-blue))]',
            isDone && 'border-emerald-500 bg-emerald-50 text-emerald-700',
            step.status === 'on_hold' && 'border-amber-500 bg-amber-50 text-amber-700',
            step.status === 'pending' && 'border-border bg-muted text-muted-foreground'
          )}
        >
          {step.stepNumber}
        </div>
        {!isLast && (
          <div
            className={cn(
              'w-0.5 flex-1 min-h-[24px]',
              isDone ? 'bg-emerald-300' : 'bg-border'
            )}
          />
        )}
      </div>

      {/* Content column */}
      <div className={cn('flex-1 pb-4', isLast && 'pb-0')}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{step.operationName}</span>
              <StepStatusBadge status={step.status} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              <span className="name-value-pair">
                <span className="text-muted-foreground">WC:</span>{' '}
                <span className="font-semibold">{step.workCenterCode}</span>
              </span>
              <span className="name-value-pair">
                <span className="text-muted-foreground">Est:</span>{' '}
                <span className="font-semibold">{formatDuration(step.estimatedMinutes)}</span>
              </span>
              {step.actualMinutes !== null && (
                <span className="name-value-pair">
                  <span className="text-muted-foreground">Act:</span>{' '}
                  <span className={cn(
                    'font-semibold',
                    step.estimatedMinutes !== null &&
                      step.actualMinutes > step.estimatedMinutes * 1.2 &&
                      'text-red-600'
                  )}>
                    {formatDuration(step.actualMinutes)}
                  </span>
                </span>
              )}
            </div>
            {step.notes && (
              <p className="mt-1 text-xs text-muted-foreground italic">{step.notes}</p>
            )}
          </div>

          {/* Action buttons */}
          {isActionable && onTransition && (
            <div className="flex items-center gap-1 shrink-0">
              {step.status === 'pending' && (
                <>
                  <Button
                    size="sm"
                    variant="accent"
                    className="text-xs"
                    onClick={() => onTransition(step.id, 'in_progress')}
                  >
                    Start
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => onTransition(step.id, 'skipped')}
                  >
                    Skip
                  </Button>
                </>
              )}
              {step.status === 'in_progress' && (
                <>
                  <Button
                    size="sm"
                    className="text-xs"
                    onClick={() => onTransition(step.id, 'complete')}
                  >
                    Complete
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs"
                    onClick={() => onTransition(step.id, 'on_hold')}
                  >
                    Hold
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => onTransition(step.id, 'skipped')}
                  >
                    Skip
                  </Button>
                </>
              )}
              {step.status === 'on_hold' && (
                <Button
                  size="sm"
                  variant="accent"
                  className="text-xs"
                  onClick={() => onTransition(step.id, 'in_progress')}
                >
                  Resume
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Progress Bar ───────────────────────────────────────────────────

function StepProgressBar({ steps }: { steps: RoutingStep[] }) {
  const total = steps.length;
  if (total === 0) return null;

  const completed = steps.filter(
    (s) => s.status === 'complete' || s.status === 'skipped'
  ).length;
  const inProgress = steps.filter((s) => s.status === 'in_progress').length;
  const pctDone = Math.round((completed / total) * 100);
  const pctActive = Math.round((inProgress / total) * 100);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {completed}/{total} steps complete
        </span>
        <span>{pctDone}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div className="flex h-full">
          <div
            className="bg-emerald-500 transition-all duration-300"
            style={{ width: `${pctDone}%` }}
          />
          <div
            className="bg-[hsl(var(--arda-blue))] transition-all duration-300"
            style={{ width: `${pctActive}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export interface RoutingStepTrackerProps {
  steps: RoutingStep[];
  showProgressBar?: boolean;
  onTransitionStep?: (stepId: string, toStatus: RoutingStepStatus, options?: {
    actualMinutes?: number;
    notes?: string;
  }) => void;
  className?: string;
}

export function RoutingStepTracker({
  steps,
  showProgressBar = true,
  onTransitionStep,
  className,
}: RoutingStepTrackerProps) {
  const sorted = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);

  if (sorted.length === 0) {
    return (
      <div className={cn('text-sm text-muted-foreground py-4 text-center', className)}>
        No routing steps defined. Apply a routing template to add steps.
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {showProgressBar && <StepProgressBar steps={sorted} />}

      <div className="space-y-0">
        {sorted.map((step, idx) => (
          <StepRow
            key={step.id}
            step={step}
            isActionable={isStepActionable(step, sorted)}
            isLast={idx === sorted.length - 1}
            onTransition={onTransitionStep}
          />
        ))}
      </div>
    </div>
  );
}
