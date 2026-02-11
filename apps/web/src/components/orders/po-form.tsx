/**
 * POForm — Purchase Order create/edit form
 *
 * Follows Arda design system with proper form structure, validation,
 * and integration with supplier/facility/part lookups.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { POLineEditor } from "./po-line-editor";
import { validatePOForm } from "./po-form-schema";
import type { PurchaseOrder, POStatus, SupplierRecord, FacilityRecord } from "@/types";

// ─── Types ───────────────────────────────────────────────────────────

export interface POLineInput {
  partId: string;
  partName?: string;
  partNumber?: string;
  lineNumber: number;
  quantityOrdered: number;
  unitCost: number;
  notes?: string | null;
  kanbanCardId?: string | null;
}

export interface POFormInput {
  supplierId: string;
  facilityId: string;
  orderDate?: string;
  expectedDeliveryDate: string;
  currency?: string;
  notes?: string | null;
  internalNotes?: string | null;
  paymentTerms?: string | null;
  shippingTerms?: string | null;
  lines: POLineInput[];
}

export interface POFormProps {
  mode: "create" | "edit";
  po?: PurchaseOrder;
  suppliers: SupplierRecord[];
  facilities: FacilityRecord[];
  onSubmit: (data: POFormInput) => Promise<void>;
  onCancel: () => void;
  loading?: boolean;
  error?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────

export function POForm({
  mode,
  po,
  suppliers,
  facilities,
  onSubmit,
  onCancel,
  loading = false,
  error = null,
}: POFormProps) {
  const [supplierId, setSupplierId] = React.useState(po?.supplierId || "");
  const [facilityId, setFacilityId] = React.useState(po?.facilityId || "");
  const [orderDate, setOrderDate] = React.useState(
    po?.orderedAt ? po.orderedAt.split("T")[0] : new Date().toISOString().split("T")[0]
  );
  const [expectedDeliveryDate, setExpectedDeliveryDate] = React.useState(
    po?.expectedDeliveryDate ? po.expectedDeliveryDate.split("T")[0] : ""
  );
  const [currency, setCurrency] = React.useState(po?.currency || "USD");
  const [notes, setNotes] = React.useState(po?.notes || "");
  const [internalNotes, setInternalNotes] = React.useState(po?.internalNotes || "");
  const [paymentTerms, setPaymentTerms] = React.useState(po?.paymentTerms || "");
  const [shippingTerms, setShippingTerms] = React.useState(po?.shippingTerms || "");
  const [lines, setLines] = React.useState<POLineInput[]>(
    po?.lines?.map((line, idx) => ({
      partId: line.partId,
      partName: line.partName,
      lineNumber: idx + 1,
      quantityOrdered: line.quantityOrdered,
      unitCost: line.unitPrice || 0,
      notes: line.notes,
      kanbanCardId: null,
    })) || []
  );
  const [validationErrors, setValidationErrors] = React.useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const payload: POFormInput = {
      supplierId,
      facilityId,
      orderDate,
      expectedDeliveryDate,
      currency,
      notes: notes || null,
      internalNotes: mode === "create" ? (internalNotes || null) : undefined,
      paymentTerms: paymentTerms || null,
      shippingTerms: shippingTerms || null,
      lines,
    };

    const result = validatePOForm(payload);
    if (!result.success) {
      setValidationErrors(result.errors);
      return;
    }

    setValidationErrors({});
    await onSubmit(payload);
  };

  const handleAddLine = (line: POLineInput) => {
    setLines((prev) => [...prev, { ...line, lineNumber: prev.length + 1 }]);
  };

  const handleUpdateLine = (index: number, line: POLineInput) => {
    setLines((prev) => prev.map((l, i) => (i === index ? line : l)));
  };

  const handleRemoveLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Card className="card-arda">
        <CardHeader>
          <CardTitle>{mode === "create" ? "Create Purchase Order" : "Edit Purchase Order"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Error message */}
          {error && (
            <div className="rounded-md border border-[hsl(var(--arda-error))] bg-[hsl(var(--arda-error-light))] px-4 py-3 text-sm text-[hsl(var(--arda-error))]">
              {error}
            </div>
          )}

          {/* Supplier & Facility */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="supplierId">
                Supplier <span className="text-[hsl(var(--arda-error))]">*</span>
              </Label>
              <Select value={supplierId} onValueChange={setSupplierId} disabled={mode === "edit"}>
                <SelectTrigger
                  id="supplierId"
                  className={cn(validationErrors.supplierId && "border-[hsl(var(--arda-error))]")}
                >
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {validationErrors.supplierId && (
                <p className="text-xs text-[hsl(var(--arda-error))]">{validationErrors.supplierId}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="facilityId">
                Ship To (Facility) <span className="text-[hsl(var(--arda-error))]">*</span>
              </Label>
              <Select value={facilityId} onValueChange={setFacilityId} disabled={mode === "edit"}>
                <SelectTrigger
                  id="facilityId"
                  className={cn(validationErrors.facilityId && "border-[hsl(var(--arda-error))]")}
                >
                  <SelectValue placeholder="Select facility" />
                </SelectTrigger>
                <SelectContent>
                  {facilities.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name} ({f.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {validationErrors.facilityId && (
                <p className="text-xs text-[hsl(var(--arda-error))]">{validationErrors.facilityId}</p>
              )}
            </div>
          </div>

          {/* Dates & Currency */}
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="orderDate">Order Date</Label>
              <Input
                id="orderDate"
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="expectedDeliveryDate">
                Expected Delivery <span className="text-[hsl(var(--arda-error))]">*</span>
              </Label>
              <Input
                id="expectedDeliveryDate"
                type="date"
                value={expectedDeliveryDate}
                onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                className={cn(validationErrors.expectedDeliveryDate && "border-[hsl(var(--arda-error))]")}
              />
              {validationErrors.expectedDeliveryDate && (
                <p className="text-xs text-[hsl(var(--arda-error))]">{validationErrors.expectedDeliveryDate}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                  <SelectItem value="GBP">GBP</SelectItem>
                  <SelectItem value="CAD">CAD</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Payment & Shipping Terms */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="paymentTerms">Payment Terms</Label>
              <Input
                id="paymentTerms"
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
                placeholder="e.g., Net 30"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="shippingTerms">Shipping Terms</Label>
              <Input
                id="shippingTerms"
                value={shippingTerms}
                onChange={(e) => setShippingTerms(e.target.value)}
                placeholder="e.g., FOB, CIF"
              />
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes (visible to supplier)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              rows={3}
              placeholder="Any additional notes for the supplier"
            />
          </div>

          {mode === "create" && (
            <div className="space-y-2">
              <Label htmlFor="internalNotes">Internal Notes (not visible to supplier)</Label>
              <Textarea
                id="internalNotes"
                value={internalNotes}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInternalNotes(e.target.value)}
                rows={2}
                placeholder="Internal notes for your team"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Line Items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line Items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {validationErrors.lines && (
            <p className="text-sm text-[hsl(var(--arda-error))]">{validationErrors.lines}</p>
          )}
          <POLineEditor
            lines={lines}
            onAddLine={handleAddLine}
            onUpdateLine={handleUpdateLine}
            onRemoveLine={handleRemoveLine}
            validationErrors={validationErrors}
          />
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button type="submit" disabled={loading}>
          {loading ? "Saving..." : mode === "create" ? "Create PO" : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}
