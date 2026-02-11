import type { PurchaseOrderLine } from "@/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@/components/ui";
import { cn } from "@/lib/utils";

/* ── Helpers ───────────────────────────────────────────────── */

function formatCurrency(
  amount: number | string | null | undefined,
  currency = "USD",
): string {
  if (amount === null || amount === undefined) return "—";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    num,
  );
}

/* ── Props ─────────────────────────────────────────────────── */

interface POLineItemsProps {
  lines: PurchaseOrderLine[];
  currency?: string;
}

/* ── Component ─────────────────────────────────────────────── */

export function POLineItems({ lines, currency = "USD" }: POLineItemsProps) {
  if (lines.length === 0) {
    return (
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Line Items</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground py-4 text-center">
            No line items on this order.
          </p>
        </CardContent>
      </Card>
    );
  }

  const grandTotal = lines.reduce((sum, line) => {
    const price = line.unitPrice ?? 0;
    return sum + price * line.quantityOrdered;
  }, 0);

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Line Items ({lines.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted">
                <th className="px-3 py-2 text-left font-semibold text-muted-foreground">
                  Part
                </th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">
                  Ordered
                </th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">
                  Received
                </th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">
                  Unit Price
                </th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">
                  Line Total
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((line) => {
                const lineTotal =
                  line.unitPrice !== null
                    ? line.unitPrice * line.quantityOrdered
                    : null;

                return (
                  <tr key={line.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium">
                      {line.partName ?? line.description ?? line.partId}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {line.quantityOrdered}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span
                        className={cn(
                          line.quantityReceived >= line.quantityOrdered
                            ? "text-emerald-600"
                            : line.quantityReceived > 0
                              ? "text-amber-600"
                              : "text-muted-foreground",
                        )}
                      >
                        {line.quantityReceived}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCurrency(line.unitPrice, currency)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {formatCurrency(lineTotal, currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 border-t border-border">
                <td
                  colSpan={4}
                  className="px-3 py-2 text-right font-semibold text-sm"
                >
                  Total
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-sm">
                  {formatCurrency(grandTotal, currency)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function POLineItemsSkeleton() {
  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-2">
        <Skeleton className="h-5 w-28" />
      </CardHeader>
      <CardContent className="p-0">
        <div className="space-y-0">
          <Skeleton className="h-9 w-full" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
