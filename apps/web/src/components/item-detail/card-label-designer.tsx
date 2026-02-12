import * as React from "react";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button, Input } from "@/components/ui";
import {
  apiRequest,
  fetchCardPrintDetail,
  fetchCards,
  isUnauthorized,
  parseApiError,
} from "@/lib/api-client";
import {
  mapCardPrintDetailToPrintData,
  printCardsFromIds,
} from "@/lib/kanban-printing";
import { fetchLoopsForPart } from "@/lib/kanban-loops";
import { KanbanPrintRenderer } from "@/components/printing/kanban-print-renderer";
import type { KanbanPrintData } from "@/components/printing/types";
import type { KanbanCard, PartRecord } from "@/types";
import { LOOP_META } from "@/types";
import type { LoopType } from "@/types";
import { formatReadableLabel } from "@/lib/formatters";

interface CardLabelDesignerProps {
  part: PartRecord;
  token: string;
  tenantName: string;
  tenantLogoUrl?: string;
  onUnauthorized: () => void;
  onSaved?: () => Promise<void>;
  onOpenLoopsTab?: () => void;
}

interface EditorDraft {
  title: string;
  sku: string;
  minimumText: string;
  locationText: string;
  orderText: string;
  supplierText: string;
  notesText: string;
  imageUrl: string;
  accentColor: string;
}

const MAX_CARD_PAGES_PER_LOOP = 10;
const CARD_PREVIEW_LOAD_TIMEOUT_MS = 20_000;
const DEFAULT_ACCENT = "#2F6FCC";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function fetchCardsForLoop(token: string, loopId: string): Promise<KanbanCard[]> {
  const cards: KanbanCard[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MAX_CARD_PAGES_PER_LOOP) {
    const result = await fetchCards(token, { loopId, page, pageSize: 100 });
    cards.push(...result.data);
    totalPages = Math.max(1, result.pagination.totalPages || 1);
    page += 1;
  }

  return cards;
}

export function resolveLoopLabel(loopType?: string | null): string | null {
  if (!loopType) return null;
  return LOOP_META[loopType as LoopType]?.label ?? formatReadableLabel(loopType);
}

function buildDraftFromData(data: KanbanPrintData): EditorDraft {
  return {
    title: data.partDescription || data.partNumber,
    sku: data.sku || data.partNumber,
    minimumText: data.minimumText,
    locationText: data.locationText,
    orderText: data.orderText,
    supplierText: data.supplierText,
    notesText: data.notesText ?? "",
    imageUrl: data.imageUrl ?? "",
    accentColor: data.accentColor ?? DEFAULT_ACCENT,
  };
}

function normalizeColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{3}$/.test(trimmed)) return trimmed;
  return DEFAULT_ACCENT;
}

function applyDraft(base: KanbanPrintData, draft: EditorDraft): KanbanPrintData {
  return {
    ...base,
    partDescription: draft.title,
    sku: draft.sku,
    minimumText: draft.minimumText,
    locationText: draft.locationText,
    orderText: draft.orderText,
    supplierText: draft.supplierText,
    notesText: draft.notesText,
    imageUrl: draft.imageUrl,
    accentColor: normalizeColor(draft.accentColor),
  };
}

function buildFallbackDraftFromPart(part: PartRecord): EditorDraft {
  const qtyUnit = part.orderQtyUnit || part.minQtyUnit || part.uom || "each";
  return {
    title: part.name || part.partNumber,
    sku: part.partNumber,
    minimumText: `${part.minQty ?? 0} ${qtyUnit}`,
    locationText: part.location || "Location TBD",
    orderText: `${part.orderQty ?? 0} ${qtyUnit}`,
    supplierText: part.primarySupplier || "Unknown supplier",
    notesText: part.notes || "",
    imageUrl: part.imageUrl || "",
    accentColor: DEFAULT_ACCENT,
  };
}

