import * as React from 'react';
import { ChevronDown, Loader2, Printer, ShoppingCart } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Skeleton } from '@/components/ui';
import { StageProgress } from '@/components/stage-progress';
import { ErrorBanner } from '@/components/error-banner';
import { NextActionBanner } from '@/components/next-action-banner';
import { useWorkspaceData } from '@/hooks/use-workspace-data';
import type { AppShellOutletContext, HeaderOption } from '@/layouts/app-shell';
import { createPrintJob, createPurchaseOrderFromCards, parseApiError } from '@/lib/api-client';
import { formatRelativeTime, formatStatus, queueAgingHours } from '@/lib/formatters';
import { getPartLinkIds, normalizePartLinkId } from '@/lib/part-linking';
import { cn } from '@/lib/utils';
import type { AuthSession, PartRecord, QueueCard, QueueByLoop } from '@/types';
import { LOOP_ORDER, LOOP_META } from '@/types';
import type { LoopType } from '@/types';

/* ── Expanded card detail panel ─────────────────────────────────────── */

function ExpandedCardPanel({
  card,
  part,
  session,
}: {
  card: QueueCard;
  part: PartRecord | undefined;
  session: AuthSession;
}) {
  const [isPrinting, setIsPrinting] = React.useState(false);
  const [isOrdering, setIsOrdering] = React.useState(false);

  const handlePrint = React.useCallback(async () => {
    setIsPrinting(true);
    try {
      await createPrintJob(session.tokens.accessToken, { cardIds: [card.id] });
      toast.success('Print job queued');
    } catch (err) {
      toast.error(parseApiError(err));
    } finally {
      setIsPrinting(false);
    }
  }, [card.id, session.tokens.accessToken]);

  const handleCreateOrder = React.useCallback(async () => {
    setIsOrdering(true);
    try {
      const result = await createPurchaseOrderFromCards(session.tokens.accessToken, {
        cardIds: [card.id],
      });
      toast.success(`Purchase order ${result.poNumber} created`);
    } catch (err) {
      toast.error(parseApiError(err));
    } finally {
      setIsOrdering(false);
    }
  }, [card.id, session.tokens.accessToken]);

  return (
    <div className="space-y-3 border-t border-border pt-3">
      {/* Stage progress */}
      <StageProgress currentStage={card.currentStage} />

      {/* Part details (when we can resolve the part record) */}
      {part && (
        <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Part Details
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div className="name-value-pair">
              <span className="name-value-pair-label">Name:</span>
              <span className="name-value-pair-value truncate">{part.name}</span>
            </div>
            <div className="name-value-pair">
              <span className="name-value-pair-label">Supplier:</span>
              <span className="name-value-pair-value truncate">{part.primarySupplier || '—'}</span>
            </div>
            <div className="name-value-pair">
              <span className="name-value-pair-label">Location:</span>
              <span className="name-value-pair-value truncate">{part.location || '—'}</span>
            </div>
            <div className="name-value-pair">
              <span className="name-value-pair-label">Method:</span>
              <span className="name-value-pair-value truncate">
                {formatStatus(part.orderMechanism)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="accent"
          className="h-7 gap-1.5 text-xs"
          disabled={isOrdering}
          onClick={() => void handleCreateOrder()}
        >
          {isOrdering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShoppingCart className="h-3.5 w-3.5" />
          )}
          Create Order
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          disabled={isPrinting}
          onClick={() => void handlePrint()}
        >
          {isPrinting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Printer className="h-3.5 w-3.5" />
          )}
          Print Label
        </Button>
      </div>
    </div>
  );
}

/* ── Single queue card ──────────────────────────────────────────────── */

const QueueCardItem = React.memo(function QueueCardItem({
  card,
  part,
  session,
}: {
  card: QueueCard;
  part: PartRecord | undefined;
  session: AuthSession;
}) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const ageHours = queueAgingHours(card);
  const highRisk = ageHours >= 24;

  const partName = part?.name ?? `Part ${card.partId.slice(0, 8)}...`;

  return (
    <article
      className={cn(
        'card-order-item transition-shadow',
        isExpanded && 'ring-1 ring-[hsl(var(--link)/0.3)] shadow-md',
      )}
    >
      {/* Clickable header */}
      <button
        type="button"
        className="flex w-full items-start justify-between gap-2 text-left"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} card #${card.cardNumber}`}
      >
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">
            <span className="link-arda">Card #{card.cardNumber}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">{partName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant={highRisk ? 'warning' : 'secondary'}>{ageHours}h</Badge>
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform duration-200',
              isExpanded && 'rotate-180',
            )}
          />
        </div>
      </button>

      {/* Summary row (always visible) */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span>
          <span className="text-muted-foreground">Qty:</span>{' '}
          <span className="font-semibold">{card.orderQuantity}</span>
        </span>
        <span>
          <span className="text-muted-foreground">Min:</span>{' '}
          <span className="font-semibold">{card.minQuantity}</span>
        </span>
        <span>
          <span className="text-muted-foreground">Stage:</span>{' '}
          <Badge variant="accent" className="ml-0.5 text-[10px]">
            {formatStatus(card.currentStage)}
          </Badge>
        </span>
        <span className="ml-auto text-muted-foreground">
          {formatRelativeTime(card.currentStageEnteredAt)}
        </span>
      </div>

      {/* Expandable detail panel */}
      {isExpanded && <ExpandedCardPanel card={card} part={part} session={session} />}
    </article>
  );
});

