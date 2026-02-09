import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────

export type ScanResultType = 'success' | 'error' | 'warning' | 'info' | 'queued';

export interface ScanResultData {
  type: ScanResultType;
  title: string;
  message: string;
  /** Card ID that was scanned */
  cardId?: string;
  /** Current card stage (if available) */
  cardStage?: string;
  /** Loop type (e.g., procurement, production, transfer) */
  loopType?: string;
  /** Part ID (if available) */
  partId?: string;
  /** Error code from backend (e.g., CARD_NOT_FOUND) */
  errorCode?: string;
}

export interface ScanResultProps {
  /** The scan result data to display */
  result: ScanResultData;
  /** Called when the operator dismisses the result */
  onDismiss?: () => void;
  /** Called when the operator wants to retry a failed scan */
  onRetry?: () => void;
  /** Additional CSS classes */
  className?: string;
}

// ─── Style Mapping ──────────────────────────────────────────────────

const resultStyles: Record<ScanResultType, {
  badgeVariant: 'success' | 'destructive' | 'warning' | 'accent' | 'secondary';
  iconColor: string;
  borderClass: string;
}> = {
  success: {
    badgeVariant: 'success',
    iconColor: 'text-[hsl(var(--arda-success))]',
    borderClass: 'border-l-4 border-l-[hsl(var(--arda-success))]',
  },
  error: {
    badgeVariant: 'destructive',
    iconColor: 'text-destructive',
    borderClass: 'border-l-4 border-l-destructive',
  },
  warning: {
    badgeVariant: 'warning',
    iconColor: 'text-[hsl(var(--arda-warning))]',
    borderClass: 'border-l-4 border-l-[hsl(var(--arda-warning))]',
  },
  info: {
    badgeVariant: 'accent',
    iconColor: 'text-[hsl(var(--link))]',
    borderClass: 'border-l-4 border-l-[hsl(var(--link))]',
  },
  queued: {
    badgeVariant: 'warning',
    iconColor: 'text-[hsl(var(--arda-warning))]',
    borderClass: 'border-l-4 border-l-[hsl(var(--arda-warning))]',
  },
};

// ─── Icons ──────────────────────────────────────────────────────────

function SuccessIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
    </svg>
  );
}

function QueuedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

const iconMap: Record<ScanResultType, React.ComponentType<{ className?: string }>> = {
  success: SuccessIcon,
  error: ErrorIcon,
  warning: WarningIcon,
  info: InfoIcon,
  queued: QueuedIcon,
};

// ─── Scan Result Component ──────────────────────────────────────────

export function ScanResult({
  result,
  onDismiss,
  onRetry,
  className,
}: ScanResultProps) {
  const style = resultStyles[result.type];
  const Icon = iconMap[result.type];

  const showRetry = result.type === 'error' && onRetry;
  const showDetails = result.cardId || result.cardStage || result.loopType || result.partId;

  return (
    <Card className={cn(style.borderClass, className)}>
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          <Icon className={cn('h-6 w-6 shrink-0 mt-0.5', style.iconColor)} />
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-semibold">{result.title}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{result.message}</p>
          </div>
          {result.errorCode && (
            <Badge variant="outline" className="shrink-0 text-xs">
              {result.errorCode}
            </Badge>
          )}
        </div>
      </CardHeader>

      {showDetails && (
        <CardContent className="pb-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {result.cardId && (
              <span className="name-value-pair">
                <span className="text-muted-foreground">Card: </span>
                <span className="font-semibold text-card-foreground font-mono">
                  {result.cardId.slice(0, 8)}...
                </span>
              </span>
            )}
            {result.cardStage && (
              <span className="name-value-pair">
                <span className="text-muted-foreground">Stage: </span>
                <span className="font-semibold text-card-foreground">
                  {result.cardStage}
                </span>
              </span>
            )}
            {result.loopType && (
              <span className="name-value-pair">
                <span className="text-muted-foreground">Loop: </span>
                <span className="font-semibold text-card-foreground">
                  {result.loopType}
                </span>
              </span>
            )}
            {result.partId && (
              <span className="name-value-pair">
                <span className="text-muted-foreground">Part: </span>
                <span className="font-semibold text-card-foreground font-mono">
                  {result.partId.slice(0, 8)}...
                </span>
              </span>
            )}
          </div>
        </CardContent>
      )}

      <CardFooter className="gap-2 pt-2">
        {showRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
        {onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
          >
            {result.type === 'success' ? 'Scan Another' : 'Dismiss'}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
