import type { Dispatch } from "react";

import {
  discoverGmailOrders,
  enrichEmailOrdersWithAi,
  parseApiError,
  readStoredSession,
  type GmailDiscoveredOrder,
  type GmailDiscoveredSupplier,
} from "@/lib/api-client";
import { PRESET_VENDORS, type DetectedOrder, type EnrichedProduct } from "./types";
import { nextId, type ImportAction, type ImportState } from "./import-context";

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

  const linkedGmail =
    state.emailConnection?.status === "connected" && state.emailConnection.provider === "gmail";
  const session = linkedGmail ? readStoredSession() : null;
  const accessToken = session?.tokens?.accessToken;

  if (!linkedGmail || !accessToken) {
    setBackgroundState(dispatch, {
      status: "error",
      phase: null,
      progress: 0,
      message: "Connect Gmail first so background import can pull real inbox data.",
    });
    return;
  }

  if (state.selectedVendors.size === 0) {
    setBackgroundState(dispatch, {
      status: "error",
      phase: null,
      progress: 0,
      message: "Select at least one supplier before starting background import.",
    });
    return;
  }

  setBackgroundState(dispatch, {
    status: "running",
    phase: "analyzing",
    progress: 8,
    message: "Pulling and analyzing Gmail purchase activity in the background.",
  });
  dispatch({ type: "SET_ANALYZING", value: true });

  try {
    await runProgressFrames(
      dispatch,
      [18, 32, 45],
      "Pulling and analyzing Gmail purchase activity in the background.",
      "analyzing",
    );

    const discovery = await discoverGmailOrders(accessToken, {
      maxResults: 220,
      lookbackDays: 180,
      vendorIds: Array.from(state.selectedVendors),
    });
    const mappedSuppliers = discovery.suppliers.map(mapSupplierVendor);
    const mappedOrders = discovery.orders.map(mapOrderVendor);

    const filteredOrders =
      state.selectedVendors.size > 0
        ? mappedOrders.filter((order) => state.selectedVendors.has(order.vendorId))
        : mappedOrders;
    const detectedOrders = toDetectedOrders(filteredOrders);

    dispatch({ type: "SET_DETECTED_ORDERS", orders: detectedOrders });
    dispatch({ type: "SET_ANALYZING", value: false });

    const knownVendorIds = new Set([
      ...PRESET_VENDORS.map((vendor) => vendor.id),
      ...state.customVendors.map((vendor) => vendor.id),
    ]);
    for (const supplier of mappedSuppliers) {
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

    if (detectedOrders.length === 0) {
      setBackgroundState(dispatch, {
        status: "complete",
        phase: null,
        progress: 100,
        message:
          discovery.analysisWarning ||
          "No purchase-related Gmail orders were found during background import.",
      });
      return;
    }

    setBackgroundState(dispatch, {
      status: "running",
      phase: "enriching",
      progress: 58,
      message: "Running AI enrichment on detected Gmail order lines.",
    });

    dispatch({ type: "SET_ENRICHING", value: true });
    await runProgressFrames(
      dispatch,
      [68, 79, 90],
      "Running AI enrichment on detected Gmail order lines.",
      "enriching",
    );

    const enrichment = await enrichEmailOrdersWithAi(accessToken, {
      orders: filteredOrders.map((order) => ({
        vendorId: order.vendorId,
        vendorName: order.vendorName,
        orderDate: order.orderDate,
        orderNumber: order.orderNumber,
        items: order.items,
      })),
    });

    const enrichedProducts = toEnrichedProducts(enrichment.products);
    dispatch({ type: "SET_ENRICHED_PRODUCTS", products: enrichedProducts });
    dispatch({ type: "SET_ENRICHING", value: false });

    const warnings = [discovery.analysisWarning, enrichment.warning].filter(Boolean).join(" ");
    const messageSuffix = warnings ? ` Warning: ${warnings}` : "";

    setBackgroundState(dispatch, {
      status: "complete",
      phase: null,
      progress: 100,
      message: `Background analysis complete: ${detectedOrders.length} orders and ${enrichedProducts.length} products processed.${messageSuffix}`,
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
