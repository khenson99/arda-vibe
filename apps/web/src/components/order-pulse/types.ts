/**
 * Order Pulse — Onboarding Workflow Types
 *
 * Defines the data model for each step of the multi-source product
 * import wizard: email linking → vendor selection → background analysis/enrichment →
 * UPC scanning → AI identification → link import → CSV upload → reconciliation & sync.
 */

/* ------------------------------------------------------------------ */
/*  Wizard step identifiers                                           */
/* ------------------------------------------------------------------ */

export type OnboardingStep =
  | "connect-email"
  | "select-vendors"
  | "scan-upcs"
  | "identify-images"
  | "import-links"
  | "upload-csv"
  | "reconcile"
  // Legacy/manual modules that are no longer guided steps
  | "analyze-orders"
  | "enrich-products";

/* ------------------------------------------------------------------ */
/*  Import module identifiers (for FAB / dialog system)               */
/* ------------------------------------------------------------------ */

/** Modules as surfaced from the FAB — combined flows + standalone modules */
export type ImportModuleId =
  | "email-scan"         // combined: connect-email + analysis
  | "import-links"       // standalone links
  | "upload-csv"         // standalone csv
  | "vendor-discovery"   // combined: select-vendors + enrich-products
  | "scan-upcs"          // standalone
  | "ai-identify"        // standalone
  | "reconcile"          // standalone
  // Individual steps (used by guided onboarding flow)
  | "connect-email"
  | "select-vendors"
  | "analyze-orders"
  | "enrich-products"
  | "identify-images";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  "connect-email",
  "select-vendors",
  "scan-upcs",
  "identify-images",
  "import-links",
  "upload-csv",
  "reconcile",
];

export const STEP_META: Record<
  OnboardingStep,
  { index: number; label: string; description: string }
> = {
  "connect-email": {
    index: 0,
    label: "Connect Email",
    description: "Link your email to import purchase orders automatically",
  },
  "select-vendors": {
    index: 1,
    label: "Select Vendors",
    description: "Choose the suppliers you order from regularly",
  },
  "scan-upcs": {
    index: 2,
    label: "Scan UPCs",
    description: "Use your phone to scan barcodes via the on-screen QR code",
  },
  "identify-images": {
    index: 3,
    label: "AI Identify",
    description: "Upload photos and let AI identify your products",
  },
  "import-links": {
    index: 4,
    label: "Import Links",
    description: "Paste product URLs and scrape item data",
  },
  "upload-csv": {
    index: 5,
    label: "Upload CSV",
    description: "Upload a spreadsheet of products to import",
  },
  reconcile: {
    index: 6,
    label: "Reconcile & Sync",
    description: "Review, correct, and sync everything to Arda",
  },
  // Legacy/manual module metadata
  "analyze-orders": {
    index: 97,
    label: "Analyze Orders",
    description: "We'll determine order frequency and minimum order quantities",
  },
  "enrich-products": {
    index: 98,
    label: "Enrich Products",
    description: "Pull images, ASINs, and product details from vendor APIs",
  },
};

/* ------------------------------------------------------------------ */
/*  Email connection                                                  */
/* ------------------------------------------------------------------ */

export type EmailProvider = "gmail" | "outlook" | "yahoo" | "other";

export interface EmailConnection {
  provider: EmailProvider;
  email: string;
  connectedAt: string;
  status: "connected" | "syncing" | "error";
}

/* ------------------------------------------------------------------ */
/*  Vendor configuration                                              */
/* ------------------------------------------------------------------ */

export interface VendorOption {
  id: string;
  name: string;
  logo: string;         // emoji or icon key
  domain: string;
  hasApi: boolean;
  apiType?: "amazon-paapi" | "mcmaster" | "uline" | "generic-scrape";
}

