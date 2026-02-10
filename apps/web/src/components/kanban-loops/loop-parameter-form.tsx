import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button, Input } from "@/components/ui";
import {
  isUnauthorized,
  parseApiError,
  updateLoopParameters,
} from "@/lib/api-client";
import type { KanbanLoop } from "@/types";

interface LoopParameterFormProps {
  loop: KanbanLoop;
  token: string;
  onUnauthorized: () => void;
  onSaved: () => void;
  onCancel: () => void;
}

export function LoopParameterForm({
  loop,
  token,
  onUnauthorized,
  onSaved,
  onCancel,
}: LoopParameterFormProps) {
  const [minQuantity, setMinQuantity] = React.useState(String(loop.minQuantity));
  const [orderQuantity, setOrderQuantity] = React.useState(String(loop.orderQuantity));
  const [numberOfCards, setNumberOfCards] = React.useState(String(loop.numberOfCards));
  const [statedLeadTimeDays, setStatedLeadTimeDays] = React.useState(
    loop.statedLeadTimeDays != null ? String(loop.statedLeadTimeDays) : "",
  );
  const [safetyStockDays, setSafetyStockDays] = React.useState(
    loop.safetyStockDays != null ? String(loop.safetyStockDays) : "",
  );
  const [reason, setReason] = React.useState("");
  const [isSaving, setIsSaving] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!reason.trim()) {
      toast.error("Reason is required for audit trail.");
      return;
    }

    setIsSaving(true);

    try {
      const input: Record<string, unknown> = { reason: reason.trim() };

      const minQtyNum = Number(minQuantity);
      if (Number.isFinite(minQtyNum) && minQtyNum !== loop.minQuantity) {
        input.minQuantity = minQtyNum;
      }

      const orderQtyNum = Number(orderQuantity);
      if (Number.isFinite(orderQtyNum) && orderQtyNum !== loop.orderQuantity) {
        input.orderQuantity = orderQtyNum;
      }

      const cardsNum = Number(numberOfCards);
      if (Number.isFinite(cardsNum) && cardsNum !== loop.numberOfCards) {
        input.numberOfCards = cardsNum;
      }

      const leadNum = statedLeadTimeDays.trim() ? Number(statedLeadTimeDays) : undefined;
      if (leadNum !== undefined && Number.isFinite(leadNum) && leadNum !== loop.statedLeadTimeDays) {
        input.statedLeadTimeDays = leadNum;
      }

      const safetyNum = safetyStockDays.trim() ? Number(safetyStockDays) : undefined;
      if (safetyNum !== undefined && Number.isFinite(safetyNum) && safetyNum !== loop.safetyStockDays) {
        input.safetyStockDays = safetyNum;
      }

      await updateLoopParameters(token, loop.id, input as Parameters<typeof updateLoopParameters>[2]);
      toast.success("Loop parameters updated.");
      onSaved();
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {/* Min Quantity */}
        <div>
          <label className="text-xs font-medium text-muted-foreground" htmlFor="param-minQty">
            Min Quantity
          </label>
          <Input
            id="param-minQty"
            type="number"
            min={0}
            value={minQuantity}
            onChange={(e) => setMinQuantity(e.target.value)}
            className="mt-1 h-8 text-sm"
          />
        </div>

        {/* Order Quantity */}
        <div>
          <label className="text-xs font-medium text-muted-foreground" htmlFor="param-orderQty">
            Order Quantity
          </label>
          <Input
            id="param-orderQty"
            type="number"
            min={0}
            value={orderQuantity}
            onChange={(e) => setOrderQuantity(e.target.value)}
            className="mt-1 h-8 text-sm"
          />
        </div>

        {/* Number of Cards */}
        <div>
          <label className="text-xs font-medium text-muted-foreground" htmlFor="param-cards">
            Number of Cards
          </label>
          <Input
            id="param-cards"
            type="number"
            min={1}
            value={numberOfCards}
            onChange={(e) => setNumberOfCards(e.target.value)}
            className="mt-1 h-8 text-sm"
          />
        </div>

        {/* Lead Time */}
        <div>
          <label className="text-xs font-medium text-muted-foreground" htmlFor="param-lead">
            Lead Time (days)
          </label>
          <Input
            id="param-lead"
            type="number"
            min={0}
            value={statedLeadTimeDays}
            onChange={(e) => setStatedLeadTimeDays(e.target.value)}
            placeholder="--"
            className="mt-1 h-8 text-sm"
          />
        </div>

        {/* Safety Stock */}
        <div>
          <label className="text-xs font-medium text-muted-foreground" htmlFor="param-safety">
            Safety Stock (days)
          </label>
          <Input
            id="param-safety"
            type="number"
            min={0}
            value={safetyStockDays}
            onChange={(e) => setSafetyStockDays(e.target.value)}
            placeholder="--"
            className="mt-1 h-8 text-sm"
          />
        </div>
      </div>

      {/* Reason (required) */}
      <div>
        <label className="text-xs font-medium text-muted-foreground" htmlFor="param-reason">
          Reason <span className="text-destructive">*</span>
        </label>
        <Input
          id="param-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Adjusted based on Q1 demand forecast"
          required
          className="mt-1 h-8 text-sm"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" disabled={isSaving}>
          {isSaving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          Save Changes
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
