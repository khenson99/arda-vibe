import * as React from "react";
import { useOutletContext } from "react-router-dom";
import {
  Check,
  Loader2,
  Plus,
  Printer,
  ShoppingCart,
} from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ItemDetailPanel } from "@/components/item-detail";
import { EditableCell, PaginationBar, ColumnConfig, BulkActionsBar, ItemCardList } from "@/components/data-table";
import { useMediaQuery } from "@/hooks/use-media-query";
import { ErrorBanner } from "@/components/error-banner";
import { useWorkspaceData } from "@/hooks/use-workspace-data";
import type { AppShellOutletContext } from "@/layouts/app-shell";
import {
  createPurchaseOrderFromCards,
  fetchCards,
  fetchLoops,
  isUnauthorized,
  normalizeOptionalString,
  parseApiError,
  toItemsInputPayload,
  updateLoopParameters,
  updateItemRecord,
} from "@/lib/api-client";
import { printCardsFromIds } from "@/lib/kanban-printing";
import { fetchLoopsForPart } from "@/lib/kanban-loops";
import {
  formatDateTime,
  formatMoney,
  formatNumericValue,
  formatReadableLabel,
  formatStatus,
} from "@/lib/formatters";
import { ITEMS_PAGE_SIZE_STORAGE_KEY, ITEMS_VISIBLE_COLUMNS_STORAGE_KEY } from "@/lib/constants";
import {
  normalizePartLinkId,
  partMatchesLinkId,
  resolvePartLinkedValue,
} from "@/lib/part-linking";
import { cn } from "@/lib/utils";
import type { AuthSession, InlineEditableField, ItemTableColumnKey, LoopType, PartRecord } from "@/types";
import {
  ITEMS_PAGE_SIZE_OPTIONS,
  ITEM_TABLE_COLUMNS,
  ITEM_TABLE_COLUMN_KEYS,
  ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS,
  LOOP_ORDER,
} from "@/types";
import {
  PROCUREMENT_ORDER_METHODS,
  procurementOrderMethodLabel,
  normalizeProcurementOrderMethod,
} from "@/components/procurement/order-method";

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
      const normalized = normalizeProcurementOrderMethod(rawValue);
      payloadPatch.orderMechanism = normalized;
      localPatch.orderMechanism = normalized;
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

function toKnownOrderMethod(value: string | null | undefined) {
  try {
    return normalizeProcurementOrderMethod(value ?? "");
  } catch {
    return "purchase_order" as const;
  }
}