export const PRESET_VENDORS: VendorOption[] = [
  { id: "amazon", name: "Amazon", logo: "📦", domain: "amazon.com", hasApi: true, apiType: "amazon-paapi" },
  { id: "mcmaster", name: "McMaster-Carr", logo: "⚙️", domain: "mcmaster.com", hasApi: true, apiType: "mcmaster" },
  { id: "uline", name: "Uline", logo: "📋", domain: "uline.com", hasApi: true, apiType: "uline" },
  { id: "grainger", name: "Grainger", logo: "🔧", domain: "grainger.com", hasApi: false },
  { id: "fastenal", name: "Fastenal", logo: "🔩", domain: "fastenal.com", hasApi: false },
  { id: "msc", name: "MSC Industrial", logo: "🏭", domain: "mscdirect.com", hasApi: false },
  { id: "digikey", name: "DigiKey", logo: "💡", domain: "digikey.com", hasApi: false },
  { id: "mouser", name: "Mouser Electronics", logo: "🔌", domain: "mouser.com", hasApi: false },
];

/* ------------------------------------------------------------------ */
/*  Detected order / product item                                     */
/* ------------------------------------------------------------------ */

export interface DetectedOrder {
  id: string;
  vendorId: string;
  vendorName: string;
  orderDate: string;
  orderNumber: string;
  items: DetectedOrderItem[];
  totalAmount?: number;
}

export interface DetectedOrderItem {
  id: string;
  name: string;
  sku?: string;
  asin?: string;
  quantity: number;
  unitPrice?: number;
  url?: string;
}

/* ------------------------------------------------------------------ */
/*  Enriched product (after API / scrape enrichment)                  */
/* ------------------------------------------------------------------ */

export interface EnrichedProduct {
  id: string;
  name: string;
  sku?: string;
  asin?: string;
  upc?: string;
  imageUrl?: string;
  vendorId: string;
  vendorName: string;
  productUrl?: string;
  description?: string;
  unitPrice?: number;
  moq: number;
  orderCadenceDays?: number;
  source: ProductSource;
  confidence: number;        // 0-100
  needsReview: boolean;
}

export type ProductSource =
  | "email-import"
  | "api-enrichment"
  | "upc-scan"
  | "ai-image"
  | "link-scrape"
  | "csv-upload"
  | "manual";

/* ------------------------------------------------------------------ */
/*  UPC scan session                                                  */
/* ------------------------------------------------------------------ */

export interface UpcScanItem {
  id: string;
  upc: string;
  scannedAt: string;
  resolvedProduct?: Partial<EnrichedProduct>;
  status: "pending" | "resolved" | "not-found";
}

/* ------------------------------------------------------------------ */
/*  AI image identification                                           */
/* ------------------------------------------------------------------ */

export interface ImageIdentification {
  id: string;
  imageDataUrl: string;
  fileName: string;
  uploadedAt: string;
  predictions: AiPrediction[];
  selectedPrediction?: AiPrediction;
  status: "analyzing" | "complete" | "error";
}

export interface AiPrediction {
  label: string;
  confidence: number;
  suggestedProduct?: Partial<EnrichedProduct>;
}

/* ------------------------------------------------------------------ */
/*  Link / CSV import                                                 */
/* ------------------------------------------------------------------ */

export interface LinkImportItem {
  id: string;
  url: string;
  status: "pending" | "scraping" | "scraped" | "error";
  scrapedProduct?: Partial<EnrichedProduct>;
  errorMessage?: string;
}

export interface CsvImportResult {
  fileName: string;
  totalRows: number;
  parsedItems: Partial<EnrichedProduct>[];
  errors: { row: number; message: string }[];
}

/* ------------------------------------------------------------------ */
/*  Reconciliation                                                    */
/* ------------------------------------------------------------------ */

export interface ReconciliationItem extends EnrichedProduct {
  sources: ProductSource[];
  conflicts: ReconciliationConflict[];
  isApproved: boolean;
  userOverrides: Partial<EnrichedProduct>;
}

export interface ReconciliationConflict {
  field: string;
  values: { source: ProductSource; value: string | number }[];
  resolvedValue?: string | number;
}
