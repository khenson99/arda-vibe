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
import type { DetectedOrder, EnrichedProduct } from "../types";
import { useImportContext, nextId } from "../import-context";

/* ------------------------------------------------------------------ */
/*  Mock data generator (replace with real API call)                   */
/* ------------------------------------------------------------------ */

function mockEnrichedProducts(orders: DetectedOrder[]): EnrichedProduct[] {
  const products: EnrichedProduct[] = [];

  for (const order of orders) {
    for (const item of order.items) {
      products.push({
        id: nextId("prod"),
        name: item.name,
        sku: item.sku,
        asin: item.asin,
        vendorId: order.vendorId,
        vendorName: order.vendorName,
        productUrl: item.url,
        unitPrice: item.unitPrice,
        moq: (Math.floor(Math.random() * 5) + 1) * 10,
        orderCadenceDays: [7, 14, 21, 30, 45, 60, 90][Math.floor(Math.random() * 7)],
        source: "email-import",
        confidence: Math.floor(Math.random() * 30 + 70),
        needsReview: Math.random() > 0.7,
        imageUrl: undefined,
        description: `Auto-detected from ${order.vendorName} order ${order.orderNumber}`,
      });
    }
  }

  return products;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function EnrichProductsModule() {
  const { state, dispatch } = useImportContext();
  const { enrichedProducts: products, isEnriching, detectedOrders } = state;

  const orderItemCount = detectedOrders.reduce((n, o) => n + o.items.length, 0);

  const handleEnrich = async () => {
    dispatch({ type: "SET_ENRICHING", value: true });
    await new Promise((r) => setTimeout(r, 3000));
    const enriched = mockEnrichedProducts(detectedOrders);
    dispatch({ type: "SET_ENRICHED_PRODUCTS", products: enriched });
    dispatch({ type: "SET_ENRICHING", value: false });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          Enrich Product Data
        </CardTitle>
        <CardDescription>
          {orderItemCount > 0
            ? `Scraping images, ASINs, and product details from Amazon Product Advertising API and other vendor APIs for ${orderItemCount} detected line items.`
            : "Analyze orders first to have line items to enrich."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