/* ── Sort helpers ───────────────────────────────────────────────────── */

type QueueSortKey = 'age' | 'cardNumber' | 'stage' | 'quantity';

const STAGE_ORDER: Record<string, number> = {
  created: 0,
  triggered: 1,
  ordered: 2,
  in_transit: 3,
  received: 4,
  restocked: 5,
};

function makeSortFn(sortKey: QueueSortKey) {
  return (a: QueueCard, b: QueueCard): number => {
    switch (sortKey) {
      case 'age':
        return (
          new Date(a.currentStageEnteredAt).getTime() - new Date(b.currentStageEnteredAt).getTime()
        );
      case 'cardNumber':
        return a.cardNumber - b.cardNumber;
      case 'stage':
        return (STAGE_ORDER[a.currentStage] ?? 99) - (STAGE_ORDER[b.currentStage] ?? 99);
      case 'quantity':
        return (b.orderQuantity ?? 0) - (a.orderQuantity ?? 0);
      default:
        return 0;
    }
  };
}

const QUEUE_SORT_OPTIONS: HeaderOption[] = [
  { value: 'age', label: 'Oldest first' },
  { value: 'cardNumber', label: 'Card #' },
  { value: 'stage', label: 'Stage' },
  { value: 'quantity', label: 'Qty (high→low)' },
];

/* ── Queue route ────────────────────────────────────────────────────── */

