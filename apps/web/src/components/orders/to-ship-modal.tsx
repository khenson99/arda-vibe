/**
 * TOShipModal — Mark transfer order as shipped
 *
 * Allows updating shipped quantities for each line item and transitioning
 * the transfer order to "shipped" or "in_transit" status.
 */

import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { TruckIcon, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { isUnauthorized, parseApiError, updateTransferOrderStatus, shipTransferOrderLines } from "@/lib/api-client";
import type { TransferOrder } from "@/types";

// ─── Props ───────────────────────────────────────────────────────────

export interface TOShipModalProps {
  open: boolean;
  onClose: () => void;
  transferOrder: TransferOrder;
  token: string;
  onShipped: () => void;
  onUnauthorized: () => void;
}

// ─── Component ───────────────────────────────────────────────────────

export function TOShipModal({
  open,
  onClose,
  transferOrder,
  token,
  onShipped,
  onUnauthorized,
}: TOShipModalProps) {
  const [lineQuantities, setLineQuantities] = React.useState<Record<string, number>>({});
  const [trackingNumber, setTrackingNumber] = React.useState("");
  const [shippingNotes, setShippingNotes] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      const initial: Record<string, number> = {};
      transferOrder.lines?.forEach((line) => {
        initial[line.id] = line.quantityRequested - line.quantityShipped;
      });
      setLineQuantities(initial);
      setTrackingNumber("");
      setShippingNotes("");
      setError(null);
    }
  }, [open, transferOrder.lines]);

  // Check if we're in picking status (where line quantities can be updated)
  const isPickingStatus = transferOrder.status === "picking";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate that at least one line has quantity > 0 (only relevant when in picking status)
    if (isPickingStatus) {
      const hasQuantity = Object.values(lineQuantities).some((qty) => qty > 0);
      if (!hasQuantity) {
        setError("At least one line item must have a shipped quantity greater than 0");
        return;
      }
    }

    setSubmitting(true);
    try {
      const notes = [
        shippingNotes,
        trackingNumber ? `Tracking: ${trackingNumber}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      if (isPickingStatus) {
        // Build the lines payload with shipped quantities
        const shipLines = transferOrder.lines
          ?.map((line) => ({
            lineId: line.id,
            quantityShipped: (lineQuantities[line.id] ?? 0) + line.quantityShipped,
          }))
          .filter((l) => l.quantityShipped > 0) ?? [];

        // Ship the lines with their quantities
        // The backend will auto-transition to "shipped" if all lines are fully shipped
        await shipTransferOrderLines(token, transferOrder.id, { lines: shipLines });

        // If there are notes or tracking info, also update the status with that info
        if (notes) {
          await updateTransferOrderStatus(token, transferOrder.id, {
            status: "in_transit",
            reason: notes,
          });
        }
      } else {
        // Already shipped, just transition to in_transit
        await updateTransferOrderStatus(token, transferOrder.id, {
          status: "in_transit",
          reason: notes || "Marked as in transit from UI",
        });
      }

      toast.success("Transfer order marked as shipped");
      onShipped();
      onClose();
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TruckIcon className="h-5 w-5" />
            Ship Transfer Order
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          {/* Error message */}
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
              <span className="text-red-600 dark:text-red-400">{error}</span>
            </div>
          )}

          {/* Transfer details */}
          <Card className="rounded-lg">
            <CardContent className="p-3 space-y-1 text-sm">
              <div className="name-value-pair">
                <span className="text-muted-foreground">TO Number:</span>{" "}
                <span className="font-semibold">{transferOrder.toNumber}</span>
              </div>
              <div className="name-value-pair">
                <span className="text-muted-foreground">From:</span>{" "}
                <span className="font-semibold">{transferOrder.sourceFacilityName ?? transferOrder.sourceFacilityId}</span>
              </div>
              <div className="name-value-pair">
                <span className="text-muted-foreground">To:</span>{" "}
                <span className="font-semibold">{transferOrder.destinationFacilityName ?? transferOrder.destinationFacilityId}</span>
              </div>
            </CardContent>
          </Card>

          {/* Line items with quantities - only show editable quantities when in picking status */}
          <div className="space-y-2">
            <Label>{isPickingStatus ? "Shipped Quantities" : "Line Items"}</Label>
            <div className="space-y-2">
              {transferOrder.lines?.map((line) => {
                const remaining = line.quantityRequested - line.quantityShipped;
                return (
                  <Card key={line.id} className="rounded-lg">
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm truncate">{line.partName ?? line.partId}</p>
                          <p className="text-xs text-muted-foreground">
                            Requested: {line.quantityRequested} | Shipped: {line.quantityShipped}
                            {isPickingStatus && ` | Remaining: ${remaining}`}
                          </p>
                        </div>
                        {isPickingStatus && (
                          <div className="w-24">
                            <Input
                              type="number"
                              min={0}
                              max={remaining}
                              value={lineQuantities[line.id] ?? 0}
                              onChange={(e) =>
                                setLineQuantities((prev) => ({
                                  ...prev,
                                  [line.id]: parseInt(e.target.value, 10) || 0,
                                }))
                              }
                              className="text-center"
                            />
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>

          {/* Tracking number */}
          <div className="space-y-2">
            <Label htmlFor="trackingNumber">Tracking Number (Optional)</Label>
            <Input
              id="trackingNumber"
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
              placeholder="Enter tracking number..."
            />
          </div>

          {/* Shipping notes */}
          <div className="space-y-2">
            <Label htmlFor="shippingNotes">Shipping Notes (Optional)</Label>
            <Textarea
              id="shippingNotes"
              value={shippingNotes}
              onChange={(e) => setShippingNotes(e.target.value)}
              placeholder="Add any shipping notes..."
              rows={3}
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Processing..." : "Mark as Shipped"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
