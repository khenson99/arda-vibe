import * as React from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ProductSource, EnrichedProduct } from "../types";
import { useImportContext } from "../import-context";

const SOURCE_COLORS: Record<ProductSource, string> = {
  "email-import": "bg-[hsl(var(--arda-blue)/0.1)] text-[hsl(var(--arda-blue))]",
  "api-enrichment": "bg-[hsl(var(--arda-success)/0.1)] text-[hsl(var(--arda-success))]",
  "upc-scan": "bg-[hsl(var(--arda-orange)/0.1)] text-[hsl(var(--arda-orange))]",
  "ai-image": "bg-purple-100 text-purple-700",
  "link-scrape": "bg-cyan-100 text-cyan-700",
  "csv-upload": "bg-amber-100 text-amber-700",
  manual: "bg-muted text-muted-foreground",
};

interface ReconcileSyncModuleProps {
  onSync?: (products: EnrichedProduct[]) => void;
}

export function ReconcileSyncModule({ onSync }: ReconcileSyncModuleProps) {
  const { state, dispatch } = useImportContext();
  const { reconciliationItems: items, isSyncing } = state;
  const reconciliationSourceSignature = React.useMemo(
    () =>
      JSON.stringify({
        enriched: state.enrichedProducts.length,
        resolvedUpcs: state.upcScans.filter((scan) => scan.status === "resolved").length,
        imageSelections: state.imageIdentifications.filter(
          (img) => img.status === "complete" && Boolean(img.selectedPrediction),
        ).length,
        linkScrapes: state.linkImports.filter((link) => link.status === "scraped").length,
        csvRows: state.csvResult?.parsedItems.length ?? 0,
      }),
    [
      state.csvResult?.parsedItems.length,
      state.enrichedProducts.length,
      state.imageIdentifications,
      state.linkImports,
      state.upcScans,
    ],
  );

  React.useEffect(() => {
    dispatch({ type: "BUILD_RECONCILIATION" });
  }, [dispatch, reconciliationSourceSignature]);

  const approvedCount = items.filter((i) => i.isApproved).length;

  const handleSync = async () => {
    dispatch({ type: "SET_SYNCING", value: true });
    await new Promise((r) => setTimeout(r, 3000));
    dispatch({ type: "SET_SYNCING", value: false });

    const approved = items.filter((item) => item.isApproved);
    onSync?.(approved);
    dispatch({ type: "CLOSE_MODULE" });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
                Reconcile & Sync to Arda
              </CardTitle>
              <CardDescription>
                Review all products gathered from every source. Approve, edit, or remove
                items before syncing to your Arda workspace.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              We&apos;re waiting for source data. Add items from any import step and this page
              will aggregate reconciliation automatically.
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border bg-card p-4 text-center">
                  <p className="text-2xl font-bold">{items.length}</p>
                  <p className="text-xs text-muted-foreground">Total Products</p>
                </div>
                <div className="rounded-xl border bg-[hsl(var(--arda-success)/0.06)] border-[hsl(var(--arda-success)/0.2)] p-4 text-center">
                  <p className="text-2xl font-bold text-[hsl(var(--arda-success))]">
                    {approvedCount}
                  </p>
                  <p className="text-xs text-muted-foreground">Approved for Sync</p>
                </div>
                <div className="rounded-xl border bg-[hsl(var(--arda-warning)/0.06)] border-[hsl(var(--arda-warning)/0.2)] p-4 text-center">
                  <p className="text-2xl font-bold text-[hsl(var(--arda-warning))]">
                    {items.filter((i) => i.needsReview).length}
                  </p>
                  <p className="text-xs text-muted-foreground">Needs Review</p>
                </div>
              </div>

              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={cn(
                      "rounded-xl border p-3 transition-colors",
                      item.isApproved
                        ? "border-[hsl(var(--arda-success)/0.25)] bg-[hsl(var(--arda-success)/0.03)]"
                        : "border-border bg-card",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={item.isApproved}
                        onChange={() => dispatch({ type: "TOGGLE_RECONCILIATION_APPROVAL", id: item.id })}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold">{item.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {item.vendorName}
                              {item.sku ? ` • SKU: ${item.sku}` : ""}
                              {item.asin ? ` • ASIN: ${item.asin}` : ""}
                            </p>
                          </div>
                          <Badge
                            variant={
                              item.confidence >= 80
                                ? "success"
                                : item.confidence >= 60
                                  ? "warning"
                                  : "destructive"
                            }
                          >
                            {item.confidence}%
                          </Badge>
                        </div>

                        <div className="flex flex-wrap gap-1">
                          {item.sources.map((source, idx) => (
                            <span
                              key={idx}
                              className={cn(
                                "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium",
                                SOURCE_COLORS[source],
                              )}
                            >
                              {source.replace("-", " ")}
                            </span>
                          ))}
                        </div>

                        <div className="flex items-center gap-4 text-xs">
                          <div className="name-value-pair">
                            <span className="name-value-pair-label">MOQ:</span>
                            <span className="name-value-pair-value">{item.moq}</span>
                          </div>
                          {item.orderCadenceDays && (
                            <div className="name-value-pair">
                              <span className="name-value-pair-label">Cadence:</span>
                              <span className="name-value-pair-value">
                                {item.orderCadenceDays}d
                              </span>
                            </div>
                          )}
                          {item.unitPrice && (
                            <div className="name-value-pair">
                              <span className="name-value-pair-label">Price:</span>
                              <span className="name-value-pair-value">
                                ${item.unitPrice.toFixed(2)}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between rounded-xl bg-muted p-4">
                <p className="text-sm">
                  <strong>{approvedCount}</strong> of {items.length} products will be synced
                </p>
                <Button
                  onClick={() => void handleSync()}
                  disabled={isSyncing || approvedCount === 0}
                >
                  {isSyncing ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Syncing to Arda...
                    </span>
                  ) : (
                    <>
                      <ShieldCheck className="h-4 w-4" />
                      Sync {approvedCount} Products to Arda
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
