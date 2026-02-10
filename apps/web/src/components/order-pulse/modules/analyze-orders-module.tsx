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
  discoverGmailSuppliers,
  parseApiError,
  readStoredSession,
  type GmailDiscoveredSupplier,
} from "@/lib/api-client";
import type { DetectedOrder } from "../types";
import { PRESET_VENDORS } from "../types";
import { useImportContext, nextId } from "../import-context";

/* ------------------------------------------------------------------ */
/*  Mock data generator (replace with real API call)                   */
/* ------------------------------------------------------------------ */

function mockDetectedOrders(vendorIds: string[]): DetectedOrder[] {
  const items: DetectedOrder[] = [];
  const now = Date.now();

  for (const vendorId of vendorIds) {
    const vendor = PRESET_VENDORS.find((v) => v.id === vendorId);
    if (!vendor) continue;

    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
      items.push({
        id: nextId("order"),
        vendorId,
        vendorName: vendor.name,
        orderDate: new Date(now - (i + 1) * 7 * 86400000).toISOString(),
        orderNumber: `${vendor.id.toUpperCase()}-${100000 + Math.floor(Math.random() * 900000)}`,
        items: Array.from({ length: 1 + Math.floor(Math.random() * 4) }, (_, j) => ({
          id: nextId("item"),
          name: `${vendor.name} Part ${String.fromCharCode(65 + j)}${Math.floor(Math.random() * 999)}`,
          sku: `SKU-${Math.floor(Math.random() * 99999)}`,
          asin: vendorId === "amazon" ? `B0${Math.random().toString(36).slice(2, 10).toUpperCase()}` : undefined,
          quantity: (Math.floor(Math.random() * 10) + 1) * 5,
          unitPrice: Math.round((Math.random() * 200 + 5) * 100) / 100,
          url: `https://${vendor.domain}/product/${Math.floor(Math.random() * 99999)}`,
        })),
        totalAmount: Math.round(Math.random() * 5000 * 100) / 100,
      });
    }
  }

  return items;
}

const SMART_DISCOVERY_VENDOR_IDS = PRESET_VENDORS.filter((vendor) => vendor.hasApi)
  .slice(0, 3)
  .map((vendor) => vendor.id);

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

