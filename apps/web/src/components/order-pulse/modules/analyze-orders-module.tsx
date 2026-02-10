import * as React from "react";
import { Loader2, Search } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import {
  discoverGmailOrders,
  parseApiError,
  readStoredSession,
  type GmailDiscoveredOrder,
  type GmailDiscoveredSupplier,
} from "@/lib/api-client";
import type { DetectedOrder } from "../types";
import { PRESET_VENDORS } from "../types";
import { useImportContext, nextId } from "../import-context";

function normalizeVendorDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "");
}

function findPresetVendorId(domain: string): string | null {
  const normalized = normalizeVendorDomain(domain);
  const match = PRESET_VENDORS.find((vendor) => {
    const presetDomain = normalizeVendorDomain(vendor.domain);
    return normalized === presetDomain || normalized.endsWith(`.${presetDomain}`);
  });
  return match?.id ?? null;
}

function mapOrderVendor(order: GmailDiscoveredOrder): GmailDiscoveredOrder {
  const presetVendorId = order.domain ? findPresetVendorId(order.domain) : null;
  if (!presetVendorId) return order;
  const preset = PRESET_VENDORS.find((vendor) => vendor.id === presetVendorId);
  return {
    ...order,
    vendorId: presetVendorId,
    vendorName: preset?.name || order.vendorName,
  };
}

function mapSupplierVendor(supplier: GmailDiscoveredSupplier): GmailDiscoveredSupplier {
  const presetVendorId = findPresetVendorId(supplier.domain);
  if (!presetVendorId) return supplier;
  const preset = PRESET_VENDORS.find((vendor) => vendor.id === presetVendorId);
  return {
    ...supplier,
    vendorId: presetVendorId,
    vendorName: preset?.name || supplier.vendorName,
  };
}

function toDetectedOrders(orders: GmailDiscoveredOrder[]): DetectedOrder[] {
  return orders.map((order) => ({
    id: nextId("order"),
    vendorId: order.vendorId,
    vendorName: order.vendorName,
    orderDate: order.orderDate,
    orderNumber: order.orderNumber,
    items: order.items.map((item) => ({
      id: nextId("item"),
      name: item.name,
      sku: item.sku,
      asin: item.asin,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      url: item.url,
    })),
  }));
}

export interface AnalyzeOrdersModuleProps {
  autoStartWhenReady?: boolean;
  onAnalyzingStart?: () => void;
}

