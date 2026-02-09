import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────

export type ConflictType =
  | 'already_transitioned'
  | 'stale_state'
  | 'invalid_card'
  | 'network_error';

export type ConflictAction = 'retry' | 'discard' | 'escalate';

export interface ScanConflict {
  /** Queue item ID */
  queueItemId: string;
  /** Card ID that was scanned */
  cardId: string;
  /** Type of conflict */
  conflictType: ConflictType;
  /** Human-readable description */
  message: string;
  /** Backend error code (if available) */
  errorCode?: string;
  /** Timestamp when the scan was originally captured */
  scannedAt: string;
  /** Number of retry attempts */
  retryCount: number;
}

export interface ConflictResolverProps {
  /** The conflict to resolve */
  conflict: ScanConflict;
  /** Called when the operator selects a resolution action */
  onResolve: (queueItemId: string, action: ConflictAction) => void;
  /** Whether an action is currently being processed */
  isProcessing?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// ─── Conflict Metadata ──────────────────────────────────────────────

const conflictMeta: Record<ConflictType, {
  label: string;
  badgeVariant: 'warning' | 'destructive' | 'accent';
  description: string;
  availableActions: ConflictAction[];
}> = {
  already_transitioned: {
    label: 'Already Triggered',
    badgeVariant: 'warning',
    description: 'This card has already been triggered by another scan. The queued scan is now redundant.',
    availableActions: ['discard', 'escalate'],
  },
  stale_state: {
    label: 'Stale State',
    badgeVariant: 'warning',
    description: 'The card has moved to a different stage since this scan was queued. The transition is no longer valid.',
    availableActions: ['discard', 'escalate'],
  },
  invalid_card: {
    label: 'Invalid Card',
    badgeVariant: 'destructive',
    description: 'The card was not found or has been deactivated. This QR code may be invalid.',
    availableActions: ['discard'],
  },
  network_error: {
    label: 'Network Error',
    badgeVariant: 'accent',
    description: 'The scan could not be sent due to a network problem. You can retry when connectivity is restored.',
    availableActions: ['retry', 'discard'],
  },
};

/** Map backend error codes to conflict types */
export function errorCodeToConflictType(errorCode?: string): ConflictType {
  switch (errorCode) {
    case 'CARD_ALREADY_TRIGGERED':
      return 'already_transitioned';
    case 'INVALID_TRANSITION':
    case 'LOOP_TYPE_INCOMPATIBLE':
    case 'ROLE_NOT_ALLOWED':
    case 'METHOD_NOT_ALLOWED':
      return 'stale_state';
    case 'CARD_NOT_FOUND':
    case 'CARD_INACTIVE':
    case 'TENANT_MISMATCH':
      return 'invalid_card';
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
    default:
      return 'network_error';
  }
}

// ─── Action Labels ──────────────────────────────────────────────────

const actionLabels: Record<ConflictAction, { label: string; variant: 'default' | 'outline' | 'ghost' }> = {
  retry: { label: 'Retry', variant: 'default' },
  discard: { label: 'Discard', variant: 'outline' },
  escalate: { label: 'Escalate', variant: 'ghost' },
};

// ─── Conflict Resolver Component ────────────────────────────────────

export function ConflictResolver({
  conflict,
  onResolve,
  isProcessing = false,
  className,
}: ConflictResolverProps) {
  const meta = conflictMeta[conflict.conflictType];
  const scannedDate = new Date(conflict.scannedAt);

  return (
    <Card className={cn('border-l-4 border-l-[hsl(var(--arda-warning))]', className)}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <svg
              className="h-5 w-5 shrink-0 text-[hsl(var(--arda-warning))]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
            <CardTitle className="text-sm font-semibold">Sync Conflict</CardTitle>
          </div>
          <Badge variant={meta.badgeVariant} className="shrink-0">
            {meta.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="pb-2">
        <p className="text-sm text-muted-foreground">{meta.description}</p>

        {/* Conflict details */}
        <div className="mt-3 flex flex-col gap-1 text-xs">
          <div className="name-value-pair">
            <span className="text-muted-foreground">Card: </span>
            <span className="font-semibold text-card-foreground font-mono">
              {conflict.cardId.slice(0, 8)}...
            </span>
          </div>
          <div className="name-value-pair">
            <span className="text-muted-foreground">Scanned: </span>
            <span className="font-semibold text-card-foreground">
              {scannedDate.toLocaleString()}
            </span>
          </div>
          {conflict.retryCount > 0 && (
            <div className="name-value-pair">
              <span className="text-muted-foreground">Retries: </span>
              <span className="font-semibold text-card-foreground">
                {conflict.retryCount}
              </span>
            </div>
          )}
          {conflict.errorCode && (
            <div className="name-value-pair">
              <span className="text-muted-foreground">Error: </span>
              <span className="font-semibold text-card-foreground font-mono">
                {conflict.errorCode}
              </span>
            </div>
          )}
          {conflict.message && conflict.message !== meta.description && (
            <div className="name-value-pair">
              <span className="text-muted-foreground">Detail: </span>
              <span className="font-semibold text-card-foreground">
                {conflict.message}
              </span>
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="gap-2 pt-2">
        {meta.availableActions.map((action) => {
          const { label, variant } = actionLabels[action];
          return (
            <Button
              key={action}
              variant={variant}
              size="sm"
              onClick={() => onResolve(conflict.queueItemId, action)}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <span className="flex items-center gap-1">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Processing
                </span>
              ) : (
                label
              )}
            </Button>
          );
        })}
      </CardFooter>
    </Card>
  );
}
