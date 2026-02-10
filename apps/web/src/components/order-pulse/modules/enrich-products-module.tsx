import * as React from "react";
import { Loader2, Sparkles } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import { enrichEmailOrdersWithAi, parseApiError, readStoredSession } from "@/lib/api-client";
import { useImportContext, nextId } from "../import-context";
import type { EnrichedProduct } from "../types";

function toEnrichedProducts(products: Awaited<ReturnType<typeof enrichEmailOrdersWithAi>>["products"]): EnrichedProduct[] {
  return products.map((product) => ({
    id: nextId("prod"),
    name: product.name,
    sku: product.sku,
    asin: product.asin,
    upc: product.upc,
    imageUrl: product.imageUrl,
    vendorId: product.vendorId,
    vendorName: product.vendorName,
    productUrl: product.productUrl,
    description: product.description,
    unitPrice: product.unitPrice,
    moq: product.moq,
    orderCadenceDays: product.orderCadenceDays,
    source: "email-import",
    confidence: product.confidence,
    needsReview: product.needsReview,
  }));
}

export function EnrichProductsModule() {
  const { state, dispatch } = useImportContext();
  const { enrichedProducts: products, isEnriching, detectedOrders } = state;
  const [enrichWarning, setEnrichWarning] = React.useState<string | null>(null);
  const [enrichError, setEnrichError] = React.useState<string | null>(null);
  const [enrichMode, setEnrichMode] = React.useState<"ai" | "heuristic" | null>(null);

  const orderItemCount = detectedOrders.reduce((n, o) => n + o.items.length, 0);

  const handleEnrich = React.useCallback(async () => {
    if (isEnriching) return;
    setEnrichError(null);
    setEnrichWarning(null);

    const session = readStoredSession();
    const accessToken = session?.tokens.accessToken;
    if (!accessToken) {
      setEnrichError("Sign in again to run AI enrichment.");
      return;
    }

    if (detectedOrders.length === 0) {
      setEnrichError("Analyze Gmail orders first so there are line items to enrich.");
      return;
    }

    dispatch({ type: "SET_ENRICHING", value: true });
    try {
      const result = await enrichEmailOrdersWithAi(accessToken, {
        orders: detectedOrders.map((order) => ({
          vendorId: order.vendorId,
          vendorName: order.vendorName,
          orderDate: order.orderDate,
          orderNumber: order.orderNumber,
          items: order.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            sku: item.sku,
            asin: item.asin,
            unitPrice: item.unitPrice,
            url: item.url,
          })),
        })),
      });

      dispatch({ type: "SET_ENRICHED_PRODUCTS", products: toEnrichedProducts(result.products) });
      setEnrichMode(result.mode);
      setEnrichWarning(result.warning ?? null);
    } catch (error) {
      setEnrichError(parseApiError(error));
    } finally {
      dispatch({ type: "SET_ENRICHING", value: false });
    }
  }, [detectedOrders, dispatch, isEnriching]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          Enrich Product Data
        </CardTitle>
        <CardDescription>
          {orderItemCount > 0
            ? `Running AI enrichment for ${orderItemCount} detected Gmail line items to infer MOQ, cadence, and product metadata.`
            : "Analyze Gmail orders first to provide line items for enrichment."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {enrichMode && (
          <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.24)] bg-[hsl(var(--arda-blue)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-blue))]">
            {enrichMode === "ai"
              ? "AI enrichment active: product fields were generated from detected order lines."
              : "Deterministic enrichment active due AI provider/config fallback."}
          </div>
        )}

        {enrichWarning && (
          <div className="rounded-xl border border-[hsl(var(--arda-orange)/0.3)] bg-[hsl(var(--arda-orange)/0.1)] px-3 py-2 text-xs text-[hsl(var(--arda-orange))]">
            {enrichWarning}
          </div>
        )}

        {enrichError && (
          <div className="rounded-xl border border-[hsl(var(--arda-error)/0.28)] bg-[hsl(var(--arda-error)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-error))]">
            {enrichError}
          </div>
        )}

        {products.length === 0 ? (
          <div className="text-center py-8">
            <Button onClick={() => void handleEnrich()} disabled={isEnriching || orderItemCount === 0}>
              {isEnriching ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Enriching products...
                </span>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Start Enrichment
                </>
              )}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => void handleEnrich()} disabled={isEnriching}>
                {isEnriching ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Refreshing...
                  </span>
                ) : (
                  "Refresh Enrichment"
                )}
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border bg-card p-4 text-center">
                <p className="text-2xl font-bold">{products.length}</p>
                <p className="text-xs text-muted-foreground">Products Enriched</p>
              </div>
              <div className="rounded-xl border bg-card p-4 text-center">
                <p className="text-2xl font-bold">
                  {products.filter((p) => p.asin).length}
                </p>
                <p className="text-xs text-muted-foreground">ASINs Resolved</p>
              </div>
              <div className="rounded-xl border bg-card p-4 text-center">
                <p className="text-2xl font-bold">
                  {Math.round(products.reduce((s, p) => s + p.confidence, 0) / products.length)}%
                </p>
                <p className="text-xs text-muted-foreground">Avg Confidence</p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="min-w-full divide-y text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="table-cell-density text-left font-semibold">Product</th>
                    <th className="table-cell-density text-left font-semibold">Vendor</th>
                    <th className="table-cell-density text-left font-semibold">SKU</th>
                    <th className="table-cell-density text-left font-semibold">MOQ</th>
                    <th className="table-cell-density text-left font-semibold">Cadence</th>
                    <th className="table-cell-density text-left font-semibold">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {products.slice(0, 20).map((product) => (
                    <tr key={product.id} className="border-t hover:bg-muted/50">
                      <td className="table-cell-density font-medium truncate max-w-[200px]">
                        {product.name}
                      </td>
                      <td className="table-cell-density">{product.vendorName}</td>
                      <td className="table-cell-density font-mono text-xs">
                        {product.sku || "—"}
                      </td>
                      <td className="table-cell-density font-semibold">{product.moq}</td>
                      <td className="table-cell-density">
                        {product.orderCadenceDays ? `${product.orderCadenceDays}d` : "—"}
                      </td>
                      <td className="table-cell-density">
                        <Badge
                          variant={
                            product.confidence >= 80
                              ? "success"
                              : product.confidence >= 60
                                ? "warning"
                                : "destructive"
                          }
                        >
                          {product.confidence}%
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {products.length > 20 && (
              <p className="text-xs text-muted-foreground text-center">
                Showing 20 of {products.length} products
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
