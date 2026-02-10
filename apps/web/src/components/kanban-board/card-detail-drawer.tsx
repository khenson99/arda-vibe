import * as React from "react";
import {
  Loader2,
  Printer,
  ShoppingCart,
  ArrowRight,
  QrCode,
} from "lucide-react";
import { toast } from "sonner";
import {
  Button,
  SidePanel,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  parseApiError,
  isUnauthorized,
  fetchCardHistory,
  fetchCardQR,
  createPrintJob,
  createPurchaseOrderFromCards,
} from "@/lib/api-client";
import type { KanbanCard, CardTransition, CardStage } from "@/types";
import { CARD_STAGE_META } from "@/types";

/* ── Timeline item ──────────────────────────────────────────── */

function TimelineItem({ transition }: { transition: CardTransition }) {
  const fromMeta = CARD_STAGE_META[transition.fromStage];
  const toMeta = CARD_STAGE_META[transition.toStage];
  const date = new Date(transition.createdAt);
  const formattedDate = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="flex items-start gap-3 py-2">
      {/* Timeline dot + line */}
      <div className="flex flex-col items-center">
        <div
          className="mt-0.5 h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: toMeta.color }}
        />
        <div className="h-full w-px bg-border" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pb-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className={cn("font-medium", fromMeta.textClass)}>{fromMeta.label}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className={cn("font-medium", toMeta.textClass)}>{toMeta.label}</span>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {formattedDate}
          {transition.method && transition.method !== "manual" && (
            <> &middot; {transition.method.replace("_", " ")}</>
          )}
        </p>
        {transition.notes && (
          <p className="mt-1 text-xs text-muted-foreground">{transition.notes}</p>
        )}
      </div>
    </div>
  );
}

/* ── Drawer component ───────────────────────────────────────── */

interface CardDetailDrawerProps {
  card: KanbanCard | null;
  token: string;
  onUnauthorized: () => void;
  onClose: () => void;
}

export function CardDetailDrawer({
  card,
  token,
  onUnauthorized,
  onClose,
}: CardDetailDrawerProps) {
  const [history, setHistory] = React.useState<CardTransition[]>([]);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = React.useState(false);
  const [isLoadingQR, setIsLoadingQR] = React.useState(false);
  const [isPrinting, setIsPrinting] = React.useState(false);
  const [isOrdering, setIsOrdering] = React.useState(false);

  // Load history + QR when card changes
  React.useEffect(() => {
    if (!card) {
      setHistory([]);
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;

    async function load() {
      setIsLoadingHistory(true);
      setIsLoadingQR(true);

      try {
        const [historyResult, qrResult] = await Promise.allSettled([
          fetchCardHistory(token, card!.id),
          fetchCardQR(token, card!.id),
        ]);

        if (cancelled) return;

        if (historyResult.status === "fulfilled") {
          setHistory(historyResult.value);
        } else {
          if (isUnauthorized(historyResult.reason)) {
            onUnauthorized();
            return;
          }
          setHistory([]);
        }

        if (qrResult.status === "fulfilled") {
          setQrDataUrl(qrResult.value.qrDataUrl);
        } else {
          setQrDataUrl(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
          setIsLoadingQR(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [card, token, onUnauthorized]);

  /* ── Actions ──────────────────────────────────────────────── */

  const handlePrint = React.useCallback(async () => {
    if (!card) return;
    setIsPrinting(true);
    try {
      await createPrintJob(token, { cardIds: [card.id] });
      toast.success("Print job queued");
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(err));
    } finally {
      setIsPrinting(false);
    }
  }, [card, token, onUnauthorized]);

  const handleCreateOrder = React.useCallback(async () => {
    if (!card) return;
    setIsOrdering(true);
    try {
      const result = await createPurchaseOrderFromCards(token, {
        cardIds: [card.id],
      });
      toast.success(`Purchase order ${result.poNumber} created`);
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(err));
    } finally {
      setIsOrdering(false);
    }
  }, [card, token, onUnauthorized]);

  /* ── Render ───────────────────────────────────────────────── */

  const isOpen = card !== null;
  const stageMeta = card ? CARD_STAGE_META[card.currentStage] : null;

  return (
    <SidePanel
      open={isOpen}
      onClose={onClose}
      title={card ? `Card #${card.cardNumber}` : ""}
      subtitle={card ? (card.partName ?? `Part ${card.partId?.slice(0, 8) ?? "—"}`) : undefined}
    >
      {card && (
        <div className="px-4 py-4 space-y-5">
          {/* Current stage */}
          <div className="rounded-lg border border-border p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Current Stage
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <div
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: stageMeta?.color }}
              />
              <span className={cn("text-sm font-semibold", stageMeta?.textClass)}>
                {stageMeta?.label}
              </span>
            </div>
          </div>

          {/* Card details */}
          <div className="grid grid-cols-2 gap-3">
            <DetailItem label="Loop Type" value={card.loopType ?? "—"} />
            <DetailItem label="Completed Cycles" value={String(card.completedCycles)} />
            <DetailItem
              label="In Stage Since"
              value={new Date(card.currentStageEnteredAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            />
            <DetailItem label="Active" value={card.isActive ? "Yes" : "No"} />
            {card.minQuantity !== undefined && (
              <DetailItem label="Min Quantity" value={String(card.minQuantity)} />
            )}
            {card.orderQuantity !== undefined && (
              <DetailItem label="Order Quantity" value={String(card.orderQuantity)} />
            )}
          </div>

          {/* QR Code */}
          <div className="rounded-lg border border-border p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              QR Code
            </p>
            {isLoadingQR ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : qrDataUrl ? (
              <div className="flex justify-center">
                <img
                  src={qrDataUrl}
                  alt={`QR code for card #${card.cardNumber}`}
                  className="h-32 w-32"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground">
                <QrCode className="mb-1 h-8 w-8 opacity-30" />
                QR code unavailable
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
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
            <Button
              size="sm"
              variant="accent"
              className="gap-1.5"
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
          </div>

          {/* Transition timeline */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Stage History
            </p>
            {isLoadingHistory ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : history.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No transitions yet
              </p>
            ) : (
              <div className="space-y-0">
                {history
                  .slice()
                  .sort(
                    (a, b) =>
                      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
                  )
                  .map((transition) => (
                    <TimelineItem key={transition.id} transition={transition} />
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </SidePanel>
  );
}

/* ── Small detail item helper ───────────────────────────────── */

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold text-card-foreground">{value}</p>
    </div>
  );
}
