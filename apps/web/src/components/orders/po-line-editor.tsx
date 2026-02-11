/**
 * POLineEditor — Purchase Order line item editor
 *
 * Allows adding, editing, and removing PO line items with part search,
 * quantity, unit price, and notes fields.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { X, Plus, Search } from "lucide-react";
import { fetchParts } from "@/lib/api-client";
import { readStoredSession } from "@/lib/api-client";
import type { PartRecord } from "@/types";
import type { POLineInput } from "./po-form";

// ─── Types ───────────────────────────────────────────────────────────

export interface POLineEditorProps {
  lines: POLineInput[];
  onAddLine: (line: POLineInput) => void;
  onUpdateLine: (index: number, line: POLineInput) => void;
  onRemoveLine: (index: number) => void;
  validationErrors?: Record<string, string>;
}

// ─── Component ───────────────────────────────────────────────────────

export function POLineEditor({
  lines,
  onAddLine,
  onUpdateLine,
  onRemoveLine,
  validationErrors = {},
}: POLineEditorProps) {
  const [isAddingLine, setIsAddingLine] = React.useState(false);
  const [newLine, setNewLine] = React.useState<Partial<POLineInput>>({
    quantityOrdered: 1,
    unitCost: 0,
  });
  const [parts, setParts] = React.useState<PartRecord[]>([]);
  const [partsLoading, setPartsLoading] = React.useState(false);
  const [partSearch, setPartSearch] = React.useState("");
  const [partPopoverOpen, setPartPopoverOpen] = React.useState(false);

  // Load parts on mount
  React.useEffect(() => {
    const session = readStoredSession();
    if (!session) return;

    setPartsLoading(true);
    fetchParts(session.tokens.accessToken)
      .then((res) => setParts(res.data))
      .catch(() => {})
      .finally(() => setPartsLoading(false));
  }, []);

  const handleAddLine = () => {
    if (!newLine.partId || !newLine.quantityOrdered || newLine.unitCost === undefined) return;

    const selectedPart = parts.find((p) => p.id === newLine.partId);
    onAddLine({
      partId: newLine.partId,
      partName: selectedPart?.name,
      partNumber: selectedPart?.partNumber,
      lineNumber: lines.length + 1,
      quantityOrdered: newLine.quantityOrdered,
      unitCost: newLine.unitCost,
      notes: newLine.notes || null,
      kanbanCardId: null,
    });

    setNewLine({ quantityOrdered: 1, unitCost: 0 });
    setIsAddingLine(false);
    setPartSearch("");
  };

  const handleSelectPart = (partId: string) => {
    const part = parts.find((p) => p.id === partId);
    setNewLine((prev) => ({
      ...prev,
      partId,
      unitCost: typeof part?.unitPrice === "number" ? part.unitPrice : parseFloat(String(part?.unitPrice || "0")) || 0,
    }));
    setPartSearch(part?.partNumber || "");
    setPartPopoverOpen(false);
  };

  const filteredParts = parts.filter(
    (p) =>
      partSearch.length === 0 ||
      p.partNumber.toLowerCase().includes(partSearch.toLowerCase()) ||
      p.name.toLowerCase().includes(partSearch.toLowerCase())
  );

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(value);
  };

  const totalAmount = lines.reduce((sum, line) => sum + line.quantityOrdered * line.unitCost, 0);

  return (
    <div className="space-y-3">
      {/* Existing Lines */}
      {lines.length > 0 && (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted">
                <th className="px-3 py-2 text-left font-medium">#</th>
                <th className="px-3 py-2 text-left font-medium">Part</th>
                <th className="px-3 py-2 text-right font-medium">Quantity</th>
                <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-center font-medium w-16">Actions</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => {
                const lineTotal = line.quantityOrdered * line.unitCost;
                return (
                  <tr key={idx} className="border-t hover:bg-muted/50">
                    <td className="px-3 py-2 text-muted-foreground">{idx + 1}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{line.partNumber || line.partId}</div>
                      {line.partName && <div className="text-xs text-muted-foreground">{line.partName}</div>}
                      {line.notes && <div className="text-xs text-muted-foreground italic">{line.notes}</div>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={line.quantityOrdered}
                        onChange={(e) =>
                          onUpdateLine(idx, { ...line, quantityOrdered: parseInt(e.target.value) || 1 })
                        }
                        className={cn(
                          "w-24 text-right h-8",
                          validationErrors[`line-${idx}-quantity`] && "border-[hsl(var(--arda-error))]"
                        )}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.unitCost}
                        onChange={(e) => onUpdateLine(idx, { ...line, unitCost: parseFloat(e.target.value) || 0 })}
                        className={cn(
                          "w-28 text-right h-8",
                          validationErrors[`line-${idx}-unitCost`] && "border-[hsl(var(--arda-error))]"
                        )}
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(lineTotal)}</td>
                    <td className="px-3 py-2 text-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onRemoveLine(idx)}
                        className="h-7 w-7 p-0"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/50">
                <td colSpan={4} className="px-3 py-2 text-right font-semibold">
                  Total
                </td>
                <td className="px-3 py-2 text-right font-bold">{formatCurrency(totalAmount)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Add Line Form */}
      {isAddingLine ? (
        <div className="rounded-md border bg-muted/20 p-4 space-y-3">
          <div className="grid grid-cols-12 gap-3">
            {/* Part Search */}
            <div className="col-span-5 space-y-1">
              <Label htmlFor="new-line-part">
                Part <span className="text-[hsl(var(--arda-error))]">*</span>
              </Label>
              <Popover open={partPopoverOpen} onOpenChange={setPartPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className={cn("w-full justify-between", !newLine.partId && "text-muted-foreground")}
                  >
                    <span className="truncate">{partSearch || "Search parts..."}</span>
                    <Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command>
                    <CommandInput
                      placeholder="Search by part number or name..."
                      value={partSearch}
                      onValueChange={setPartSearch}
                    />
                    <CommandList>
                      <CommandEmpty>{partsLoading ? "Loading..." : "No parts found."}</CommandEmpty>
                      {filteredParts.slice(0, 20).map((part) => (
                        <CommandItem key={part.id} value={part.id} onSelect={() => handleSelectPart(part.id)}>
                          <div className="flex flex-col">
                            <span className="font-medium">{part.partNumber}</span>
                            <span className="text-xs text-muted-foreground">{part.name}</span>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            {/* Quantity */}
            <div className="col-span-2 space-y-1">
              <Label htmlFor="new-line-quantity">
                Quantity <span className="text-[hsl(var(--arda-error))]">*</span>
              </Label>
              <Input
                id="new-line-quantity"
                type="number"
                min="1"
                step="1"
                value={newLine.quantityOrdered || ""}
                onChange={(e) => setNewLine((prev) => ({ ...prev, quantityOrdered: parseInt(e.target.value) || 1 }))}
              />
            </div>

            {/* Unit Cost */}
            <div className="col-span-2 space-y-1">
              <Label htmlFor="new-line-unitCost">
                Unit Cost <span className="text-[hsl(var(--arda-error))]">*</span>
              </Label>
              <Input
                id="new-line-unitCost"
                type="number"
                min="0"
                step="0.01"
                value={newLine.unitCost ?? ""}
                onChange={(e) => setNewLine((prev) => ({ ...prev, unitCost: parseFloat(e.target.value) || 0 }))}
              />
            </div>

            {/* Notes */}
            <div className="col-span-3 space-y-1">
              <Label htmlFor="new-line-notes">Notes</Label>
              <Input
                id="new-line-notes"
                value={newLine.notes || ""}
                onChange={(e) => setNewLine((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="Optional"
              />
            </div>
          </div>

          {/* Add / Cancel Buttons */}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={handleAddLine} disabled={!newLine.partId}>
              Add Line
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsAddingLine(false);
                setNewLine({ quantityOrdered: 1, unitCost: 0 });
                setPartSearch("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setIsAddingLine(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Line Item
        </Button>
      )}
    </div>
  );
}
