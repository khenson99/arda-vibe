import React from "react";
import { Printer, ShoppingCart, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Checkbox } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatStatus, formatQuantity, formatDateTime } from "@/lib/formatters";
import { createPurchaseOrderFromCards, parseApiError } from "@/lib/api-client";
import { printCardsFromIds } from "@/lib/kanban-printing";
import { resolvePartLinkedValue } from "@/lib/part-linking";
import type { PartRecord, LoopType, OrderLineByItemSummary, AuthSession } from "@/types";

/* ── Types ──────────────────────────────────────────────────── */

type ActionState = "idle" | "loading" | "done";

interface QueueStatsEntry {
  cards: number;
  cardIds: string[];
  minUnits: number | null;
  orderUnits: number | null;
  queueUpdatedAt: string | null;
  latestStage: string | null;
  loopTypes: Set<LoopType>;
}

interface AllKanbanStatsEntry {
  loopCount: number;
  cards: number;
}

export interface ItemCardListProps {
  parts: PartRecord[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpenItemDetail?: (part: PartRecord) => void;
  queueStatsByPartId: Map<string, QueueStatsEntry>;
  allKanbanStatsByPartId: Map<string, AllKanbanStatsEntry>;
  orderLineByItem: Record<string, OrderLineByItemSummary>;
  session: AuthSession;
}

/* ── Status variant helper ──────────────────────────────────── */

function getStatusVariant(status: string): "success" | "warning" | "accent" | "secondary" {
  const normalized = status.toLowerCase();
  if (/completed|received|accepted/i.test(normalized)) return "success";
  if (/new|committed|receiving|requested|depleted|pending|withdrawn/i.test(normalized)) return "warning";
  if (/active/i.test(normalized)) return "accent";
  return "secondary";
}

/* ── Individual card ────────────────────────────────────────── */

interface ItemCardProps {
  part: PartRecord;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onOpenItemDetail?: (part: PartRecord) => void;
  queueStats: QueueStatsEntry | undefined;
  allKanbanStats: AllKanbanStatsEntry | undefined;
  orderLineSummary: OrderLineByItemSummary | undefined;
  session: AuthSession;
}

const ItemCard = React.memo(function ItemCard({
  part,
  isSelected,
  onToggleSelect,
  onOpenItemDetail,
  queueStats,
  allKanbanStats,
  orderLineSummary,
  session,
}: ItemCardProps) {
  const [printState, setPrintState] = React.useState<ActionState>("idle");
  const [poState, setPoState] = React.useState<ActionState>("idle");

  /* Derived display values */
  const itemCode = part.externalGuid || part.partNumber || part.id;
  const itemName = part.name?.trim() || "Unnamed item";
  const supplierLabel = part.primarySupplier || "\u2014";
  const minQty = part.minQty ?? queueStats?.minUnits ?? null;
  const minQtyUnit = part.minQtyUnit || part.uom || null;
  const orderQty = part.orderQty ?? queueStats?.orderUnits ?? orderLineSummary?.orderedQty ?? null;
  const orderQtyUnit = part.orderQtyUnit || part.uom || orderLineSummary?.orderedQtyUnit || null;
  const statusSource =
    orderLineSummary?.status || queueStats?.latestStage || (part.isActive ? "ACTIVE" : "INACTIVE");
  const statusLabel = formatStatus(statusSource);
  const statusVariant = getStatusVariant(statusSource);
  const updatedAt =
    [orderLineSummary?.updatedAt, queueStats?.queueUpdatedAt, part.updatedAt]
      .filter((c): c is string => Boolean(c))
      .sort()
      .at(-1) ?? part.updatedAt;

  const cardIds = queueStats?.cardIds ?? [];
  const totalCards = allKanbanStats?.cards ?? queueStats?.cards ?? 0;
  const totalLoops = allKanbanStats?.loopCount ?? 0;
  const hasCards = cardIds.length > 0;

  /* Action handlers */
  const handlePrintLabels = React.useCallback(async () => {
    if (!hasCards || printState === "loading") return;
    setPrintState("loading");
    try {
      const result = await printCardsFromIds({
        token: session.tokens.accessToken,
        cardIds,
        tenantName: session.user.tenantName,
        tenantLogoUrl: session.user.tenantLogo,
      });
      setPrintState("done");
      toast.success("Print dialog opened");
      if (result.auditError) {
        toast.warning(`Printed, but audit logging failed: ${result.auditError}`);
      }
      setTimeout(() => setPrintState("idle"), 1500);
    } catch (err) {
      setPrintState("idle");
      toast.error(parseApiError(err));
    }
  }, [hasCards, printState, session.tokens.accessToken, session.user.tenantName, session.user.tenantLogo, cardIds]);

  const handleCreatePo = React.useCallback(async () => {
    if (!hasCards || poState === "loading") return;
    setPoState("loading");
    try {
      const result = await createPurchaseOrderFromCards(session.tokens.accessToken, { cardIds });
      setPoState("done");
      toast.success(`PO ${result.poNumber} created`);
      setTimeout(() => setPoState("idle"), 1500);
    } catch (err) {
      setPoState("idle");
      toast.error(parseApiError(err));
    }
  }, [hasCards, poState, session.tokens.accessToken, cardIds]);

  return (
    <article
      className={cn(
        "rounded-xl border border-border bg-card px-4 py-3 shadow-sm",
        isSelected && "ring-2 ring-[hsl(var(--link)/0.4)]",
        onOpenItemDetail && "cursor-pointer hover:border-primary/45",
      )}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button,input,label,[role='button']")) return;
        onOpenItemDetail?.(part);
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-[hsl(var(--link))]">{itemCode}</span>
          <p className="truncate text-xs text-muted-foreground">{itemName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={statusVariant}>{statusLabel}</Badge>
          <Checkbox
            checked={isSelected}
            onChange={() => onToggleSelect(part.id)}
            aria-label={`Select ${itemCode}`}
          />
        </div>
      </div>

      {/* Body — name-value pairs */}
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className="text-muted-foreground">Supplier</span>
          <p className="font-semibold text-card-foreground">{supplierLabel}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Qty</span>
          <p className="font-semibold text-card-foreground">{formatQuantity(orderQty, orderQtyUnit)}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Min</span>
          <p className="font-semibold text-card-foreground">{formatQuantity(minQty, minQtyUnit)}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Location</span>
          <p className="font-semibold text-card-foreground">{part.location || "\u2014"}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Cards</span>
          <p className="font-semibold text-card-foreground">{totalCards}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Loops</span>
          <p className="font-semibold text-card-foreground">{totalLoops}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Updated</span>
          <p className="font-semibold text-card-foreground">{formatDateTime(updatedAt)}</p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasCards || poState === "loading"}
          onClick={handleCreatePo}
        >
          {poState === "loading" && (
            <>
              <Loader2 className="animate-spin" />
              Working...
            </>
          )}
          {poState === "done" && (
            <>
              <Check />
              Done!
            </>
          )}
          {poState === "idle" && (
            <>
              <ShoppingCart />
              Create PO
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasCards || printState === "loading"}
          onClick={handlePrintLabels}
        >
          {printState === "loading" && (
            <>
              <Loader2 className="animate-spin" />
              Working...
            </>
          )}
          {printState === "done" && (
            <>
              <Check />
              Done!
            </>
          )}
          {printState === "idle" && (
            <>
              <Printer />
              Print Label
            </>
          )}
        </Button>
      </div>
    </article>
  );
});

/* ── List wrapper ───────────────────────────────────────────── */

export function ItemCardList({
  parts,
  selectedIds,
  onToggleSelect,
  onOpenItemDetail,
  queueStatsByPartId,
  allKanbanStatsByPartId,
  orderLineByItem,
  session,
}: ItemCardListProps) {
  return (
    <div className="space-y-3">
      {parts.map((part) => (
        <ItemCard
          key={part.id}
          part={part}
          isSelected={selectedIds.has(part.id)}
          onToggleSelect={onToggleSelect}
          onOpenItemDetail={onOpenItemDetail}
          queueStats={resolvePartLinkedValue(part, queueStatsByPartId)}
          allKanbanStats={resolvePartLinkedValue(part, allKanbanStatsByPartId)}
          orderLineSummary={orderLineByItem[part.eId ?? part.id]}
          session={session}
        />
      ))}
    </div>
  );
}