export function CardLabelDesigner({
  part,
  token,
  tenantName,
  tenantLogoUrl,
  onUnauthorized,
  onSaved,
  onOpenLoopsTab,
}: CardLabelDesignerProps) {
  const [cards, setCards] = React.useState<KanbanCard[]>([]);
  const [isLoadingCards, setIsLoadingCards] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedCard, setSelectedCard] = React.useState<KanbanCard | null>(null);
  const [basePrintData, setBasePrintData] = React.useState<KanbanPrintData | null>(null);
  const [isLoadingPreviewData, setIsLoadingPreviewData] = React.useState(false);
  const [isPrinting, setIsPrinting] = React.useState(false);
  const [isSavingImageUrl, setIsSavingImageUrl] = React.useState(false);
  const [draft, setDraft] = React.useState<EditorDraft>(() => buildFallbackDraftFromPart(part));
  const selectedCardId = selectedCard?.id ?? null;
  const partLoopLookupKey = `${part.id}|${part.eId ?? ""}|${part.partNumber}|${part.externalGuid ?? ""}`;
  const partForLoop = React.useMemo(() => part, [partLoopLookupKey]);

  React.useEffect(() => {
    let cancelled = false;
    async function loadCards() {
      setIsLoadingCards(true);
      setLoadError(null);
      try {
        const loops = await withTimeout(
          fetchLoopsForPart(token, partForLoop),
          CARD_PREVIEW_LOAD_TIMEOUT_MS,
          "Loading card loops timed out.",
        );
        if (cancelled) return;

        if (loops.length === 0) {
          setCards([]);
          setSelectedCard(null);
          return;
        }

        const cardsByLoop = await withTimeout(
          Promise.all(loops.map((loop) => fetchCardsForLoop(token, loop.id))),
          CARD_PREVIEW_LOAD_TIMEOUT_MS,
          "Loading cards timed out.",
        );
        if (cancelled) return;
        const partCards = cardsByLoop.flat();

        setCards(partCards);
        setSelectedCard((current) => {
          if (partCards.length === 0) return null;
          if (current && partCards.some((card) => card.id === current.id)) return current;
          return partCards[0];
        });
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        const message = parseApiError(error);
        if (!cancelled) {
          setLoadError(message);
          toast.error(message);
        }
      } finally {
        if (!cancelled) setIsLoadingCards(false);
      }
    }
    void loadCards();
    return () => {
      cancelled = true;
    };
  }, [token, partForLoop, onUnauthorized]);

  React.useEffect(() => {
    if (!selectedCardId) {
      setBasePrintData(null);
      setDraft(buildFallbackDraftFromPart(part));
      return;
    }
    const currentSelectedCardId = selectedCardId;
    let cancelled = false;
    async function loadPreviewData() {
      setIsLoadingPreviewData(true);
      try {
        const detail = await fetchCardPrintDetail(token, currentSelectedCardId);
        if (cancelled) return;

        const mapped = mapCardPrintDetailToPrintData(detail, { tenantName, tenantLogoUrl });
        setBasePrintData(mapped);
        setDraft(buildDraftFromData(mapped));
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        if (!cancelled) {
          toast.error(parseApiError(error));
          setBasePrintData(null);
        }
      } finally {
        if (!cancelled) setIsLoadingPreviewData(false);
      }
    }

    void loadPreviewData();
    return () => {
      cancelled = true;
    };
  }, [token, selectedCardId, tenantName, tenantLogoUrl, onUnauthorized, part]);

  const previewData = React.useMemo(() => {
    if (!basePrintData) return null;
    return applyDraft(basePrintData, draft);
  }, [basePrintData, draft]);

  const handlePrint = React.useCallback(async () => {
    if (!selectedCard || !basePrintData) return;
    setIsPrinting(true);
    try {
      const result = await printCardsFromIds({
        token,
        cardIds: [selectedCard.id],
        tenantName,
        tenantLogoUrl,
        format: "order_card_3x5_portrait",
        overridesByCardId: {
          [selectedCard.id]: {
            partDescription: draft.title,
            sku: draft.sku,
            minimumText: draft.minimumText,
            locationText: draft.locationText,
            orderText: draft.orderText,
            supplierText: draft.supplierText,
            notesText: draft.notesText,
            imageUrl: draft.imageUrl,
            accentColor: normalizeColor(draft.accentColor),
          },
        },
        onUnauthorized,
      });
      toast.success(`Print dialog opened for card #${selectedCard.cardNumber}`);
      if (result.auditError) toast.warning(`Printed, but audit logging failed: ${result.auditError}`);
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setIsPrinting(false);
    }
  }, [selectedCard, basePrintData, token, tenantName, tenantLogoUrl, draft, onUnauthorized]);

  const handleSaveImageUrl = React.useCallback(async () => {
    const normalized = draft.imageUrl.trim();
    if (!normalized) {
      toast.error("Enter an image URL before saving.");
      return;
    }
    try {
      const parsed = new URL(normalized);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        toast.error("Image URL must start with http:// or https://");
        return;
      }
    } catch {
      toast.error("Image URL must be a valid URL.");
      return;
    }

    setIsSavingImageUrl(true);
    try {
      await apiRequest(`/api/catalog/parts/${encodeURIComponent(part.id)}`, {
        method: "PATCH",
        token,
        body: { imageUrl: normalized },
      });
      setBasePrintData((current) => (current ? { ...current, imageUrl: normalized } : current));
      toast.success("Item image URL updated.");
      if (onSaved) await onSaved();
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setIsSavingImageUrl(false);
    }
  }, [draft.imageUrl, onSaved, onUnauthorized, part.id, token]);

  if (isLoadingCards) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Card Editor</h3>
        <div className="flex items-center justify-center rounded-md border border-border p-8 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading cards...
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Card Editor</h3>
          {onOpenLoopsTab && (
            <Button size="sm" variant="outline" onClick={onOpenLoopsTab}>
              Open Loops &amp; Cards
            </Button>
          )}
        </div>
        <div className="space-y-3 rounded-md border border-border p-6 text-center text-xs text-muted-foreground">
          <p>Unable to load card editor: {loadError}</p>
          {onOpenLoopsTab && (
            <Button size="sm" variant="outline" onClick={onOpenLoopsTab}>
              Go to Loops &amp; Cards
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Card Editor</h3>
          {onOpenLoopsTab && (
            <Button size="sm" variant="outline" onClick={onOpenLoopsTab}>
              Open Loops &amp; Cards
            </Button>
          )}
        </div>
        <div className="space-y-3 rounded-md border border-border p-6 text-center text-xs text-muted-foreground">
          <p>No cards exist for this item yet. Use Loops &amp; Cards to provision and add cards.</p>
          {onOpenLoopsTab && (
            <Button size="sm" variant="outline" onClick={onOpenLoopsTab}>
              Go to Loops &amp; Cards
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Card Editor</h3>
        <div className="flex items-center gap-2">
          {cards.length > 1 && (
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={selectedCard?.id || ""}
              onChange={(e) => {
                const card = cards.find((c) => c.id === e.target.value);
                setSelectedCard(card || null);
              }}
            >
              {cards.map((card) => (
                <option key={card.id} value={card.id}>
                  Card #{card.cardNumber}
                  {card.loopType ? ` — ${resolveLoopLabel(card.loopType)}` : ""}
                </option>
              ))}
            </select>
          )}
          {onOpenLoopsTab && (
            <Button size="sm" variant="outline" onClick={onOpenLoopsTab}>
              Loops &amp; Cards
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-3 rounded-md border border-border p-3">
          <Field label="Title">
            <Input
              value={draft.title}
              onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
            />
          </Field>
          <Field label="SKU">
            <Input
              value={draft.sku}
              onChange={(e) => setDraft((prev) => ({ ...prev, sku: e.target.value }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Minimum">
              <Input
                value={draft.minimumText}
                onChange={(e) => setDraft((prev) => ({ ...prev, minimumText: e.target.value }))}
              />
            </Field>
            <Field label="Location">
              <Input
                value={draft.locationText}
                onChange={(e) => setDraft((prev) => ({ ...prev, locationText: e.target.value }))}
              />
            </Field>
            <Field label="Order">
              <Input
                value={draft.orderText}
                onChange={(e) => setDraft((prev) => ({ ...prev, orderText: e.target.value }))}
              />
            </Field>
            <Field label="Supplier">
              <Input
                value={draft.supplierText}
                onChange={(e) => setDraft((prev) => ({ ...prev, supplierText: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="Image URL">
            <div className="space-y-2">
              <Input
                value={draft.imageUrl}
                onChange={(e) => setDraft((prev) => ({ ...prev, imageUrl: e.target.value }))}
                placeholder="https://..."
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleSaveImageUrl()}
                  disabled={isSavingImageUrl}
                >
                  {isSavingImageUrl ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Save image URL
                </Button>
              </div>
            </div>
          </Field>
          <Field label="Notes">
            <textarea
              className="min-h-[72px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={draft.notesText}
              onChange={(e) => setDraft((prev) => ({ ...prev, notesText: e.target.value }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <Field label="Accent">
              <input
                type="color"
                className="h-9 w-full cursor-pointer rounded-md border border-border bg-background p-1"
                value={normalizeColor(draft.accentColor)}
                onChange={(e) => setDraft((prev) => ({ ...prev, accentColor: e.target.value }))}
              />
            </Field>
            <Field label="Accent (Hex)">
              <Input
                value={draft.accentColor}
                onChange={(e) => setDraft((prev) => ({ ...prev, accentColor: e.target.value }))}
              />
            </Field>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => basePrintData && setDraft(buildDraftFromData(basePrintData))}
              disabled={!basePrintData}
            >
              Reset
            </Button>
            <Button
              size="sm"
              onClick={() => void handlePrint()}
              disabled={isPrinting || !basePrintData}
            >
              {isPrinting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Printer className="h-3.5 w-3.5" />
              )}
              Print 3x5 Portrait
            </Button>
          </div>
        </div>

        <div className="overflow-auto rounded-md border border-border bg-muted/10 p-2">
          {isLoadingPreviewData || !previewData ? (
            <div className="flex min-h-[420px] items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading preview...
            </div>
          ) : (
            <div className="origin-top-left scale-[0.95]">
              <KanbanPrintRenderer data={previewData} format="order_card_3x5_portrait" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}