function OrderMethodEditableCell({
  rawValue,
  editable,
  onCommit,
}: {
  rawValue: string;
  editable: boolean;
  onCommit: (nextValue: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [value, setValue] = React.useState(toKnownOrderMethod(rawValue));

  React.useEffect(() => {
    if (!isEditing) {
      setValue(toKnownOrderMethod(rawValue));
    }
  }, [isEditing, rawValue]);

  const display = procurementOrderMethodLabel(toKnownOrderMethod(rawValue));
  if (!editable) {
    return <span className="text-muted-foreground">{display}</span>;
  }

  if (!isEditing) {
    return (
      <button
        type="button"
        className="group inline-flex w-full items-center justify-between gap-1 rounded-sm border-b border-dashed border-border/60 px-1 py-0.5 text-left transition-colors hover:bg-muted/40"
        onClick={() => setIsEditing(true)}
      >
        <span className="truncate">{display}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={value}
        onValueChange={(next: string) => setValue(next as (typeof PROCUREMENT_ORDER_METHODS)[number])}
      >
        <SelectTrigger className="h-8 min-w-[170px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROCUREMENT_ORDER_METHODS.map((method) => (
            <SelectItem key={method} value={method}>
              {procurementOrderMethodLabel(method)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        className="h-7 px-2"
        disabled={isSaving}
        onClick={async () => {
          setIsSaving(true);
          try {
            await onCommit(value);
            setIsEditing(false);
          } catch {
            // Error toast handled by caller.
          } finally {
            setIsSaving(false);
          }
        }}
      >
        {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        disabled={isSaving}
        onClick={() => {
          setValue(toKnownOrderMethod(rawValue));
          setIsEditing(false);
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

/* ── PartsRoute ─────────────────────────────────────────────── */

export function PartsRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const { setPageHeaderActions } = useOutletContext<AppShellOutletContext>();
  const { isLoading, error, queueByLoop, parts, orderLineByItem, refreshAll } =
    useWorkspaceData(session.tokens.accessToken, onUnauthorized);

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
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [itemDialogState, setItemDialogState] = React.useState<{
    open: boolean;
    mode: "create" | "edit";
    part: PartRecord | null;
  }>({
    open: false,
    mode: "edit",
    part: null,
  });
  const isMobile = useMediaQuery("(max-width: 767px)");

  const openCreateItemDialog = React.useCallback(() => {
    setItemDialogState({
      open: true,
      mode: "create",
      part: null,
    });
  }, []);

  const openItemDetailDialog = React.useCallback((part: PartRecord) => {
    setItemDialogState({
      open: true,
      mode: "edit",
      part,
    });
  }, []);

  const partsHeaderActions = React.useMemo(
    () => (
      <>
        <Button className="h-9" onClick={openCreateItemDialog}>
          <Plus className="h-4 w-4" />
          Add item
        </Button>
        <ColumnConfig visibleColumns={visibleColumns} onColumnsChange={setVisibleColumns} />
      </>
    ),
    [openCreateItemDialog, visibleColumns],
  );

  React.useEffect(() => {
    setPageHeaderActions(partsHeaderActions);
    return () => {
      setPageHeaderActions(null);
    };
  }, [partsHeaderActions, setPageHeaderActions]);

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
      const normalizedPartId = normalizePartLinkId(card.partId);
      if (!normalizedPartId) continue;

      const existing = stats.get(normalizedPartId) ?? {
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

      stats.set(normalizedPartId, existing);
    }

    return stats;
  }, [queueCards]);

  const [allKanbanStatsByPartId, setAllKanbanStatsByPartId] = React.useState<
    Map<string, { loopCount: number; cards: number }>
  >(new Map());

  React.useEffect(() => {
    let isCancelled = false;

    const loadKanbanContext = async () => {
      try {
        const fetchAllLoopPages = async () => {
          const rows: Awaited<ReturnType<typeof fetchLoops>>["data"] = [];
          let page = 1;
          let totalPages = 1;
          while (page <= totalPages) {
            const response = await fetchLoops(session.tokens.accessToken, { page, pageSize: 100 });
            rows.push(...response.data);
            totalPages = Math.max(1, response.pagination.totalPages);
            page += 1;
          }
          return rows;
        };

        const fetchAllCardPages = async () => {
          const rows: Awaited<ReturnType<typeof fetchCards>>["data"] = [];
          let page = 1;
          let totalPages = 1;
          while (page <= totalPages) {
            const response = await fetchCards(session.tokens.accessToken, { page, pageSize: 100 });
            rows.push(...response.data);
            totalPages = Math.max(1, response.pagination.totalPages);
            page += 1;
          }
          return rows;
        };

        const [allLoops, allCards] = await Promise.all([fetchAllLoopPages(), fetchAllCardPages()]);

        if (isCancelled) return;

        const next = new Map<string, { loopCount: number; cards: number }>();
        for (const loop of allLoops) {
          const partKey = normalizePartLinkId(loop.partId);
          if (!partKey) continue;
          const current = next.get(partKey) ?? { loopCount: 0, cards: 0 };
          current.loopCount += 1;
          next.set(partKey, current);
        }

        for (const card of allCards) {
          const partKey = normalizePartLinkId(card.partId);
          if (!partKey) continue;
          const current = next.get(partKey) ?? { loopCount: 0, cards: 0 };
          current.cards += 1;
          next.set(partKey, current);
        }

        setAllKanbanStatsByPartId(next);
      } catch {
        if (!isCancelled) {
          setAllKanbanStatsByPartId(new Map());
        }
      }
    };

    void loadKanbanContext();

    return () => {
      isCancelled = true;
    };
  }, [refreshAll, session.tokens.accessToken]);

  const findQueueStatsForPart = React.useCallback(
    (part: PartRecord) => resolvePartLinkedValue(part, queueStatsByPartId),
    [queueStatsByPartId],
  );

  const activeItemsCount = React.useMemo(
    () => effectiveParts.filter((part) => part.isActive).length,
    [effectiveParts],
  );
  const recentlyImportedCount = React.useMemo(
    () => effectiveParts.filter((part) => Boolean(findQueueStatsForPart(part))).length,
    [effectiveParts, findQueueStatsForPart],
  );

  const scopedParts = React.useMemo(
    () =>
      activeTab === "recentlyImported"
        ? effectiveParts.filter((part) => Boolean(findQueueStatsForPart(part)))
        : effectiveParts.filter((part) => part.isActive),
    [activeTab, effectiveParts, findQueueStatsForPart],
  );

  const filteredParts = scopedParts;

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setPage(1);
  }, [activeTab, pageSize]);

  // Clear selection when page / tab changes
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [activeTab, pageSize, page]);

  const toggleOne = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ── Pagination math ──────────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(filteredParts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedParts = filteredParts.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const firstVisibleIndex = pagedParts.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastVisibleIndex = pagedParts.length === 0 ? 0 : (currentPage - 1) * pageSize + pagedParts.length;
  const tableColumnCount = visibleColumns.length + 1;
  const tableMinWidth = Math.max(1280, 120 + visibleColumns.length * 138);

  const toggleAll = React.useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === pagedParts.length ? new Set() : new Set(pagedParts.map((p) => p.id)),
    );
  }, [pagedParts]);

  const selectedPartsById = React.useMemo(
    () => new Map(effectiveParts.map((part) => [part.id, part])),
    [effectiveParts],
  );

  // Aggregate card IDs from selected parts for bulk actions
  const selectedCardIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const selectedPartId of selectedIds) {
      const part = selectedPartsById.get(selectedPartId);
      if (!part) continue;
      const stats = findQueueStatsForPart(part);
      if (stats) ids.push(...stats.cardIds);
    }
    return ids;
  }, [findQueueStatsForPart, selectedIds, selectedPartsById]);

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

      <section className="space-y-2">
        <div className="flex flex-wrap items-start gap-2">
          <h2 className="text-3xl leading-tight font-bold tracking-tight md:text-[40px] md:leading-[1.05]">
            Items
          </h2>
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

        <div role="tabpanel" id={`panel-${activeTab}`} className="space-y-3">
        {/* ── Table / Card list ────────────────────────────── */}

        {isMobile ? (
          <>
            <ItemCardList
              parts={pagedParts}
              selectedIds={selectedIds}
              onToggleSelect={toggleOne}
              onOpenItemDetail={openItemDetailDialog}
              queueStatsByPartId={queueStatsByPartId}
              allKanbanStatsByPartId={allKanbanStatsByPartId}
              orderLineByItem={orderLineByItem}
              session={session}
            />
            {pagedParts.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">No items available.</p>
            )}
          </>
        ) : (
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
                          checked={pagedParts.length > 0 && selectedIds.size === pagedParts.length}
                          ref={(el) => {
                            if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < pagedParts.length;
                          }}
                          onChange={toggleAll}
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
                          No items available.
                        </td>
                      </tr>
                    )}

                    {pagedParts.map((part) => (
                      <ItemRow
                        key={part.id}
                        part={part}
                        visibleColumns={visibleColumns}
                        queueStatsByPartId={queueStatsByPartId}
                        allKanbanStatsByPartId={allKanbanStatsByPartId}
                        orderLineByItem={orderLineByItem}
                        session={session}
                        onOptimisticUpdate={applyOptimisticUpdate}
                        isSelected={selectedIds.has(part.id)}
                        onToggle={() => toggleOne(part.id)}
                        onOpenDetail={openItemDetailDialog}
                        onCardCreated={refreshAll}
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
        )}

        {/* Pagination also on mobile */}
        {isMobile && pagedParts.length > 0 && (
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
        )}

        </div>
      </section>

      {/* ── Bulk actions bar (slides up when items selected) ─── */}
      <BulkActionsBar
        selectedCount={selectedIds.size}
        selectedCardIds={selectedCardIds}
        session={session}
        onDeselectAll={() => setSelectedIds(new Set())}
        onComplete={() => {
          setSelectedIds(new Set());
          void refreshAll();
        }}
      />
      <ItemDetailPanel
        open={itemDialogState.open}
        mode={itemDialogState.mode}
        part={itemDialogState.part}
        session={session}
        onUnauthorized={onUnauthorized}
        onClose={() => setItemDialogState((prev) => ({ ...prev, open: false }))}
        onSaved={async () => {
          await refreshAll();
        }}
      />
    </div>
  );
}

