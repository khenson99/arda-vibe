import * as React from "react";
import { Printer, QrCode, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button } from "@/components/ui";
import {
  fetchCards,
  fetchCardQR,
  createPrintJob,
  isUnauthorized,
  parseApiError,
} from "@/lib/api-client";
import type { KanbanCard, PartRecord } from "@/types";
import { CARD_STAGE_META, LOOP_META } from "@/types";
import type { LoopType } from "@/types";
import { cn } from "@/lib/utils";

interface CardLabelDesignerProps {
  part: PartRecord;
  token: string;
  onUnauthorized: () => void;
}

export function CardLabelDesigner({
  part,
  token,
  onUnauthorized,
}: CardLabelDesignerProps) {
  const [cards, setCards] = React.useState<KanbanCard[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [selectedCard, setSelectedCard] = React.useState<KanbanCard | null>(
    null,
  );
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [isLoadingQr, setIsLoadingQr] = React.useState(false);
  const [isPrinting, setIsPrinting] = React.useState(false);

  // Load cards for this part
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      try {
        const result = await fetchCards(token, { pageSize: 200 });
        if (cancelled) return;
        const partCards = result.data.filter((c) => c.partId === part.id);
        setCards(partCards);
        if (partCards.length > 0 && !selectedCard) {
          setSelectedCard(partCards[0]);
        }
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        toast.error(parseApiError(error));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token, part.id, onUnauthorized]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load QR for selected card
  React.useEffect(() => {
    if (!selectedCard) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    async function loadQr() {
      setIsLoadingQr(true);
      try {
        const result = await fetchCardQR(token, selectedCard!.id);
        if (!cancelled) setQrDataUrl(result.qrDataUrl);
      } catch {
        if (!cancelled) setQrDataUrl(null);
      } finally {
        if (!cancelled) setIsLoadingQr(false);
      }
    }
    void loadQr();
    return () => {
      cancelled = true;
    };
  }, [token, selectedCard?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePrint = React.useCallback(async () => {
    if (!selectedCard) return;
    setIsPrinting(true);
    try {
      await createPrintJob(token, { cardIds: [selectedCard.id] });
      toast.success(`Print job created for card #${selectedCard.cardNumber}`);
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setIsPrinting(false);
    }
  }, [selectedCard, token, onUnauthorized]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Card Label Preview</h3>
        <div className="flex items-center justify-center rounded-md border border-border p-8 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading cards...
        </div>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Card Label Preview</h3>
        <div className="rounded-md border border-border p-6 text-center text-xs text-muted-foreground">
          No cards exist for this item yet. Create a loop first.
        </div>
      </div>
    );
  }

  const loopType = selectedCard?.loopType;
  const stageMeta = selectedCard
    ? CARD_STAGE_META[selectedCard.currentStage]
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Card Label Preview</h3>
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
                {card.loopType
                  ? ` — ${LOOP_META[card.loopType].label}`
                  : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Label preview — simulates a physical kanban card */}
      {selectedCard && (
        <div className="overflow-hidden rounded-xl border-2 border-dashed border-border bg-white shadow-sm">
          {/* Color bar */}
          <div
            className="h-2"
            style={{
              backgroundColor: stageMeta?.color || "#e5e5e5",
            }}
          />

          <div className="space-y-3 p-4">
            {/* Row 1: Card number + QR */}
            <div className="flex items-start justify-between">
              <div>
                <p className="text-lg font-bold leading-none">
                  #{selectedCard.cardNumber}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {selectedCard.id.slice(0, 8)}
                </p>
              </div>
              <div className="flex h-16 w-16 items-center justify-center rounded-md border border-border bg-muted/30">
                {isLoadingQr ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="QR code"
                    className="h-full w-full object-contain p-0.5"
                  />
                ) : (
                  <QrCode className="h-6 w-6 text-muted-foreground/40" />
                )}
              </div>
            </div>

            {/* Row 2: Part name */}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Part
              </p>
              <p className="text-sm font-semibold leading-snug">
                {part.name || part.partNumber}
              </p>
              {part.partNumber && part.name && (
                <p className="text-xs text-muted-foreground">
                  {part.partNumber}
                </p>
              )}
            </div>

            {/* Row 3: Details grid */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <LabelField
                label="Supplier"
                value={part.primarySupplier || "--"}
              />
              <LabelField label="Location" value={part.location || "--"} />
              <LabelField
                label="Order Method"
                value={part.orderMechanism || part.type || "--"}
              />
            </div>

            {/* Row 4: Quantities */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <LabelField
                label="Min Qty"
                value={`${part.minQty ?? 0} ${part.minQtyUnit || part.uom || "ea"}`}
              />
              <LabelField
                label="Order Qty"
                value={
                  part.orderQty != null
                    ? `${part.orderQty} ${part.orderQtyUnit || part.uom || "ea"}`
                    : "--"
                }
              />
              <LabelField
                label="Cycles"
                value={String(selectedCard.completedCycles)}
              />
            </div>

            {/* Row 5: Badges */}
            <div className="flex items-center gap-2">
              {loopType && (
                <Badge variant="secondary" className="text-[10px]">
                  {LOOP_META[loopType as LoopType].label}
                </Badge>
              )}
              {stageMeta && (
                <Badge
                  className={cn(
                    "border-transparent text-[10px]",
                    stageMeta.bgClass,
                    stageMeta.textClass,
                  )}
                >
                  {stageMeta.label}
                </Badge>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Print action */}
      {selectedCard && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handlePrint()}
            disabled={isPrinting}
          >
            {isPrinting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Printer className="h-3.5 w-3.5" />
            )}
            Print label
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── Label field ────────────────────────────────────────────── */

function LabelField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="truncate font-medium">{value}</p>
    </div>
  );
}