export function QueueRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const { setQueueHeaderControls } = useOutletContext<AppShellOutletContext>();
  const { isLoading, isRefreshing, error, queueSummary, queueByLoop, parts, refreshQueueOnly } =
    useWorkspaceData(session.tokens.accessToken, onUnauthorized);

  const [activeLoopFilter, setActiveLoopFilter] = React.useState<LoopType | 'all'>('all');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [sortKey, setSortKey] = React.useState<QueueSortKey>('age');
  const queueScopeOptions = React.useMemo<HeaderOption[]>(
    () => [
      { value: 'all', label: 'All loops' },
      ...LOOP_ORDER.map((loopType) => ({
        value: loopType,
        label: LOOP_META[loopType].label,
      })),
    ],
    [],
  );
  const handleScopeChange = React.useCallback((nextScope: string) => {
    setActiveLoopFilter(nextScope as LoopType | 'all');
  }, []);
  const handleSortChange = React.useCallback((nextSortKey: string) => {
    setSortKey(nextSortKey as QueueSortKey);
  }, []);
  const handleRefresh = React.useCallback(() => {
    void refreshQueueOnly();
  }, [refreshQueueOnly]);

  React.useEffect(() => {
    setQueueHeaderControls({
      query: searchTerm,
      onQueryChange: setSearchTerm,
      queryPlaceholder: 'Find by card number, part name, or loop',
      scope: activeLoopFilter,
      onScopeChange: handleScopeChange,
      scopeOptions: queueScopeOptions,
      sortKey,
      onSortKeyChange: handleSortChange,
      sortOptions: QUEUE_SORT_OPTIONS,
      onRefresh: handleRefresh,
      isRefreshing,
    });

    return () => {
      setQueueHeaderControls(null);
    };
  }, [
    setQueueHeaderControls,
    searchTerm,
    activeLoopFilter,
    handleScopeChange,
    queueScopeOptions,
    sortKey,
    handleSortChange,
    handleRefresh,
    isRefreshing,
  ]);

  // Build part lookup by ID so expanded cards can show rich part data
  const partById = React.useMemo(() => {
    const map = new Map<string, PartRecord>();
    for (const part of parts) {
      for (const linkId of getPartLinkIds(part)) {
        if (!map.has(linkId)) {
          map.set(linkId, part);
        }
      }
    }
    return map;
  }, [parts]);

  const resolvePartByCardPartId = React.useCallback(
    (partId: string) => {
      const normalizedCardPartId = normalizePartLinkId(partId);
      return normalizedCardPartId ? partById.get(normalizedCardPartId) : undefined;
    },
    [partById],
  );

  const loopsToRender = activeLoopFilter === 'all' ? LOOP_ORDER : [activeLoopFilter];

  const filteredQueue = React.useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    const matchesSearch = (card: QueueCard) => {
      if (!normalizedSearch) return true;

      // Also search against the resolved part name
      const part = resolvePartByCardPartId(card.partId);
      const partName = part?.name?.toLowerCase() ?? '';

      return (
        card.id.toLowerCase().includes(normalizedSearch) ||
        card.partId.toLowerCase().includes(normalizedSearch) ||
        card.loopId.toLowerCase().includes(normalizedSearch) ||
        String(card.cardNumber).includes(normalizedSearch) ||
        partName.includes(normalizedSearch)
      );
    };

    const sortFn = makeSortFn(sortKey);

    return {
      procurement: queueByLoop.procurement.filter(matchesSearch).sort(sortFn),
      production: queueByLoop.production.filter(matchesSearch).sort(sortFn),
      transfer: queueByLoop.transfer.filter(matchesSearch).sort(sortFn),
    } satisfies QueueByLoop;
  }, [queueByLoop, searchTerm, resolvePartByCardPartId, sortKey]);

  if (isLoading) {
    return (
      <div className="space-y-5">
        {/* Three loop columns skeleton */}
        <div className="grid gap-4 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border/50 bg-muted/20 p-3">
              <Skeleton className="mb-3 h-16 w-full rounded-xl" />
              {Array.from({ length: 3 }).map((_, j) => (
                <Skeleton key={j} className="mb-2 h-20 w-full rounded-xl" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} onRetry={refreshQueueOnly} />}

      <NextActionBanner queueSummary={queueSummary} queueByLoop={queueByLoop} />

      <div className="grid gap-4 xl:grid-cols-3">
        {loopsToRender.map((loopType) => {
          const cards = filteredQueue[loopType];
          const Icon = LOOP_META[loopType].icon;

          return (
            <section
              key={loopType}
              className="rounded-2xl border border-[hsl(var(--arda-blue)/0.25)] bg-[hsl(var(--arda-blue)/0.07)] p-3"
            >
              <header className="mb-3 rounded-xl bg-card px-3 py-3 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Icon className="h-4 w-4 text-accent" />
                    {LOOP_META[loopType].label}
                  </h3>
                  <Badge variant="accent">{cards.length}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {queueSummary?.byLoopType[loopType] ?? cards.length} cards awaiting action
                </p>
              </header>

              <div className="space-y-2">
                {cards.length === 0 && (
                  <div className="rounded-xl border border-dashed border-border bg-card px-3 py-8 text-center text-sm text-muted-foreground">
                    No cards for this filter.
                  </div>
                )}

                {cards.map((card) => (
                  <QueueCardItem
                    key={card.id}
                    card={card}
                    part={resolvePartByCardPartId(card.partId)}
                    session={session}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