export function AnalyzeOrdersModule({
  autoStartWhenReady = false,
  onAnalyzingStart,
}: AnalyzeOrdersModuleProps) {
  const { state, dispatch } = useImportContext();
  const { detectedOrders: orders, isAnalyzing, selectedVendors, customVendors } = state;
  const [analysisError, setAnalysisError] = React.useState<string | null>(null);
  const [analysisWarning, setAnalysisWarning] = React.useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = React.useState<"ai" | "heuristic" | null>(null);

  const totalItems = orders.reduce((n, o) => n + o.items.length, 0);
  const knownVendorIds = React.useMemo(
    () => new Set([...PRESET_VENDORS.map((vendor) => vendor.id), ...customVendors.map((vendor) => vendor.id)]),
    [customVendors],
  );
  const discoveredVendorCount = React.useMemo(
    () => new Set(orders.map((order) => order.vendorId)).size,
    [orders],
  );

  const handleAnalyze = React.useCallback(async () => {
    if (isAnalyzing) return;
    onAnalyzingStart?.();
    setAnalysisError(null);
    setAnalysisWarning(null);

    const linkedGmail =
      state.emailConnection?.status === "connected" && state.emailConnection.provider === "gmail";
    const session = linkedGmail ? readStoredSession() : null;

    if (!linkedGmail || !session?.tokens?.accessToken) {
      setAnalysisMode(null);
      setAnalysisError("Connect Gmail first so Arda can pull and analyze your inbox.");
      dispatch({ type: "SET_DETECTED_ORDERS", orders: [] });
      return;
    }

    dispatch({ type: "SET_ANALYZING", value: true });
    try {
      const discovery = await discoverGmailOrders(session.tokens.accessToken, {
        maxResults: 220,
        lookbackDays: 180,
        vendorIds: selectedVendors.size > 0 ? Array.from(selectedVendors) : undefined,
      });
      const mappedSuppliers = discovery.suppliers.map(mapSupplierVendor);
      const mappedOrders = discovery.orders.map(mapOrderVendor);

      const filteredOrders =
        selectedVendors.size > 0
          ? mappedOrders.filter((order) => selectedVendors.has(order.vendorId))
          : mappedOrders;

      const discoveredVendorIds = new Set(knownVendorIds);
      for (const supplier of mappedSuppliers) {
        if (discoveredVendorIds.has(supplier.vendorId)) continue;
        discoveredVendorIds.add(supplier.vendorId);
        dispatch({
          type: "ADD_CUSTOM_VENDOR",
          vendor: {
            id: supplier.vendorId,
            name: supplier.vendorName,
            logo: "🏢",
            domain: supplier.domain,
            hasApi: false,
          },
        });
      }

      dispatch({
        type: "SET_DETECTED_ORDERS",
        orders: toDetectedOrders(filteredOrders),
      });

      setAnalysisMode(discovery.analysisMode);
      setAnalysisWarning(discovery.analysisWarning ?? null);

      if (filteredOrders.length === 0) {
        setAnalysisError(
          selectedVendors.size > 0
            ? "No Gmail purchase messages matched your selected vendors."
            : "No purchase-related Gmail messages were found yet.",
        );
      }
    } catch (error) {
      dispatch({ type: "SET_DETECTED_ORDERS", orders: [] });
      setAnalysisError(parseApiError(error));
      setAnalysisMode(null);
    } finally {
      dispatch({ type: "SET_ANALYZING", value: false });
    }
  }, [
    dispatch,
    isAnalyzing,
    knownVendorIds,
    onAnalyzingStart,
    selectedVendors,
    state.emailConnection,
  ]);

  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (!autoStartWhenReady || autoStartedRef.current) return;
    if (orders.length > 0 || isAnalyzing) return;
    autoStartedRef.current = true;
    void handleAnalyze();
  }, [autoStartWhenReady, handleAnalyze, isAnalyzing, orders.length]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
            Analyze Gmail Orders
          </CardTitle>
          <CardDescription>
            {selectedVendors.size > 0
              ? `Scanning your linked Gmail inbox and filtering for ${selectedVendors.size} selected vendor${selectedVendors.size !== 1 ? "s" : ""}.`
              : "Scanning your linked Gmail inbox for purchase-related activity and extracting likely orders."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {analysisMode && (
            <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.24)] bg-[hsl(var(--arda-blue)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-blue))]">
              {analysisMode === "ai"
                ? "AI email analysis active: order candidates were extracted from Gmail messages."
                : "Deterministic parsing active: Gmail messages were parsed without AI due provider/config fallback."}
            </div>
          )}

          {analysisWarning && (
            <div className="rounded-xl border border-[hsl(var(--arda-orange)/0.3)] bg-[hsl(var(--arda-orange)/0.1)] px-3 py-2 text-xs text-[hsl(var(--arda-orange))]">
              {analysisWarning}
            </div>
          )}

          {analysisError && (
            <div className="rounded-xl border border-[hsl(var(--arda-error)/0.28)] bg-[hsl(var(--arda-error)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-error))]">
              {analysisError}
            </div>
          )}

          {orders.length === 0 ? (
            <div className="text-center py-8 space-y-4">
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={() => void handleAnalyze()} disabled={isAnalyzing}>
                  {isAnalyzing ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Scanning recent inbox activity...
                    </span>
                  ) : (
                    <>
                      <Search className="h-4 w-4" />
                      Start Email Analysis
                    </>
                  )}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Pulls recent purchase emails and converts them into actionable order candidates.
              </p>
            </div>
          ) : (
            <>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => void handleAnalyze()} disabled={isAnalyzing}>
                  {isAnalyzing ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Refreshing...
                    </span>
                  ) : (
                    "Refresh Analysis"
                  )}
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border bg-card p-4 text-center">
                  <p className="text-2xl font-bold">{orders.length}</p>
                  <p className="text-xs text-muted-foreground">Orders Found</p>
                </div>
                <div className="rounded-xl border bg-card p-4 text-center">
                  <p className="text-2xl font-bold">{totalItems}</p>
                  <p className="text-xs text-muted-foreground">Line Items</p>
                </div>
                <div className="rounded-xl border bg-card p-4 text-center">
                  <p className="text-2xl font-bold">{discoveredVendorCount}</p>
                  <p className="text-xs text-muted-foreground">Vendors Found</p>
                </div>
              </div>

              <div className="space-y-3 max-h-[400px] overflow-y-auto">
                {orders.map((order) => (
                  <div key={order.id} className="rounded-xl border bg-card p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold">{order.vendorName}</p>
                        <p className="text-xs text-muted-foreground">
                          Order {order.orderNumber} • {new Date(order.orderDate).toLocaleDateString()}
                        </p>
                      </div>
                      <Badge variant="accent">{order.items.length} items</Badge>
                    </div>
                    <div className="space-y-1">
                      {order.items.map((item) => (
                        <div key={item.id} className="flex items-center justify-between text-xs py-1 border-t border-border/50">
                          <span className="truncate max-w-[200px]">{item.name}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-muted-foreground">Qty: {item.quantity}</span>
                            {item.unitPrice && (
                              <span className="font-medium">${item.unitPrice.toFixed(2)}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
