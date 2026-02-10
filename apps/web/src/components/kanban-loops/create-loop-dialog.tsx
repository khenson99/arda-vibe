import * as React from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Button,
  Input,
} from "@/components/ui";
import {
  ApiError,
  isUnauthorized,
  parseApiError,
  createLoop,
} from "@/lib/api-client";
import type { LoopType } from "@/types";
import { LOOP_ORDER, LOOP_META } from "@/types";

/* ── Card mode options ──────────────────────────────────────── */

const CARD_MODE_OPTIONS = [
  { value: "single", label: "Single Card" },
  { value: "multi", label: "Multi Card" },
] as const;

/* ── UUID validation ─────────────────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── Main component ─────────────────────────────────────────── */

interface CreateLoopDialogProps {
  token: string;
  onUnauthorized: () => void;
  onCreated: () => void;
  onOpenExistingLoop?: (loopId: string) => void;
}

export function CreateLoopDialog({
  token,
  onUnauthorized,
  onCreated,
  onOpenExistingLoop,
}: CreateLoopDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  // Form state
  const [partId, setPartId] = React.useState("");
  const [facilityId, setFacilityId] = React.useState("");
  const [loopType, setLoopType] = React.useState<LoopType>("procurement");
  const [cardMode, setCardMode] = React.useState<"single" | "multi">("single");
  const [numberOfCards, setNumberOfCards] = React.useState("1");
  const [minQuantity, setMinQuantity] = React.useState("");
  const [orderQuantity, setOrderQuantity] = React.useState("");
  const [statedLeadTimeDays, setStatedLeadTimeDays] = React.useState("");
  const [safetyStockDays, setSafetyStockDays] = React.useState("");
  const [primarySupplierId, setPrimarySupplierId] = React.useState("");
  const [sourceFacilityId, setSourceFacilityId] = React.useState("");
  const [storageLocationId, setStorageLocationId] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const resetForm = () => {
    setPartId("");
    setFacilityId("");
    setLoopType("procurement");
    setCardMode("single");
    setNumberOfCards("1");
    setMinQuantity("");
    setOrderQuantity("");
    setStatedLeadTimeDays("");
    setSafetyStockDays("");
    setPrimarySupplierId("");
    setSourceFacilityId("");
    setStorageLocationId("");
    setNotes("");
  };

  // When cardMode switches to single, lock numberOfCards to 1
  React.useEffect(() => {
    if (cardMode === "single") {
      setNumberOfCards("1");
    }
  }, [cardMode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // ── Validation ────────────────────────────────────────────
    if (!partId.trim()) {
      toast.error("Part ID is required.");
      return;
    }
    if (!UUID_RE.test(partId.trim())) {
      toast.error("Part ID must be a valid UUID.");
      return;
    }

    if (!facilityId.trim()) {
      toast.error("Facility ID is required.");
      return;
    }
    if (!UUID_RE.test(facilityId.trim())) {
      toast.error("Facility ID must be a valid UUID.");
      return;
    }

    const minQtyNum = Number(minQuantity);
    if (!minQuantity.trim() || !Number.isFinite(minQtyNum) || minQtyNum <= 0 || !Number.isInteger(minQtyNum)) {
      toast.error("Min Quantity is required and must be a positive integer.");
      return;
    }

    const orderQtyNum = Number(orderQuantity);
    if (!orderQuantity.trim() || !Number.isFinite(orderQtyNum) || orderQtyNum <= 0 || !Number.isInteger(orderQtyNum)) {
      toast.error("Order Quantity is required and must be a positive integer.");
      return;
    }

    if (loopType === "procurement" && !primarySupplierId.trim()) {
      toast.error("Primary Supplier ID is required for procurement loops.");
      return;
    }
    if (loopType === "procurement" && primarySupplierId.trim() && !UUID_RE.test(primarySupplierId.trim())) {
      toast.error("Primary Supplier ID must be a valid UUID.");
      return;
    }

    if (loopType === "transfer" && !sourceFacilityId.trim()) {
      toast.error("Source Facility ID is required for transfer loops.");
      return;
    }
    if (loopType === "transfer" && sourceFacilityId.trim() && !UUID_RE.test(sourceFacilityId.trim())) {
      toast.error("Source Facility ID must be a valid UUID.");
      return;
    }

    if (storageLocationId.trim() && !UUID_RE.test(storageLocationId.trim())) {
      toast.error("Storage Location ID must be a valid UUID.");
      return;
    }

    // ── Build input ──────────────────────────────────────────
    setIsSaving(true);

    try {
      const input: Parameters<typeof createLoop>[1] = {
        partId: partId.trim(),
        facilityId: facilityId.trim(),
        loopType,
        cardMode,
        minQuantity: minQtyNum,
        orderQuantity: orderQtyNum,
      };

      const cardsNum = Number(numberOfCards);
      if (Number.isFinite(cardsNum) && cardsNum > 0 && Number.isInteger(cardsNum)) {
        input.numberOfCards = cardsNum;
      }

      const leadNum = Number(statedLeadTimeDays);
      if (statedLeadTimeDays.trim() && Number.isFinite(leadNum) && leadNum > 0 && Number.isInteger(leadNum)) {
        input.statedLeadTimeDays = leadNum;
      }

      if (safetyStockDays.trim()) {
        input.safetyStockDays = safetyStockDays.trim();
      }

      if (loopType === "procurement" && primarySupplierId.trim()) {
        input.primarySupplierId = primarySupplierId.trim();
      }

      if (loopType === "transfer" && sourceFacilityId.trim()) {
        input.sourceFacilityId = sourceFacilityId.trim();
      }

      if (storageLocationId.trim()) {
        input.storageLocationId = storageLocationId.trim();
      }

      if (notes.trim()) {
        input.notes = notes.trim();
      }

      await createLoop(token, input);
      toast.success("Loop created successfully.");
      resetForm();
      setOpen(false);
      onCreated();
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === "LOOP_ALREADY_EXISTS"
      ) {
        const duplicateLoopId =
          typeof err.details?.loopId === "string" ? err.details.loopId : undefined;
        toast.info("Loop already exists. Opening existing loop.");
        setOpen(false);
        if (duplicateLoopId && onOpenExistingLoop) {
          onOpenExistingLoop(duplicateLoopId);
          return;
        }
        onCreated();
        return;
      }
      toast.error(parseApiError(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" />
          Create Loop
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Kanban Loop</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Part ID */}
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-partId">
              Part ID <span className="text-destructive">*</span>
            </label>
            <Input
              id="create-partId"
              value={partId}
              onChange={(e) => setPartId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              required
              className="mt-1 h-9 text-sm"
            />
          </div>

          {/* Facility */}
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-facility">
              Facility ID <span className="text-destructive">*</span>
            </label>
            <Input
              id="create-facility"
              value={facilityId}
              onChange={(e) => setFacilityId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              required
              className="mt-1 h-9 text-sm"
            />
          </div>

          {/* Loop Type */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Loop Type
            </label>
            <div className="mt-1 flex gap-2">
              {LOOP_ORDER.map((lt) => {
                const meta = LOOP_META[lt];
                const Icon = meta.icon;
                const isActive = loopType === lt;
                return (
                  <button
                    key={lt}
                    type="button"
                    onClick={() => setLoopType(lt)}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? "border-[hsl(var(--link))] bg-[hsl(var(--link)/0.08)] text-[hsl(var(--link))]"
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Primary Supplier ID — shown for procurement loops */}
          {loopType === "procurement" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-supplierId">
                Primary Supplier ID <span className="text-destructive">*</span>
              </label>
              <Input
                id="create-supplierId"
                value={primarySupplierId}
                onChange={(e) => setPrimarySupplierId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                required
                className="mt-1 h-9 text-sm"
              />
            </div>
          )}

          {/* Source Facility ID — shown for transfer loops */}
          {loopType === "transfer" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-sourceFacility">
                Source Facility ID <span className="text-destructive">*</span>
              </label>
              <Input
                id="create-sourceFacility"
                value={sourceFacilityId}
                onChange={(e) => setSourceFacilityId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                required
                className="mt-1 h-9 text-sm"
              />
            </div>
          )}

          {/* Card Mode */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Card Mode
            </label>
            <div className="mt-1 flex gap-2">
              {CARD_MODE_OPTIONS.map((opt) => {
                const isActive = cardMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setCardMode(opt.value)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? "border-[hsl(var(--link))] bg-[hsl(var(--link)/0.08)] text-[hsl(var(--link))]"
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Numeric fields row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-cards">
                Number of Cards
              </label>
              <Input
                id="create-cards"
                type="number"
                min={1}
                value={numberOfCards}
                onChange={(e) => setNumberOfCards(e.target.value)}
                disabled={cardMode === "single"}
                className="mt-1 h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-minQty">
                Min Quantity <span className="text-destructive">*</span>
              </label>
              <Input
                id="create-minQty"
                type="number"
                min={1}
                value={minQuantity}
                onChange={(e) => setMinQuantity(e.target.value)}
                placeholder="1"
                required
                className="mt-1 h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-orderQty">
                Order Quantity <span className="text-destructive">*</span>
              </label>
              <Input
                id="create-orderQty"
                type="number"
                min={1}
                value={orderQuantity}
                onChange={(e) => setOrderQuantity(e.target.value)}
                placeholder="1"
                required
                className="mt-1 h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-lead">
                Lead Time (days)
              </label>
              <Input
                id="create-lead"
                type="number"
                min={1}
                value={statedLeadTimeDays}
                onChange={(e) => setStatedLeadTimeDays(e.target.value)}
                placeholder="--"
                className="mt-1 h-9 text-sm"
              />
            </div>
          </div>

          {/* Storage Location ID */}
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-storageLocation">
              Storage Location ID
            </label>
            <Input
              id="create-storageLocation"
              value={storageLocationId}
              onChange={(e) => setStorageLocationId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="mt-1 h-9 text-sm"
            />
          </div>

          {/* Safety Stock Days */}
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-safetyStock">
              Safety Stock Days
            </label>
            <Input
              id="create-safetyStock"
              value={safetyStockDays}
              onChange={(e) => setSafetyStockDays(e.target.value)}
              placeholder="e.g. 3"
              className="mt-1 h-9 text-sm"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-notes">
              Notes
            </label>
            <textarea
              id="create-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
              className="mt-1 flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSaving}>
              {isSaving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Create Loop
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
