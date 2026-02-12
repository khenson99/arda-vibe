/**
 * POApprovalModal — Purchase Order approval/rejection modal
 *
 * Allows approving or rejecting a PO with optional comments.
 * Follows Arda design system with proper form structure and validation.
 */

import * as React from "react";
import { SidePanel } from "@/components/ui/side-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { PurchaseOrder } from "@/types";

// ─── Types ───────────────────────────────────────────────────────────

export interface POApprovalModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  po: PurchaseOrder | null;
  onApprove: (poId: string, notes?: string) => Promise<void>;
  onReject: (poId: string, reason: string) => Promise<void>;
  loading?: boolean;
  error?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────

export function POApprovalModal({
  open,
  onOpenChange,
  po,
  onApprove,
  onReject,
  loading = false,
  error = null,
}: POApprovalModalProps) {
  const [action, setAction] = React.useState<"approve" | "reject" | null>(null);
  const [comments, setComments] = React.useState("");
  const [validationError, setValidationError] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setAction(null);
      setComments("");
      setValidationError("");
    }
  }, [open]);

  if (!po) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError("");

    if (action === "reject" && !comments.trim()) {
      setValidationError("Rejection reason is required");
      return;
    }

    try {
      if (action === "approve") {
        await onApprove(po.id, comments || undefined);
      } else if (action === "reject") {
        await onReject(po.id, comments);
      }
      onOpenChange(false);
    } catch (err) {
      // Error is handled by parent component via error prop
    }
  };

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return "--";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: po.currency,
    }).format(amount);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "--";
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <SidePanel
      open={open}
      onClose={() => onOpenChange(false)}
      title="Review Purchase Order"
      subtitle="Review details and approve or reject this purchase order"
      width="wide"
    >
      <form onSubmit={handleSubmit} className="space-y-4 p-4">
          {/* Error message */}
          {error && (
            <div className="rounded-md border border-[hsl(var(--arda-error))] bg-[hsl(var(--arda-error-light))] px-4 py-3 text-sm text-[hsl(var(--arda-error))]">
              {error}
            </div>
          )}

          {/* PO Summary */}
          <div className="rounded-md border p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-semibold text-lg">{po.poNumber}</div>
                <Badge variant="warning" className="mt-1">
                  Pending Approval
                </Badge>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold">{formatCurrency(po.totalAmount)}</div>
                <div className="text-xs text-muted-foreground">{po.currency}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="name-value-pair">
                <span className="text-muted-foreground">Supplier:</span>{" "}
                <span className="font-semibold">{po.supplierName || "--"}</span>
              </div>
              <div className="name-value-pair">
                <span className="text-muted-foreground">Facility:</span>{" "}
                <span className="font-semibold">{po.facilityId}</span>
              </div>
              <div className="name-value-pair">
                <span className="text-muted-foreground">Order Date:</span>{" "}
                <span className="font-semibold">{formatDate(po.orderedAt)}</span>
              </div>
              <div className="name-value-pair">
                <span className="text-muted-foreground">Expected Delivery:</span>{" "}
                <span className="font-semibold">{formatDate(po.expectedDeliveryDate)}</span>
              </div>
            </div>

            {(po.paymentTerms || po.shippingTerms) && (
              <div className="grid grid-cols-2 gap-4 text-sm pt-2 border-t">
                {po.paymentTerms && (
                  <div className="name-value-pair">
                    <span className="text-muted-foreground">Payment Terms:</span>{" "}
                    <span className="font-semibold">{po.paymentTerms}</span>
                  </div>
                )}
                {po.shippingTerms && (
                  <div className="name-value-pair">
                    <span className="text-muted-foreground">Shipping Terms:</span>{" "}
                    <span className="font-semibold">{po.shippingTerms}</span>
                  </div>
                )}
              </div>
            )}

            {po.notes && (
              <div className="text-sm pt-2 border-t">
                <span className="text-muted-foreground">Notes:</span> <span>{po.notes}</span>
              </div>
            )}
          </div>

          {/* Line Items */}
          <div className="rounded-md border">
            <div className="bg-muted px-3 py-2 font-medium text-sm">Line Items</div>
            <div className="divide-y max-h-64 overflow-y-auto">
              {po.lines?.map((line) => (
                <div key={line.id} className="px-3 py-2 text-sm">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="font-medium">{line.partName || line.partId}</div>
                      {line.notes && <div className="text-xs text-muted-foreground italic">{line.notes}</div>}
                    </div>
                    <div className="text-right ml-4">
                      <div className="font-medium">
                        {line.quantityOrdered} × {formatCurrency(line.unitPrice)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        = {formatCurrency((line.unitPrice || 0) * line.quantityOrdered)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t bg-muted/50 px-3 py-2 flex items-center justify-between">
              <span className="font-semibold text-sm">Total</span>
              <span className="font-bold">{formatCurrency(po.totalAmount)}</span>
            </div>
          </div>

          {/* Action Selection */}
          {!action && (
            <div className="flex items-center gap-3 pt-4">
              <Button type="button" onClick={() => setAction("approve")} className="flex-1">
                Approve
              </Button>
              <Button type="button" variant="destructive" onClick={() => setAction("reject")} className="flex-1">
                Reject
              </Button>
            </div>
          )}

          {/* Comments Field */}
          {action && (
            <>
              <div className="space-y-2">
                <Label htmlFor="approval-comments">
                  {action === "approve" ? "Approval Comments (optional)" : "Rejection Reason"}
                  {action === "reject" && <span className="text-[hsl(var(--arda-error))]"> *</span>}
                </Label>
                <Textarea
                  id="approval-comments"
                  value={comments}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setComments(e.target.value)}
                  rows={3}
                  placeholder={
                    action === "approve"
                      ? "Add any comments about this approval..."
                      : "Explain why this PO is being rejected"
                  }
                  className={validationError ? "border-[hsl(var(--arda-error))]" : ""}
                />
                {validationError && <p className="text-xs text-[hsl(var(--arda-error))]">{validationError}</p>}
              </div>

              {/* Submit / Back Buttons */}
              <div className="flex items-center gap-3 pt-2">
                <Button type="button" variant="ghost" onClick={() => setAction(null)} disabled={loading}>
                  Back
                </Button>
                <Button
                  type="submit"
                  variant={action === "approve" ? "default" : "destructive"}
                  disabled={loading}
                  className="flex-1"
                >
                  {loading ? "Processing..." : action === "approve" ? "Confirm Approval" : "Confirm Rejection"}
                </Button>
              </div>
            </>
          )}

          {/* Cancel Button (always visible) */}
          {!action && (
            <div className="flex justify-end pt-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
            </div>
          )}
      </form>
    </SidePanel>
  );
}