function toDetectedOrdersFromSuppliers(suppliers: GmailDiscoveredSupplier[]): DetectedOrder[] {
  return suppliers.map((supplier) => ({
    id: nextId("order"),
    vendorId: supplier.vendorId,
    vendorName: supplier.vendorName,
    orderDate: supplier.lastSeenAt,
    orderNumber: `EMAIL-${supplier.messageCount}`,
    items: [
      {
        id: nextId("item"),
        name: `${supplier.messageCount} purchase-related email${supplier.messageCount === 1 ? "" : "s"} from ${supplier.vendorName}`,
        quantity: supplier.messageCount,
        url: `https://${supplier.domain}`,
      },
    ],
  }));
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

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
  const [analysisSource, setAnalysisSource] = React.useState<"gmail" | "demo" | null>(null);

  const activeVendorIds = React.useMemo(
    () =>
      selectedVendors.size > 0 ? [...selectedVendors] : SMART_DISCOVERY_VENDOR_IDS,
    [selectedVendors],
  );
  const usingSmartDiscovery = selectedVendors.size === 0;
  const totalItems = orders.reduce((n, o) => n + o.items.length, 0);
  const knownVendorIds = React.useMemo(
    () => new Set([...PRESET_VENDORS.map((vendor) => vendor.id), ...customVendors.map((vendor) => vendor.id)]),
    [customVendors],
  );

  const runMockAnalysis = React.useCallback(async () => {
    if (usingSmartDiscovery) {
      dispatch({ type: "SET_VENDORS", vendorIds: activeVendorIds });
    }

    dispatch({ type: "SET_ANALYZING", value: true });
    await new Promise((r) => setTimeout(r, 1200));
    const detected = mockDetectedOrders(activeVendorIds);

    const inferredVendorIds = Array.from(
      new Set(detected.map((order) => order.vendorId).filter((id): id is string => Boolean(id))),
    );
    const mergedVendorIds = Array.from(new Set([...activeVendorIds, ...inferredVendorIds]));
    dispatch({ type: "SET_VENDORS", vendorIds: mergedVendorIds });

    dispatch({ type: "SET_DETECTED_ORDERS", orders: detected });
    dispatch({ type: "SET_ANALYZING", value: false });
    setAnalysisSource("demo");
  }, [activeVendorIds, dispatch, usingSmartDiscovery]);

  const handleAnalyze = React.useCallback(async () => {
    if (isAnalyzing) return;
    onAnalyzingStart?.();
    setAnalysisError(null);

    const linkedGmail =
      state.emailConnection?.status === "connected" && state.emailConnection.provider === "gmail";
    const session = linkedGmail ? readStoredSession() : null;

    if (!linkedGmail || !session?.tokens?.accessToken) {
      await runMockAnalysis();
      return;
    }

    dispatch({ type: "SET_ANALYZING", value: true });
    try {
      const discovery = await discoverGmailSuppliers(session.tokens.accessToken, { maxResults: 140 });
      const suppliers = discovery.suppliers.map((supplier) => {
        const presetVendorId = findPresetVendorId(supplier.domain);
        if (presetVendorId) {
          const preset = PRESET_VENDORS.find((vendor) => vendor.id === presetVendorId);
          return {
            ...supplier,
            vendorId: presetVendorId,
            vendorName: preset?.name || supplier.vendorName,
          };
        }
        return supplier;
      });

      if (suppliers.length === 0) {
        dispatch({ type: "SET_DETECTED_ORDERS", orders: [] });
        setAnalysisSource("gmail");
        setAnalysisError("No purchase-related emails were found yet. You can continue with demo data if needed.");
        return;
      }

      const inferredVendorIds = Array.from(
        new Set(suppliers.map((supplier) => supplier.vendorId).filter(Boolean)),
      );
      const mergedVendorIds = Array.from(new Set([...activeVendorIds, ...inferredVendorIds]));
      dispatch({ type: "SET_VENDORS", vendorIds: mergedVendorIds });

      const discoveredVendorIds = new Set(knownVendorIds);
      for (const supplier of suppliers) {
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
        orders: toDetectedOrdersFromSuppliers(suppliers),
      });
      setAnalysisSource("gmail");
    } catch (error) {
      setAnalysisError(parseApiError(error));
    } finally {
      dispatch({ type: "SET_ANALYZING", value: false });
    }
  }, [
    activeVendorIds,
    dispatch,
    isAnalyzing,
    knownVendorIds,
    onAnalyzingStart,
    runMockAnalysis,
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
            Analyze Email Orders
          </CardTitle>
          <CardDescription>
            {selectedVendors.size > 0
              ? `Scanning your inbox for purchase orders from ${selectedVendors.size} selected vendor${selectedVendors.size !== 1 ? "s" : ""}. We'll determine order frequency and minimum order quantities.`
              : "Smart discovery is enabled. We'll start with your top vendor channels, then you can refine vendor selection any time."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {analysisSource && (
            <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.24)] bg-[hsl(var(--arda-blue)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-blue))]">
              {analysisSource === "gmail"
                ? "Live Gmail discovery active: suppliers are inferred directly from linked inbox metadata."
                : "Demo discovery mode active: using simulated supplier and order data."}
            </div>
          )}

          {usingSmartDiscovery && (
            <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.24)] bg-[hsl(var(--arda-blue)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-blue))]">
              Fast path active: running discovery against {activeVendorIds.length} default vendor
              channels while your list is still empty.
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
                <Button
                  variant="outline"
                  onClick={() => void runMockAnalysis()}
                  disabled={isAnalyzing}
                >
                  Use demo data
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                We check the most recent 90 days first so you get results quickly.
              </p>
            </div>
          ) : (
            <>
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
                  <p className="text-2xl font-bold">{activeVendorIds.length}</p>
                  <p className="text-xs text-muted-foreground">Vendors Scanned</p>
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
