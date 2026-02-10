import * as React from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Loader2,
  MessageSquare,
  Plus,
  Printer,
  RefreshCw,
  Search,
  ShoppingCart,
} from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui";
import { EditableCell, PaginationBar, ColumnConfig } from "@/components/data-table";
import { ErrorBanner } from "@/components/error-banner";
import { NextActionBanner } from "@/components/next-action-banner";
import { useWorkspaceData } from "@/hooks/use-workspace-data";
import {
  createPrintJob,
  createPurchaseOrderFromCards,
  normalizeOptionalString,
  parseApiError,
  toItemsInputPayload,
  updateItemRecord,
} from "@/lib/api-client";
import {
  formatDateTime,
  formatMoney,
  formatNumericValue,
  formatReadableLabel,
  formatStatus,
} from "@/lib/formatters";
import { ITEMS_PAGE_SIZE_STORAGE_KEY, ITEMS_VISIBLE_COLUMNS_STORAGE_KEY } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { AuthSession, InlineEditableField, ItemTableColumnKey, LoopType, PartRecord } from "@/types";
import {
  ITEMS_PAGE_SIZE_OPTIONS,
  ITEM_TABLE_COLUMNS,
  ITEM_TABLE_COLUMN_KEYS,
  ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS,
  LOOP_META,
  LOOP_ORDER,
} from "@/types";

/* ── Inline edit commit factory ─────────────────────────────── */

function buildCommitHandler(
  part: PartRecord,
  field: InlineEditableField,
  session: AuthSession,
  onOptimisticUpdate: (partId: string, patch: Partial<PartRecord>) => void,
): (nextValue: string) => Promise<void> {
  return async (nextValue: string) => {
    const rawValue = nextValue.trim();
    const payloadPatch: Partial<import("@/types").ItemsServiceInputPayload> = {};
    const localPatch: Partial<PartRecord> = {};

    if (field === "supplier") {
      if (!rawValue) throw new Error("Supplier is required.");
      payloadPatch.primarySupplier = rawValue;
      localPatch.primarySupplier = rawValue;
    }

    if (field === "orderQuantity") {
      if (!rawValue) {
        payloadPatch.orderQty = null;
        localPatch.orderQty = null;
      } else {
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed) || parsed < 0)
          throw new Error("Order quantity must be a whole number >= 0.");
        payloadPatch.orderQty = parsed;
        localPatch.orderQty = parsed;
      }
    }

    if (field === "orderUnits") {
      const normalized = normalizeOptionalString(rawValue);
      payloadPatch.orderQtyUnit = normalized;
      localPatch.orderQtyUnit = normalized;
    }

    if (field === "minQuantity") {
      if (!rawValue) throw new Error("Min quantity is required.");
      const parsed = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(parsed) || parsed < 0)
        throw new Error("Min quantity must be a whole number >= 0.");
      payloadPatch.minQty = parsed;
      localPatch.minQty = parsed;
    }

    if (field === "minUnits") {
      if (!rawValue) throw new Error("Min units is required.");
      payloadPatch.minQtyUnit = rawValue;
      localPatch.minQtyUnit = rawValue;
    }

    if (field === "orderMethod") {
      if (!rawValue) throw new Error("Order method is required.");
      payloadPatch.orderMechanism = rawValue;
      localPatch.orderMechanism = rawValue;
      localPatch.type = rawValue;
    }

    if (field === "location") {
      const normalized = normalizeOptionalString(rawValue);
      payloadPatch.location = normalized;
      localPatch.location = normalized;
    }

    const entityId = part.eId;
    if (!entityId) {
      throw new Error("Inline editing requires item IDs. Refresh and try again.");
    }

    const author = normalizeOptionalString(session.user.email) || session.user.id;
    const payload = {
      ...toItemsInputPayload(part),
      ...payloadPatch,
    };

    await updateItemRecord(session.tokens.accessToken, {
      entityId,
      tenantId: session.user.tenantId,
      author,
      payload,
    });

    // Optimistic local update on success
    onOptimisticUpdate(part.id, localPatch);
    toast.success(`${ITEM_TABLE_COLUMNS.find((c) => c.key === field)?.label ?? field} updated`);
  };
}

