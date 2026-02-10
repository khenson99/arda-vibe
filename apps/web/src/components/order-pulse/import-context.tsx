import * as React from "react";

import type {
  ImportModuleId,
  OnboardingStep,
  EmailConnection,
  VendorOption,
  DetectedOrder,
  EnrichedProduct,
  UpcScanItem,
  ImageIdentification,
  LinkImportItem,
  CsvImportResult,
  ReconciliationItem,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Deterministic ID helper (shared across modules)                   */
/* ------------------------------------------------------------------ */

let _idCounter = 0;
export function nextId(prefix = "op"): string {
  _idCounter += 1;
  return `${prefix}-${Date.now()}-${_idCounter}`;
}

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

export interface ImportState {
  /** Which module dialog is currently open (null = all closed) */
  activeModule: ImportModuleId | null;

  /** Guided onboarding step tracker (only used in onboarding flow) */
  guidedStep: OnboardingStep | null;

  // Step 1 — Email
  emailConnection: EmailConnection | null;

  // Step 2 — Vendors
  selectedVendors: Set<string>;
  customVendors: VendorOption[];

  // Background analysis
  detectedOrders: DetectedOrder[];
  isAnalyzing: boolean;

  // Background enrichment
  enrichedProducts: EnrichedProduct[];
  isEnriching: boolean;
  backgroundImportStatus: "idle" | "running" | "complete" | "error";
  backgroundImportPhase: "analyzing" | "enriching" | null;
  backgroundImportProgress: number;
  backgroundImportMessage: string | null;

  // Step 3 — UPC scans
  upcScans: UpcScanItem[];

  // Step 4 — Image identification
  imageIdentifications: ImageIdentification[];

  // Step 5/6 — Links & CSV
  linkImports: LinkImportItem[];
  csvResult: CsvImportResult | null;

  // Step 7 — Reconciliation
  reconciliationItems: ReconciliationItem[];
  isSyncing: boolean;
}

const INITIAL_STATE: ImportState = {
  activeModule: null,
  guidedStep: null,
  emailConnection: null,
  selectedVendors: new Set(),
  customVendors: [],
  detectedOrders: [],
  isAnalyzing: false,
  enrichedProducts: [],
  isEnriching: false,
  backgroundImportStatus: "idle",
  backgroundImportPhase: null,
  backgroundImportProgress: 0,
  backgroundImportMessage: null,
  upcScans: [],
  imageIdentifications: [],
  linkImports: [],
  csvResult: null,
  reconciliationItems: [],
  isSyncing: false,
};

/* ------------------------------------------------------------------ */
/*  Actions                                                           */
/* ------------------------------------------------------------------ */

export type ImportAction =
  // Module navigation
  | { type: "OPEN_MODULE"; module: ImportModuleId }
  | { type: "CLOSE_MODULE" }
  | { type: "SET_GUIDED_STEP"; step: OnboardingStep | null }

  // Email
  | { type: "SET_EMAIL_CONNECTION"; connection: EmailConnection | null }
  | { type: "UPDATE_EMAIL_STATUS"; status: EmailConnection["status"] }

  // Vendors
  | { type: "TOGGLE_VENDOR"; vendorId: string }
  | { type: "SET_VENDORS"; vendorIds: string[] }
  | { type: "ADD_CUSTOM_VENDOR"; vendor: VendorOption }

  // Orders
  | { type: "SET_DETECTED_ORDERS"; orders: DetectedOrder[] }
  | { type: "SET_ANALYZING"; value: boolean }

  // Enriched products
  | { type: "SET_ENRICHED_PRODUCTS"; products: EnrichedProduct[] }
  | { type: "SET_ENRICHING"; value: boolean }
  | {
      type: "SET_BACKGROUND_IMPORT_STATE";
      status: ImportState["backgroundImportStatus"];
      phase?: ImportState["backgroundImportPhase"];
      progress?: number;
      message?: string | null;
    }

  // UPC
  | { type: "ADD_UPC_SCAN"; item: UpcScanItem }
  | { type: "UPDATE_UPC_SCAN"; id: string; update: Partial<UpcScanItem> }

  // Images
  | { type: "ADD_IMAGE_IDENTIFICATION"; item: ImageIdentification }
  | { type: "UPDATE_IMAGE_IDENTIFICATION"; id: string; update: Partial<ImageIdentification> }

  // Links
  | { type: "ADD_LINK_IMPORTS"; items: LinkImportItem[] }
  | { type: "UPDATE_LINK_IMPORT"; id: string; update: Partial<LinkImportItem> }

  // CSV
  | { type: "SET_CSV_RESULT"; result: CsvImportResult | null }

  // Reconciliation
  | { type: "SET_RECONCILIATION_ITEMS"; items: ReconciliationItem[] }
  | { type: "TOGGLE_RECONCILIATION_APPROVAL"; id: string }
  | { type: "UPDATE_RECONCILIATION_OVERRIDE"; id: string; overrides: Partial<EnrichedProduct> }
  | { type: "SET_SYNCING"; value: boolean }
  | { type: "BUILD_RECONCILIATION" }

  // Reset
  | { type: "RESET" };

/* ------------------------------------------------------------------ */
/*  Reducer                                                           */
/* ------------------------------------------------------------------ */

function importReducer(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    /* ---- Module navigation ---- */
    case "OPEN_MODULE":
      return { ...state, activeModule: action.module };

    case "CLOSE_MODULE":
      return { ...state, activeModule: null, guidedStep: null };

    case "SET_GUIDED_STEP":
      return { ...state, guidedStep: action.step };

    /* ---- Email ---- */
    case "SET_EMAIL_CONNECTION":
      return { ...state, emailConnection: action.connection };

    case "UPDATE_EMAIL_STATUS":
      return {
        ...state,
        emailConnection: state.emailConnection
          ? { ...state.emailConnection, status: action.status }
          : null,
      };

    /* ---- Vendors ---- */
    case "TOGGLE_VENDOR": {
      const next = new Set(state.selectedVendors);
      if (next.has(action.vendorId)) next.delete(action.vendorId);
      else next.add(action.vendorId);
      return { ...state, selectedVendors: next };
    }

    case "SET_VENDORS":
      return { ...state, selectedVendors: new Set(action.vendorIds) };

    case "ADD_CUSTOM_VENDOR":
      return { ...state, customVendors: [...state.customVendors, action.vendor] };

    /* ---- Orders ---- */
    case "SET_DETECTED_ORDERS":
      return { ...state, detectedOrders: action.orders };

    case "SET_ANALYZING":
      return { ...state, isAnalyzing: action.value };

    /* ---- Enriched products ---- */
    case "SET_ENRICHED_PRODUCTS":
      return { ...state, enrichedProducts: action.products };

    case "SET_ENRICHING":
      return { ...state, isEnriching: action.value };

    case "SET_BACKGROUND_IMPORT_STATE":
      return {
        ...state,
        backgroundImportStatus: action.status,
        backgroundImportPhase:
          action.phase === undefined ? state.backgroundImportPhase : action.phase,
        backgroundImportProgress:
          action.progress === undefined ? state.backgroundImportProgress : action.progress,
        backgroundImportMessage:
          action.message === undefined ? state.backgroundImportMessage : action.message,
      };

    /* ---- UPC ---- */
    case "ADD_UPC_SCAN":
      return { ...state, upcScans: [...state.upcScans, action.item] };

    case "UPDATE_UPC_SCAN":
      return {
        ...state,
        upcScans: state.upcScans.map((s) =>
          s.id === action.id ? { ...s, ...action.update } : s,
        ),
      };

    /* ---- Images ---- */
    case "ADD_IMAGE_IDENTIFICATION":
      return { ...state, imageIdentifications: [...state.imageIdentifications, action.item] };

    case "UPDATE_IMAGE_IDENTIFICATION":
      return {
        ...state,
        imageIdentifications: state.imageIdentifications.map((img) =>
          img.id === action.id ? { ...img, ...action.update } : img,
        ),
      };

    /* ---- Links ---- */
    case "ADD_LINK_IMPORTS":
      return { ...state, linkImports: [...state.linkImports, ...action.items] };

    case "UPDATE_LINK_IMPORT":
      return {
        ...state,
        linkImports: state.linkImports.map((li) =>
          li.id === action.id ? { ...li, ...action.update } : li,
        ),
      };

    /* ---- CSV ---- */
    case "SET_CSV_RESULT":
      return { ...state, csvResult: action.result };

    /* ---- Reconciliation ---- */
    case "SET_RECONCILIATION_ITEMS":
      return { ...state, reconciliationItems: action.items };

    case "TOGGLE_RECONCILIATION_APPROVAL":
      return {
        ...state,
        reconciliationItems: state.reconciliationItems.map((item) =>
          item.id === action.id ? { ...item, isApproved: !item.isApproved } : item,
        ),
      };

    case "UPDATE_RECONCILIATION_OVERRIDE":
      return {
        ...state,
        reconciliationItems: state.reconciliationItems.map((item) =>
          item.id === action.id
            ? { ...item, userOverrides: { ...item.userOverrides, ...action.overrides } }
            : item,
        ),
      };

    case "SET_SYNCING":
      return { ...state, isSyncing: action.value };

    case "BUILD_RECONCILIATION": {
      const allProducts: EnrichedProduct[] = [...state.enrichedProducts];

      for (const scan of state.upcScans) {
        if (scan.status === "resolved" && scan.resolvedProduct) {
          allProducts.push({
            id: nextId("prod"),
            name: scan.resolvedProduct.name ?? `UPC ${scan.upc}`,
            upc: scan.upc,
            vendorId: "",
            vendorName: "UPC Scan",
            moq: scan.resolvedProduct.moq ?? 0,
            source: "upc-scan",
            confidence: 85,
            needsReview: false,
            ...scan.resolvedProduct,
          } as EnrichedProduct);
        }
      }

      for (const img of state.imageIdentifications) {
        if (img.status === "complete" && img.selectedPrediction?.suggestedProduct) {
          allProducts.push({
            id: nextId("prod"),
            name: img.selectedPrediction.suggestedProduct.name ?? "AI-Identified Product",
            vendorId: "",
            vendorName: "AI Identification",
            moq: img.selectedPrediction.suggestedProduct.moq ?? 0,
            source: "ai-image",
            confidence: Math.round(img.selectedPrediction.confidence * 100),
            needsReview: true,
            ...img.selectedPrediction.suggestedProduct,
          } as EnrichedProduct);
        }
      }

      for (const link of state.linkImports) {
        if (link.status === "scraped" && link.scrapedProduct) {
          allProducts.push({
            id: nextId("prod"),
            name: link.scrapedProduct.name ?? "Scraped Product",
            vendorId: "",
            vendorName: "Link Scrape",
            moq: link.scrapedProduct.moq ?? 0,
            source: "link-scrape",
            confidence: 75,
            needsReview: true,
            ...link.scrapedProduct,
          } as EnrichedProduct);
        }
      }

      if (state.csvResult) {
        for (const item of state.csvResult.parsedItems) {
          allProducts.push({
            id: nextId("prod"),
            name: item.name ?? "CSV Item",
            vendorId: "",
            vendorName: "CSV Upload",
            moq: item.moq ?? 0,
            source: "csv-upload",
            confidence: 60,
            needsReview: true,
            ...item,
          } as EnrichedProduct);
        }
      }

      const seen = new Map<string, ReconciliationItem>();
      for (const p of allProducts) {
        const key = (p.sku || p.name).toLowerCase().trim();
        if (seen.has(key)) {
          const existing = seen.get(key)!;
          existing.sources.push(p.source);
          existing.confidence = Math.max(existing.confidence, p.confidence);
        } else {
          seen.set(key, {
            ...p,
            sources: [p.source],
            conflicts: [],
            isApproved: p.confidence >= 80,
            userOverrides: {},
          });
        }
      }

      return { ...state, reconciliationItems: Array.from(seen.values()) };
    }

    /* ---- Reset ---- */
    case "RESET":
      return { ...INITIAL_STATE };

    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/*  Context                                                           */
/* ------------------------------------------------------------------ */

interface ImportContextValue {
  state: ImportState;
  dispatch: React.Dispatch<ImportAction>;
  /** Count of items from all sources that haven't been synced yet */
  pendingItemCount: number;
}

const ImportContext = React.createContext<ImportContextValue | null>(null);

export function ImportContextProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = React.useReducer(importReducer, INITIAL_STATE);

  const pendingItemCount = React.useMemo(() => {
    let count = 0;
    count += state.enrichedProducts.length;
    count += state.upcScans.filter((s) => s.status === "resolved").length;
    count += state.imageIdentifications.filter(
      (img) => img.status === "complete" && img.selectedPrediction,
    ).length;
    count += state.linkImports.filter((li) => li.status === "scraped").length;
    count += state.csvResult?.parsedItems.length ?? 0;
    return count;
  }, [
    state.enrichedProducts,
    state.upcScans,
    state.imageIdentifications,
    state.linkImports,
    state.csvResult,
  ]);

  const value = React.useMemo(
    () => ({ state, dispatch, pendingItemCount }),
    [state, pendingItemCount],
  );

  return <ImportContext.Provider value={value}>{children}</ImportContext.Provider>;
}

export function useImportContext(): ImportContextValue {
  const ctx = React.useContext(ImportContext);
  if (!ctx) {
    throw new Error("useImportContext must be used within an ImportContextProvider");
  }
  return ctx;
}
