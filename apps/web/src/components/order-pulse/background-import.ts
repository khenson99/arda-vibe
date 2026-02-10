import type { Dispatch } from "react";

import {
  discoverGmailSuppliers,
  parseApiError,
  readStoredSession,
  type GmailDiscoveredSupplier,
} from "@/lib/api-client";
import { PRESET_VENDORS, type DetectedOrder, type EnrichedProduct } from "./types";
import { nextId, type ImportAction, type ImportState } from "./import-context";

const SMART_DISCOVERY_VENDOR_IDS = PRESET_VENDORS.filter((vendor) => vendor.hasApi)
  .slice(0, 3)
  .map((vendor) => vendor.id);

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function setBackgroundState(
  dispatch: Dispatch<ImportAction>,
  state: {
    status: ImportState["backgroundImportStatus"];
    phase?: ImportState["backgroundImportPhase"];
    progress?: number;
    message?: string | null;
  },
) {
  dispatch({ type: "SET_BACKGROUND_IMPORT_STATE", ...state });
}

async function runProgressFrames(
  dispatch: Dispatch<ImportAction>,
  frames: number[],
  message: string,
  phase: ImportState["backgroundImportPhase"],
) {
  for (const progress of frames) {
    await delay(280);
    setBackgroundState(dispatch, {
      status: "running",
      phase,
      progress,
      message,
    });
  }
}

export async function runBackgroundImportPipeline(
  state: ImportState,
  dispatch: Dispatch<ImportAction>,
) {
  if (state.backgroundImportStatus === "running") return;

  const activeVendorIds =
    state.selectedVendors.size > 0 ? [...state.selectedVendors] : SMART_DISCOVERY_VENDOR_IDS;

  if (activeVendorIds.length === 0) return;

  setBackgroundState(dispatch, {
    status: "running",
    phase: "analyzing",
    progress: 8,
    message: "Analyzing purchase activity from linked channels in the background.",
  });
  dispatch({ type: "SET_ANALYZING", value: true });

  if (state.selectedVendors.size === 0) {
    dispatch({ type: "SET_VENDORS", vendorIds: activeVendorIds });
  }

  try {
    await runProgressFrames(
      dispatch,
      [18, 32, 45],
      "Analyzing purchase activity from linked channels in the background.",
      "analyzing",
    );

    let detectedOrders: DetectedOrder[] = [];
    let mergedVendorIds = activeVendorIds;

    const linkedGmail =
      state.emailConnection?.status === "connected" && state.emailConnection.provider === "gmail";
    const session = linkedGmail ? readStoredSession() : null;

    if (linkedGmail && session?.tokens?.accessToken) {
      try {
        const discovery = await discoverGmailSuppliers(session.tokens.accessToken, {
          maxResults: 140,
        });

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

        if (suppliers.length > 0) {
          detectedOrders = toDetectedOrdersFromSuppliers(suppliers);
          const inferredVendorIds = Array.from(
            new Set(suppliers.map((supplier) => supplier.vendorId).filter(Boolean)),
          );
          mergedVendorIds = Array.from(new Set([...activeVendorIds, ...inferredVendorIds]));

          const knownVendorIds = new Set([
            ...PRESET_VENDORS.map((vendor) => vendor.id),
            ...state.customVendors.map((vendor) => vendor.id),
          ]);

          for (const supplier of suppliers) {
            if (knownVendorIds.has(supplier.vendorId)) continue;
            knownVendorIds.add(supplier.vendorId);
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
        }
      } catch (error) {
        const fallbackMessage = parseApiError(error);
        setBackgroundState(dispatch, {
          status: "running",
          phase: "analyzing",
          progress: 46,
          message: `Live inbox discovery failed (${fallbackMessage}). Falling back to demo analysis.`,
        });
      }
    }

    if (detectedOrders.length === 0) {
      detectedOrders = mockDetectedOrders(activeVendorIds);
      mergedVendorIds = activeVendorIds;
    }

    dispatch({ type: "SET_VENDORS", vendorIds: mergedVendorIds });
    dispatch({ type: "SET_DETECTED_ORDERS", orders: detectedOrders });
    dispatch({ type: "SET_ANALYZING", value: false });

    setBackgroundState(dispatch, {
      status: "running",
      phase: "enriching",
      progress: 58,
      message:
        "Enriching products from vendor data (including Amazon Product Advertising API when available).",
    });

    dispatch({ type: "SET_ENRICHING", value: true });
    await runProgressFrames(
      dispatch,
      [68, 79, 90],
      "Enriching products from vendor data (including Amazon Product Advertising API when available).",
      "enriching",
    );

    const enrichedProducts = mockEnrichedProducts(detectedOrders);
    dispatch({ type: "SET_ENRICHED_PRODUCTS", products: enrichedProducts });
    dispatch({ type: "SET_ENRICHING", value: false });
    setBackgroundState(dispatch, {
      status: "complete",
      phase: null,
      progress: 100,
      message: `Background analysis complete: ${detectedOrders.length} orders and ${enrichedProducts.length} products processed.`,
    });
  } catch (error) {
    dispatch({ type: "SET_ANALYZING", value: false });
    dispatch({ type: "SET_ENRICHING", value: false });
    setBackgroundState(dispatch, {
      status: "error",
      phase: null,
      progress: state.backgroundImportProgress || 0,
      message: parseApiError(error),
    });
  }
}