/* ── PartsRoute ─────────────────────────────────────────────── */

export function PartsRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const { isLoading, isRefreshing, error, queueSummary, queueByLoop, parts, partCount, orderLineByItem, refreshAll } =
    useWorkspaceData(session.tokens.accessToken, onUnauthorized);

  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [activeTab, setActiveTab] = React.useState<"published" | "recentlyImported">("published");
  const [pageSize, setPageSize] = React.useState<number>(() => {
    if (typeof window === "undefined") return 50;
    const raw = window.localStorage.getItem(ITEMS_PAGE_SIZE_STORAGE_KEY);
    const parsed = Number(raw);
    return ITEMS_PAGE_SIZE_OPTIONS.includes(parsed as (typeof ITEMS_PAGE_SIZE_OPTIONS)[number]) ? parsed : 50;
  });
  const [visibleColumns, setVisibleColumns] = React.useState<ItemTableColumnKey[]>(() => {
    if (typeof window === "undefined") {
      return [...ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS];
    }

    const requiredColumns = new Set<ItemTableColumnKey>(
      ITEM_TABLE_COLUMNS.filter((column) => column.required).map((column) => column.key),
    );

    try {
      const raw = window.localStorage.getItem(ITEMS_VISIBLE_COLUMNS_STORAGE_KEY);
      if (!raw) {
        return [...ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS];
      }

      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [...ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS];
      }

      const nextVisible = new Set<ItemTableColumnKey>();
      for (const value of parsed) {
        if (typeof value !== "string") continue;
        if ((ITEM_TABLE_COLUMN_KEYS as readonly string[]).includes(value)) {
          nextVisible.add(value as ItemTableColumnKey);
        }
      }

      if (nextVisible.size === 0) {
        return [...ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS];
      }

      for (const required of requiredColumns) {
        nextVisible.add(required);
      }

      return ITEM_TABLE_COLUMN_KEYS.filter((columnKey) =>
        nextVisible.has(columnKey as ItemTableColumnKey),
      ) as ItemTableColumnKey[];
    } catch {
      return [...ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS];
    }
  });
  const [inlineOverrides, setInlineOverrides] = React.useState<Record<string, Partial<PartRecord>>>({});

  // Persist page size + column config to localStorage
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ITEMS_PAGE_SIZE_STORAGE_KEY, String(pageSize));
  }, [pageSize]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ITEMS_VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  // ── Derived data ─────────────────────────────────────────────

  const effectiveParts = React.useMemo(
    () =>
      parts.map((part) => ({
        ...part,
        ...(inlineOverrides[part.id] ?? {}),
      })),
    [inlineOverrides, parts],
  );

  const queueCards = React.useMemo(
    () => LOOP_ORDER.flatMap((loopType) => queueByLoop[loopType] ?? []),
    [queueByLoop],
  );

  const queueStatsByPartId = React.useMemo(() => {
    const stats = new Map<
      string,
      {
        cards: number;
        cardIds: string[];
        minUnits: number | null;
        orderUnits: number | null;
        queueUpdatedAt: string | null;
        latestStage: string | null;
        loopTypes: Set<LoopType>;
      }
    >();

    for (const card of queueCards) {
      const existing = stats.get(card.partId) ?? {
        cards: 0,
        cardIds: [],
        minUnits: null,
        orderUnits: null,
        queueUpdatedAt: null,
        latestStage: null,
        loopTypes: new Set<LoopType>(),
      };

      existing.cards += 1;
      existing.cardIds.push(card.id);
      existing.minUnits =
        existing.minUnits === null ? card.minQuantity : Math.max(existing.minUnits, card.minQuantity);
      existing.orderUnits =
        existing.orderUnits === null ? card.orderQuantity : Math.max(existing.orderUnits, card.orderQuantity);
      const isLatestCard = existing.queueUpdatedAt === null || card.currentStageEnteredAt > existing.queueUpdatedAt;
      if (isLatestCard) {
        existing.queueUpdatedAt = card.currentStageEnteredAt;
        existing.latestStage = card.currentStage;
      }
      existing.loopTypes.add(card.loopType);

      stats.set(card.partId, existing);
    }

    return stats;
  }, [queueCards]);

  const activeItemsCount = React.useMemo(
    () => effectiveParts.filter((part) => part.isActive).length,
    [effectiveParts],
  );
  const recentlyImportedCount = React.useMemo(
    () => effectiveParts.filter((part) => queueStatsByPartId.has(part.id)).length,
    [effectiveParts, queueStatsByPartId],
  );

  const scopedParts = React.useMemo(
    () =>
      activeTab === "recentlyImported"
        ? effectiveParts.filter((part) => queueStatsByPartId.has(part.id))
        : effectiveParts.filter((part) => part.isActive),
    [activeTab, effectiveParts, queueStatsByPartId],
  );

  const filteredParts = React.useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return scopedParts;

    return scopedParts.filter((part) => {
      const queueStats = queueStatsByPartId.get(part.id);
      const orderLineSummary = orderLineByItem[part.eId ?? part.id];
      const loopText = queueStats
        ? Array.from(queueStats.loopTypes)
            .map((loopType) => LOOP_META[loopType].label)
            .join(" ")
            .toLowerCase()
        : "";
      const orderStatusText = (orderLineSummary?.status ?? "").toLowerCase();

      return (
        part.partNumber.toLowerCase().includes(normalized) ||
        (part.externalGuid ?? "").toLowerCase().includes(normalized) ||
        part.name.toLowerCase().includes(normalized) ||
        (part.primarySupplier ?? "").toLowerCase().includes(normalized) ||
        (part.orderMechanism ?? "").toLowerCase().includes(normalized) ||
        (part.location ?? "").toLowerCase().includes(normalized) ||
        (part.glCode ?? "").toLowerCase().includes(normalized) ||
        (part.itemSubtype ?? "").toLowerCase().includes(normalized) ||
        orderStatusText.includes(normalized) ||
        part.type.toLowerCase().includes(normalized) ||
        loopText.includes(normalized)
      );
    });
  }, [orderLineByItem, queueStatsByPartId, scopedParts, search]);

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setPage(1);
  }, [activeTab, pageSize, search]);

  // ── Pagination math ──────────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(filteredParts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedParts = filteredParts.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const firstVisibleIndex = pagedParts.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastVisibleIndex = pagedParts.length === 0 ? 0 : (currentPage - 1) * pageSize + pagedParts.length;
  const visibleColumnsSet = React.useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const tableColumnCount = visibleColumns.length + 1;
  const tableMinWidth = Math.max(1280, 120 + visibleColumns.length * 138);

  // ── Optimistic update handler ────────────────────────────────

  const applyOptimisticUpdate = React.useCallback((partId: string, patch: Partial<PartRecord>) => {
    setInlineOverrides((prev) => ({
      ...prev,
      [partId]: {
        ...(prev[partId] ?? {}),
        ...patch,
      },
    }));
  }, []);

  // ── Loading state ────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="density-compact space-y-2">
        {/* Header skeleton */}
        <div className="space-y-1">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>

        {/* Toolbar skeleton */}
        <Card>
          <CardContent className="flex items-center gap-3 p-3">
            <Skeleton className="h-9 flex-1" />
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
          </CardContent>
        </Card>

        {/* Table skeleton */}
        <div className="rounded-xl border">
          <Skeleton className="h-10 w-full rounded-t-xl" />
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-t px-4 py-2.5">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="density-compact space-y-2">
      {error && <ErrorBanner message={error} onRetry={refreshAll} />}

      <NextActionBanner queueSummary={queueSummary} queueByLoop={queueByLoop} />

      <section className="space-y-2">
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-[13px] text-muted-foreground">
            <span>Home</span>
            <ChevronRight className="h-3 w-3" />
            <span className="text-foreground">Items</span>
          </div>
          <h2 className="text-3xl leading-tight font-bold tracking-tight md:text-[40px] md:leading-[1.05]">
            Items
          </h2>
          <p className="text-sm text-muted-foreground">
            Create new items, print Kanban Cards, and add to order queue.
          </p>
        </div>

        {/* ── Tabs ──────────────────────────────────────────── */}

        <div role="tablist" className="flex items-center gap-5 border-b border-border/80">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "published"}
            aria-controls="panel-published"
            onClick={() => setActiveTab("published")}
            className={cn(
              "border-b-2 pb-1.5 text-base font-semibold transition-colors",
              activeTab === "published"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground",
            )}
          >
            Published Items
            <span className="ml-1.5 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {activeItemsCount}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "recentlyImported"}
            aria-controls="panel-recentlyImported"
            onClick={() => setActiveTab("recentlyImported")}
            className={cn(
              "border-b-2 pb-1.5 text-base font-medium transition-colors",
              activeTab === "recentlyImported"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground",
            )}
          >
            Recently Imported
            <span className="ml-1.5 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
              {recentlyImportedCount}
            </span>
          </button>
        </div>

        {/* ── Toolbar + Table (tabpanel) ─────────────────── */}

        <div role="tabpanel" id={`panel-${activeTab}`} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="relative w-[360px] max-w-full">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-9 bg-card pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter items"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <ColumnConfig visibleColumns={visibleColumns} onColumnsChange={setVisibleColumns} />

            <Button variant="outline" className="h-9">
              <CircleHelp className="h-4 w-4" />
              Actions
              <ChevronDown className="h-4 w-4" />
            </Button>
            <Button className="h-9">
              <Plus className="h-4 w-4" />
              Add item
              <ChevronDown className="h-4 w-4" />
            </Button>
            <Button variant="outline" className="h-9" onClick={() => void refreshAll()}>
              {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Click editable cells (supplier, quantities, units, order method, location). Changes save automatically when
          you press Enter or click away.
        </p>

        {/* ── Table ─────────────────────────────────────────── */}

        <div className="overflow-hidden rounded-lg border border-table-border bg-card shadow-arda-sm">
          <div className="overflow-x-auto">
            <TooltipProvider delayDuration={140}>
              <table
                className="w-full divide-y divide-table-border text-[12.5px]"
                style={{ minWidth: `${tableMinWidth}px` }}
              >
                <thead className="bg-table-header text-[12px]">
                  <tr>
                    <th className="table-cell-density w-9">
                      <input
                        type="checkbox"
                        aria-label="Select all items"
                        className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
                      />
                    </th>
                    {visibleColumns.map((columnKey) => {
                      const column = ITEM_TABLE_COLUMNS.find((c) => c.key === columnKey);
                      if (!column) return null;
                      return (
                        <th
                          key={columnKey}
                          className="table-cell-density text-left font-semibold whitespace-nowrap"
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default truncate">{column.label}</span>
                            </TooltipTrigger>
                            <TooltipContent>{column.label}</TooltipContent>
                          </Tooltip>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {pagedParts.length === 0 && (
                    <tr>
                      <td colSpan={tableColumnCount} className="px-4 py-10 text-center text-muted-foreground">
                        No items match your search.
                      </td>
                    </tr>
                  )}

                  {pagedParts.map((part) => (
                    <ItemRow
                      key={part.id}
                      part={part}
                      visibleColumnsSet={visibleColumnsSet}
                      visibleColumns={visibleColumns}
                      queueStatsByPartId={queueStatsByPartId}
                      orderLineByItem={orderLineByItem}
                      session={session}
                      onOptimisticUpdate={applyOptimisticUpdate}
                    />
                  ))}
                </tbody>
              </table>
            </TooltipProvider>
          </div>

          <PaginationBar
            currentPage={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            totalItems={filteredParts.length}
            firstIndex={firstVisibleIndex}
            lastIndex={lastVisibleIndex}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
        </div>
      </section>
    </div>
  );
}

/* ── Quick action buttons with real API calls ─────────────────── */

type ActionState = "idle" | "loading" | "done";

function QuickActions({
  part,
  cardIds,
  notes,
  session,
}: {
  part: PartRecord;
  cardIds: string[];
  notes: string;
  session: AuthSession;
}) {
  const [printState, setPrintState] = React.useState<ActionState>("idle");
  const [orderState, setOrderState] = React.useState<ActionState>("idle");
  const hasCards = cardIds.length > 0;

  const handlePrint = React.useCallback(async () => {
    if (!hasCards) {
      toast.error("No kanban cards to print for this item.");
      return;
    }
    setPrintState("loading");
    try {
      await createPrintJob(session.tokens.accessToken, { cardIds });
      setPrintState("done");
      toast.success(`Print job queued for ${cardIds.length} card${cardIds.length > 1 ? "s" : ""}`);
      setTimeout(() => setPrintState("idle"), 1500);
    } catch (err) {
      setPrintState("idle");
      toast.error(parseApiError(err));
    }
  }, [cardIds, hasCards, session.tokens.accessToken]);

  const handleCreateOrder = React.useCallback(async () => {
    if (!hasCards) {
      toast.error("No kanban cards to create an order from.");
      return;
    }
    setOrderState("loading");
    try {
      const result = await createPurchaseOrderFromCards(session.tokens.accessToken, { cardIds });
      setOrderState("done");
      toast.success(`Purchase order ${result.poNumber} created`);
      setTimeout(() => setOrderState("idle"), 1500);
    } catch (err) {
      setOrderState("idle");
      toast.error(parseApiError(err));
    }
  }, [cardIds, hasCards, session.tokens.accessToken]);

  const actionBtnClass =
    "h-7 w-7 rounded-md border-border/80 transition-all hover:border-primary/45 hover:bg-[hsl(var(--arda-orange)/0.1)] active:scale-95";

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={actionBtnClass}
            disabled={orderState === "loading"}
            onClick={handleCreateOrder}
            aria-label={`Create order for ${part.partNumber}`}
          >
            {orderState === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : orderState === "done" ? (
              <Check className="h-3.5 w-3.5 text-[hsl(var(--arda-success))]" />
            ) : (
              <ShoppingCart className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {hasCards ? `Create PO from ${cardIds.length} card${cardIds.length > 1 ? "s" : ""}` : "No cards in queue"}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={actionBtnClass}
            disabled={printState === "loading"}
            onClick={handlePrint}
            aria-label={`Print labels for ${part.partNumber}`}
          >
            {printState === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : printState === "done" ? (
              <Check className="h-3.5 w-3.5 text-[hsl(var(--arda-success))]" />
            ) : (
              <Printer className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {hasCards ? `Print ${cardIds.length} card${cardIds.length > 1 ? "s" : ""}` : "No cards to print"}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={actionBtnClass}
            aria-label={`View notes for ${part.partNumber}`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px]">{notes}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/* ── Memoized table row ─────────────────────────────────────── */

interface ItemRowProps {
  part: PartRecord;
  visibleColumnsSet: Set<ItemTableColumnKey>;
  visibleColumns: ItemTableColumnKey[];
  queueStatsByPartId: Map<string, {
    cards: number;
    cardIds: string[];
    minUnits: number | null;
    orderUnits: number | null;
    queueUpdatedAt: string | null;
    latestStage: string | null;
    loopTypes: Set<LoopType>;
  }>;
  orderLineByItem: Record<string, import("@/types").OrderLineByItemSummary>;
  session: AuthSession;
  onOptimisticUpdate: (partId: string, patch: Partial<PartRecord>) => void;
}

const ItemRow = React.memo(function ItemRow({
  part,
  visibleColumnsSet,
  visibleColumns,
  queueStatsByPartId,
  orderLineByItem,
  session,
  onOptimisticUpdate,
}: ItemRowProps) {
  const queueStats = queueStatsByPartId.get(part.id);
  const orderLineSummary = orderLineByItem[part.eId ?? part.id];
  const queueUpdatedAt = queueStats?.queueUpdatedAt ?? null;
  const itemCode = part.externalGuid || part.partNumber || part.id;
  const itemName = part.name?.trim() || "Unnamed item";
  const supplierLabel = part.primarySupplier || "—";
  const orderMethod = formatReadableLabel(part.orderMechanism || part.type || null);
  const minQty = part.minQty ?? queueStats?.minUnits ?? null;
  const minQtyUnit = part.minQtyUnit || part.uom || null;
  const orderQty = part.orderQty ?? queueStats?.orderUnits ?? orderLineSummary?.orderedQty ?? null;
  const orderQtyUnit = part.orderQtyUnit || part.uom || orderLineSummary?.orderedQtyUnit || null;
  const statusSource =
    orderLineSummary?.status || queueStats?.latestStage || (part.isActive ? "ACTIVE" : "INACTIVE");
  const statusLabel = formatStatus(statusSource);
  const updatedAt =
    [orderLineSummary?.updatedAt, queueUpdatedAt, part.updatedAt]
      .filter((c): c is string => Boolean(c))
      .sort()
      .at(-1) ?? part.updatedAt;
  const normalizedStatus = statusSource.toLowerCase();
  const statusVariant =
    /completed|received|accepted/i.test(normalizedStatus)
      ? "success"
      : /new|committed|receiving|requested|depleted|pending|withdrawn/i.test(normalizedStatus)
        ? "warning"
        : /active/i.test(normalizedStatus)
          ? "accent"
          : "secondary";
  const parsedPartUnitPrice =
    typeof part.unitPrice === "number"
      ? part.unitPrice
      : typeof part.unitPrice === "string"
        ? Number.parseFloat(part.unitPrice.replace(/[^0-9.-]/g, ""))
        : null;
  const fallbackPartUnitPrice =
    parsedPartUnitPrice !== null && Number.isFinite(parsedPartUnitPrice) ? parsedPartUnitPrice : null;
  const notes = orderLineSummary?.notes || part.notes || "—";
  const isEditable = Boolean(part.eId);

  // Stable commit handler factory
  const makeCommit = React.useCallback(
    (field: InlineEditableField) =>
      buildCommitHandler(part, field, session, onOptimisticUpdate),
    [part, session, onOptimisticUpdate],
  );

  const renderCell = (columnKey: ItemTableColumnKey) => {
    switch (columnKey) {
      case "item":
        return (
          <td key={columnKey} className="table-cell-density">
            <div className="flex min-w-[220px] flex-col">
              <span className="link-arda leading-tight" title={itemCode}>
                {itemCode}
              </span>
              <span className="truncate text-[12px] text-muted-foreground" title={itemName}>
                {itemName}
              </span>
            </div>
          </td>
        );

      case "image":
        return (
          <td key={columnKey} className="table-cell-density">
            {part.imageUrl ? (
              <img
                src={part.imageUrl}
                alt={`${part.partNumber} preview`}
                className="h-7 w-12 rounded-sm border border-border object-cover"
                title={part.imageUrl}
              />
            ) : (
              <span className="inline-flex h-7 w-12 items-center justify-center rounded-sm border border-border bg-muted text-[10px] font-semibold text-muted-foreground">
                {part.partNumber.slice(0, 2).toUpperCase()}
              </span>
            )}
          </td>
        );

      case "quickActions":
        return (
          <td key={columnKey} className="table-cell-density">
            <QuickActions
              part={part}
              cardIds={queueStats?.cardIds ?? []}
              notes={notes}
              session={session}
            />
          </td>
        );

      case "supplier":
        return (
          <td key={columnKey} className="table-cell-density">
            <EditableCell
              displayValue={supplierLabel}
              rawValue={part.primarySupplier ?? ""}
              editable={isEditable}
              placeholder="Supplier name"
              onCommit={makeCommit("supplier")}
            />
          </td>
        );

      case "unitPrice":
        return (
          <td key={columnKey} className="table-cell-density">
            {formatMoney(
              orderLineSummary?.unitCostValue ?? fallbackPartUnitPrice,
              orderLineSummary?.unitCostCurrency,
            )}
          </td>
        );

      case "orderQuantity":
        return (
          <td key={columnKey} className="table-cell-density">
            <EditableCell
              displayValue={formatNumericValue(orderQty)}
              rawValue={orderQty == null ? "" : String(orderQty)}
              editable={isEditable}
              inputType="number"
              placeholder="0"
              onCommit={makeCommit("orderQuantity")}
            />
          </td>
        );

      case "orderUnits":
        return (
          <td key={columnKey} className="table-cell-density text-muted-foreground">
            <EditableCell
              displayValue={orderQtyUnit || "—"}
              rawValue={orderQtyUnit || ""}
              editable={isEditable}
              placeholder="Units"
              onCommit={makeCommit("orderUnits")}
            />
          </td>
        );

      case "minQuantity":
        return (
          <td key={columnKey} className="table-cell-density">
            <EditableCell
              displayValue={formatNumericValue(minQty)}
              rawValue={minQty == null ? "" : String(minQty)}
              editable={isEditable}
              inputType="number"
              placeholder="0"
              onCommit={makeCommit("minQuantity")}
            />
          </td>
        );

      case "minUnits":
        return (
          <td key={columnKey} className="table-cell-density text-muted-foreground">
            <EditableCell
              displayValue={minQtyUnit || "—"}
              rawValue={minQtyUnit || ""}
              editable={isEditable}
              placeholder="Units"
              onCommit={makeCommit("minUnits")}
            />
          </td>
        );

      case "cards":
        return (
          <td key={columnKey} className="table-cell-density font-semibold text-[hsl(var(--table-link))]">
            {queueStats?.cards ?? 0}
          </td>
        );

      case "notes":
        return (
          <td key={columnKey} className="table-cell-density text-muted-foreground">
            <span className="block max-w-[260px] truncate" title={notes}>
              {notes}
            </span>
          </td>
        );

      case "orderMethod":
        return (
          <td key={columnKey} className="table-cell-density">
            <EditableCell
              displayValue={orderMethod}
              rawValue={part.orderMechanism || part.type || ""}
              editable={isEditable}
              placeholder="Order method"
              onCommit={makeCommit("orderMethod")}
            />
          </td>
        );

      case "location":
        return (
          <td key={columnKey} className="table-cell-density text-muted-foreground">
            <EditableCell
              displayValue={part.location || "—"}
              rawValue={part.location || ""}
              editable={isEditable}
              placeholder="Location"
              onCommit={makeCommit("location")}
            />
          </td>
        );

      case "status":
        return (
          <td key={columnKey} className="table-cell-density">
            <Badge variant={statusVariant}>{statusLabel}</Badge>
          </td>
        );

      case "updated":
        return (
          <td key={columnKey} className="table-cell-density text-muted-foreground">
            {formatDateTime(updatedAt)}
          </td>
        );

      case "glCode":
        return (
          <td key={columnKey} className="table-cell-density text-muted-foreground">
            {part.glCode || "—"}
          </td>
        );

      default:
        return null;
    }
  };

  return (
    <tr className="border-t border-table-border hover:bg-table-row-hover/70">
      <td className="table-cell-density">
        <input
          type="checkbox"
          aria-label={`Select ${part.partNumber}`}
          className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
        />
      </td>
      {visibleColumns.map(renderCell)}
    </tr>
  );
});