/* ── Quick action buttons with real API calls ─────────────────── */

type ActionState = "idle" | "loading" | "done";

function QuickActions({
  part,
  cardIds,
  session,
  onCardCreated,
}: {
  part: PartRecord;
  cardIds: string[];
  session: AuthSession;
  onCardCreated?: () => Promise<void> | void;
}) {
  const [printState, setPrintState] = React.useState<ActionState>("idle");
  const [orderState, setOrderState] = React.useState<ActionState>("idle");
  const [createCardState, setCreateCardState] = React.useState<ActionState>("idle");
  const hasCards = cardIds.length > 0;

  const handlePrint = React.useCallback(async () => {
    if (!hasCards) {
      toast.error("No kanban cards to print for this item.");
      return;
    }
    setPrintState("loading");
    try {
      const result = await printCardsFromIds({
        token: session.tokens.accessToken,
        cardIds,
        tenantName: session.user.tenantName,
        tenantLogoUrl: session.user.tenantLogo,
      });
      setPrintState("done");
      toast.success(`Print dialog opened for ${cardIds.length} card${cardIds.length > 1 ? "s" : ""}`);
      if (result.auditError) {
        toast.warning(`Printed, but audit logging failed: ${result.auditError}`);
      }
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

  const handleCreateCard = React.useCallback(async () => {
    setCreateCardState("loading");
    try {
      const partLoops = await fetchLoopsForPart(session.tokens.accessToken, part);
      if (partLoops.length === 0) {
        if (!part.eId) {
          setCreateCardState("idle");
          toast.error("This item cannot auto-provision a loop yet. Refresh and try again.");
          return;
        }

        const author = normalizeOptionalString(session.user.email) || session.user.id;
        await updateItemRecord(session.tokens.accessToken, {
          entityId: part.eId,
          tenantId: session.user.tenantId,
          author,
          payload: toItemsInputPayload(part),
          provisionDefaults: true,
        });

        setCreateCardState("done");
        toast.success("Created default loop and first card for this item.");
        try {
          await onCardCreated?.();
        } catch {
          // Keep quick action success even if refresh fails.
        }
        setTimeout(() => setCreateCardState("idle"), 1500);
        return;
      }

      const targetLoop =
        partLoops.find((loop) => loop.loopType === "procurement") ||
        partLoops.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

      if (!targetLoop) {
        setCreateCardState("idle");
        toast.error("Unable to identify a loop for this item.");
        return;
      }

      const nextCardCount = Math.max(1, targetLoop.numberOfCards + 1);
      await updateLoopParameters(session.tokens.accessToken, targetLoop.id, {
        numberOfCards: nextCardCount,
        reason: `Quick action: added card for ${part.partNumber}`,
      });

      setCreateCardState("done");
      toast.success(
        `Created card #${nextCardCount} in ${formatReadableLabel(targetLoop.loopType)} loop.`,
      );
      try {
        await onCardCreated?.();
      } catch {
        // Keep quick action success even if refresh fails.
      }
      setTimeout(() => setCreateCardState("idle"), 1500);
    } catch (err) {
      setCreateCardState("idle");
      if (isUnauthorized(err)) {
        toast.error("Session expired. Sign in again.");
        return;
      }
      toast.error(parseApiError(err));
    }
  }, [onCardCreated, part, part.partNumber, session.tokens.accessToken]);

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
            disabled={createCardState === "loading"}
            onClick={handleCreateCard}
            aria-label={`Create card for ${part.partNumber}`}
          >
            {createCardState === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : createCardState === "done" ? (
              <Check className="h-3.5 w-3.5 text-[hsl(var(--arda-success))]" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Create a new card on this item&apos;s loop</TooltipContent>
      </Tooltip>
    </div>
  );
}

/* ── Memoized table row ─────────────────────────────────────── */

interface ItemRowProps {
  part: PartRecord;
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
  allKanbanStatsByPartId: Map<string, { loopCount: number; cards: number }>;
  orderLineByItem: Record<string, import("@/types").OrderLineByItemSummary>;
  session: AuthSession;
  onOptimisticUpdate: (partId: string, patch: Partial<PartRecord>) => void;
  isSelected: boolean;
  onToggle: () => void;
  onOpenDetail: (part: PartRecord) => void;
  onCardCreated: () => Promise<void>;
}

const ItemRow = React.memo(function ItemRow({
  part,
  visibleColumns,
  queueStatsByPartId,
  allKanbanStatsByPartId,
  orderLineByItem,
  session,
  onOptimisticUpdate,
  isSelected,
  onToggle,
  onOpenDetail,
  onCardCreated,
}: ItemRowProps) {
  const queueStats = resolvePartLinkedValue(part, queueStatsByPartId);
  const allKanbanStats = resolvePartLinkedValue(part, allKanbanStatsByPartId);
  const orderLineSummary = orderLineByItem[part.eId ?? part.id];
  const queueUpdatedAt = queueStats?.queueUpdatedAt ?? null;
  const itemCode = part.externalGuid || part.partNumber || part.id;
  const itemName = part.name?.trim() || "Unnamed item";
  const supplierLabel = part.primarySupplier || "—";
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
              session={session}
              onCardCreated={onCardCreated}
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
            <div className="leading-tight">
              <div>{allKanbanStats?.cards ?? 0}</div>
              <div className="text-[10px] font-normal text-muted-foreground">
                {allKanbanStats?.loopCount ?? 0} loop{(allKanbanStats?.loopCount ?? 0) === 1 ? "" : "s"}
              </div>
            </div>
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
            <OrderMethodEditableCell
              rawValue={part.orderMechanism || part.type || "purchase_order"}
              editable={isEditable}
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

  const STATUS_ROW_CLASSES: Record<string, string> = {
    success:   "border-l-4 border-l-[hsl(var(--arda-success))] bg-[hsl(var(--arda-success)/0.03)]",
    warning:   "border-l-4 border-l-[hsl(var(--arda-warning))] bg-[hsl(var(--arda-warning)/0.03)]",
    accent:    "border-l-4 border-l-[hsl(var(--arda-blue))] bg-[hsl(var(--arda-blue)/0.03)]",
    secondary: "",
  };

  return (
    <tr className={cn(
      "border-t border-table-border hover:bg-table-row-hover/70",
      STATUS_ROW_CLASSES[statusVariant],
      isSelected && "bg-[hsl(var(--arda-blue)/0.06)]",
      "cursor-pointer",
    )}
    onClick={(event) => {
      const target = event.target as HTMLElement;
      if (target.closest("button,input,a,textarea,select,label,[role='button']")) return;
      onOpenDetail(part);
    }}>
      <td className="table-cell-density">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          aria-label={`Select ${part.partNumber}`}
          className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
        />
      </td>
      {visibleColumns.map(renderCell)}
    </tr>
  );
});
