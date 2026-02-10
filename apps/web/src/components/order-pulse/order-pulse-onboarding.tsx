import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  Download,
  FileSpreadsheet,
  Globe,
  ImagePlus,
  Link2,
  Loader2,
  Mail,
  MailCheck,
  Package,
  Plus,
  QrCode,
  ScanBarcode,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  type OnboardingStep,
  type EmailProvider,
  type EmailConnection,
  type VendorOption,
  type DetectedOrder,
  type EnrichedProduct,
  type UpcScanItem,
  type ImageIdentification,
  type AiPrediction,
  type LinkImportItem,
  type CsvImportResult,
  type ReconciliationItem,
  type ProductSource,
  ONBOARDING_STEPS,
  STEP_META,
  PRESET_VENDORS,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Helper: generate deterministic IDs                                */
/* ------------------------------------------------------------------ */

let _idCounter = 0;
function nextId(prefix = "op"): string {
  _idCounter += 1;
  return `${prefix}-${Date.now()}-${_idCounter}`;
}

/* ------------------------------------------------------------------ */
/*  Mock data generators (replace with real API calls)                */
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
/*  Main export: OrderPulseOnboarding                                 */
/* ------------------------------------------------------------------ */

export interface OrderPulseOnboardingProps {
  tenantName: string;
  onComplete: (products: EnrichedProduct[]) => void;
  onCancel: () => void;
}

export function OrderPulseOnboarding({
  tenantName,
  onComplete,
  onCancel,
}: OrderPulseOnboardingProps) {
  const [currentStep, setCurrentStep] = React.useState<OnboardingStep>("connect-email");
  const [completedSteps, setCompletedSteps] = React.useState<Set<OnboardingStep>>(new Set());

  // Step 1 — Email
  const [emailConnection, setEmailConnection] = React.useState<EmailConnection | null>(null);

  // Step 2 — Vendors
  const [selectedVendors, setSelectedVendors] = React.useState<Set<string>>(new Set());
  const [customVendors, setCustomVendors] = React.useState<VendorOption[]>([]);

  // Step 3 — Detected orders
  const [detectedOrders, setDetectedOrders] = React.useState<DetectedOrder[]>([]);
  const [isAnalyzing, setIsAnalyzing] = React.useState(false);

  // Step 4 — Enriched products
  const [enrichedProducts, setEnrichedProducts] = React.useState<EnrichedProduct[]>([]);
  const [isEnriching, setIsEnriching] = React.useState(false);

  // Step 5 — UPC scans
  const [upcScans, setUpcScans] = React.useState<UpcScanItem[]>([]);

  // Step 6 — Image identification
  const [imageIdentifications, setImageIdentifications] = React.useState<ImageIdentification[]>([]);

  // Step 7 — Links & CSV
  const [linkImports, setLinkImports] = React.useState<LinkImportItem[]>([]);
  const [csvResult, setCsvResult] = React.useState<CsvImportResult | null>(null);

  // Step 8 — Reconciliation
  const [reconciliationItems, setReconciliationItems] = React.useState<ReconciliationItem[]>([]);
  const [isSyncing, setIsSyncing] = React.useState(false);

  /* ---- Navigation helpers ---- */

  const currentIndex = ONBOARDING_STEPS.indexOf(currentStep);
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === ONBOARDING_STEPS.length - 1;

  const goNext = React.useCallback(() => {
    setCompletedSteps((prev) => new Set([...prev, currentStep]));
    if (!isLast) setCurrentStep(ONBOARDING_STEPS[currentIndex + 1]);
  }, [currentStep, currentIndex, isLast]);

  const goBack = React.useCallback(() => {
    if (!isFirst) setCurrentStep(ONBOARDING_STEPS[currentIndex - 1]);
  }, [currentIndex, isFirst]);

  const goTo = React.useCallback((step: OnboardingStep) => {
    setCurrentStep(step);
  }, []);

  /* ---- Step handlers ---- */

  const handleConnectEmail = React.useCallback(async (provider: EmailProvider, email: string) => {
    setEmailConnection({
      provider,
      email,
      connectedAt: new Date().toISOString(),
      status: "syncing",
    });

    // Simulate OAuth + sync delay
    await new Promise((r) => setTimeout(r, 2000));

    setEmailConnection((prev) =>
      prev ? { ...prev, status: "connected" } : null,
    );
  }, []);

  const handleAnalyzeOrders = React.useCallback(async () => {
    setIsAnalyzing(true);
    await new Promise((r) => setTimeout(r, 2500));
    const orders = mockDetectedOrders([...selectedVendors]);
    setDetectedOrders(orders);
    setIsAnalyzing(false);
  }, [selectedVendors]);

  const handleEnrichProducts = React.useCallback(async () => {
    setIsEnriching(true);
    await new Promise((r) => setTimeout(r, 3000));
    const products = mockEnrichedProducts(detectedOrders);
    setEnrichedProducts(products);
    setIsEnriching(false);
  }, [detectedOrders]);

  const handleAddUpcScan = React.useCallback((upc: string) => {
    const item: UpcScanItem = {
      id: nextId("upc"),
      upc,
      scannedAt: new Date().toISOString(),
      status: "pending",
    };
    setUpcScans((prev) => [...prev, item]);

    // Simulate lookup
    setTimeout(() => {
      setUpcScans((prev) =>
        prev.map((s) =>
          s.id === item.id
            ? {
                ...s,
                status: Math.random() > 0.2 ? "resolved" : "not-found",
                resolvedProduct:
                  Math.random() > 0.2
                    ? {
                        name: `UPC Product ${upc.slice(-4)}`,
                        upc,
                        moq: Math.floor(Math.random() * 50 + 10),
                      }
                    : undefined,
              }
            : s,
        ),
      );
    }, 1500);
  }, []);

  const handleImageUpload = React.useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const entry: ImageIdentification = {
        id: nextId("img"),
        imageDataUrl: reader.result as string,
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        predictions: [],
        status: "analyzing",
      };
      setImageIdentifications((prev) => [...prev, entry]);

      // Simulate AI analysis
      setTimeout(() => {
        setImageIdentifications((prev) =>
          prev.map((img) =>
            img.id === entry.id
              ? {
                  ...img,
                  status: "complete",
                  predictions: [
                    {
                      label: `Industrial Part (${file.name.split(".")[0]})`,
                      confidence: 0.92,
                      suggestedProduct: {
                        name: `AI-Identified: ${file.name.split(".")[0]}`,
                        source: "ai-image" as ProductSource,
                        moq: 25,
                      },
                    },
                    {
                      label: "Similar Component Match",
                      confidence: 0.74,
                      suggestedProduct: {
                        name: `Similar: ${file.name.split(".")[0]} variant`,
                        source: "ai-image" as ProductSource,
                        moq: 50,
                      },
                    },
                  ],
                }
              : img,
          ),
        );
      }, 2500);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleAddLinks = React.useCallback((urls: string[]) => {
    const items: LinkImportItem[] = urls.map((url) => ({
      id: nextId("link"),
      url,
      status: "pending" as const,
    }));
    setLinkImports((prev) => [...prev, ...items]);

    // Simulate scraping each
    for (const item of items) {
      setTimeout(
        () => {
          setLinkImports((prev) =>
            prev.map((li) =>
              li.id === item.id
                ? {
                    ...li,
                    status: Math.random() > 0.15 ? "scraped" : "error",
                    scrapedProduct:
                      Math.random() > 0.15
                        ? {
                            name: `Scraped Product from ${new URL(item.url).hostname}`,
                            productUrl: item.url,
                            source: "link-scrape" as ProductSource,
                            moq: Math.floor(Math.random() * 100 + 5),
                          }
                        : undefined,
                    errorMessage:
                      Math.random() <= 0.15 ? "Could not parse product data from this URL" : undefined,
                  }
                : li,
            ),
          );
        },
        1000 + Math.random() * 2000,
      );
    }
  }, []);

  const handleCsvUpload = React.useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.trim().split("\n");
      const headers = lines[0]?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
      const nameIdx = headers.findIndex((h) => h.includes("name") || h.includes("product"));
      const skuIdx = headers.findIndex((h) => h.includes("sku") || h.includes("part"));
      const qtyIdx = headers.findIndex((h) => h.includes("qty") || h.includes("quantity") || h.includes("moq"));

      const parsedItems: Partial<EnrichedProduct>[] = [];
      const errors: { row: number; message: string }[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map((c) => c.trim());
        const name = nameIdx >= 0 ? cols[nameIdx] : undefined;
        if (!name) {
          errors.push({ row: i + 1, message: "Missing product name" });
          continue;
        }
        parsedItems.push({
          name,
          sku: skuIdx >= 0 ? cols[skuIdx] : undefined,
          moq: qtyIdx >= 0 ? parseInt(cols[qtyIdx], 10) || 0 : 0,
          source: "csv-upload",
        });
      }

      setCsvResult({
        fileName: file.name,
        totalRows: lines.length - 1,
        parsedItems,
        errors,
      });
    };
    reader.readAsText(file);
  }, []);

  const handleBuildReconciliation = React.useCallback(() => {
    const allProducts: EnrichedProduct[] = [...enrichedProducts];

    // Add UPC-resolved items
    for (const scan of upcScans) {
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

    // Add AI-identified items
    for (const img of imageIdentifications) {
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

    // Add link-scraped items
    for (const link of linkImports) {
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

    // Add CSV items
    if (csvResult) {
      for (const item of csvResult.parsedItems) {
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

    // Dedupe by name (rough) and build reconciliation items
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

    setReconciliationItems(Array.from(seen.values()));
  }, [enrichedProducts, upcScans, imageIdentifications, linkImports, csvResult]);

  const handleSyncToArda = React.useCallback(async () => {
    setIsSyncing(true);
    await new Promise((r) => setTimeout(r, 3000));
    setIsSyncing(false);
    onComplete(reconciliationItems.filter((item) => item.isApproved));
  }, [onComplete, reconciliationItems]);

  /* ---- Render ---- */

  return (
    <div className="space-y-6">
      {/* Wizard header */}
      <div className="relative overflow-hidden rounded-2xl border bg-[linear-gradient(120deg,hsl(var(--arda-orange))_0%,hsl(var(--arda-orange-hover))_50%,hsl(var(--arda-blue))_120%)] p-6 text-white shadow-arda-orange">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.24),transparent_45%)]" />
        <div className="relative z-10 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
              Order Pulse
            </p>
            <h3 className="mt-1 text-2xl font-bold">Product Onboarding Wizard</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/90">
              Import products from emails, vendor APIs, barcode scans, photos, links, and
              spreadsheets — then reconcile and sync to {tenantName}.
            </p>
          </div>
          <Button variant="secondary" onClick={onCancel}>
            Exit Wizard
          </Button>
        </div>
      </div>

      {/* Step indicator */}
      <StepIndicator
        steps={ONBOARDING_STEPS}
        currentStep={currentStep}
        completedSteps={completedSteps}
        onStepClick={goTo}
      />

      {/* Step content */}
      <div className="min-h-[50vh]">
        {currentStep === "connect-email" && (
          <StepConnectEmail
            connection={emailConnection}
            onConnect={handleConnectEmail}
          />
        )}
        {currentStep === "select-vendors" && (
          <StepSelectVendors
            selectedVendors={selectedVendors}
            onToggleVendor={(id) =>
              setSelectedVendors((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            customVendors={customVendors}
            onAddCustomVendor={(vendor) => setCustomVendors((prev) => [...prev, vendor])}
          />
        )}
        {currentStep === "analyze-orders" && (
          <StepAnalyzeOrders
            orders={detectedOrders}
            isAnalyzing={isAnalyzing}
            onAnalyze={handleAnalyzeOrders}
            selectedVendors={selectedVendors}
          />
        )}
        {currentStep === "enrich-products" && (
          <StepEnrichProducts
            products={enrichedProducts}
            isEnriching={isEnriching}
            onEnrich={handleEnrichProducts}
            orderCount={detectedOrders.reduce((n, o) => n + o.items.length, 0)}
          />
        )}
        {currentStep === "scan-upcs" && (
          <StepScanUpcs scans={upcScans} onScan={handleAddUpcScan} />
        )}
        {currentStep === "identify-images" && (
          <StepIdentifyImages
            images={imageIdentifications}
            onUpload={handleImageUpload}
            onSelectPrediction={(imgId, pred) =>
              setImageIdentifications((prev) =>
                prev.map((img) =>
                  img.id === imgId ? { ...img, selectedPrediction: pred } : img,
                ),
              )
            }
          />
        )}
        {currentStep === "import-links" && (
          <StepImportLinks
            links={linkImports}
            csvResult={csvResult}
            onAddLinks={handleAddLinks}
            onCsvUpload={handleCsvUpload}
          />
        )}
        {currentStep === "reconcile" && (
          <StepReconcile
            items={reconciliationItems}
            isSyncing={isSyncing}
            onBuildReconciliation={handleBuildReconciliation}
            onToggleApproval={(id) =>
              setReconciliationItems((prev) =>
                prev.map((item) =>
                  item.id === id ? { ...item, isApproved: !item.isApproved } : item,
                ),
              )
            }
            onUpdateItem={(id, updates) =>
              setReconciliationItems((prev) =>
                prev.map((item) =>
                  item.id === id ? { ...item, ...updates, userOverrides: { ...item.userOverrides, ...updates } } : item,
                ),
              )
            }
            onSync={handleSyncToArda}
          />
        )}
      </div>

      {/* Navigation footer */}
      <div className="flex items-center justify-between rounded-xl border bg-card p-4">
        <Button
          variant="outline"
          onClick={goBack}
          disabled={isFirst}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <p className="text-sm text-muted-foreground">
          Step {currentIndex + 1} of {ONBOARDING_STEPS.length}
        </p>

        {isLast ? (
          <Button
            onClick={() => void handleSyncToArda()}
            disabled={isSyncing || reconciliationItems.filter((i) => i.isApproved).length === 0}
          >
            {isSyncing ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Syncing...
              </span>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4" />
                Sync to Arda
              </>
            )}
          </Button>
        ) : (
          <Button onClick={goNext}>
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Step Indicator                                                    */
/* ================================================================== */

function StepIndicator({
  steps,
  currentStep,
  completedSteps,
  onStepClick,
}: {
  steps: OnboardingStep[];
  currentStep: OnboardingStep;
  completedSteps: Set<OnboardingStep>;
  onStepClick: (step: OnboardingStep) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="flex items-center gap-1 min-w-max">
        {steps.map((step, idx) => {
          const meta = STEP_META[step];
          const isActive = step === currentStep;
          const isDone = completedSteps.has(step);
          const isClickable = isDone || step === currentStep || idx <= [...completedSteps].length;

          return (
            <React.Fragment key={step}>
              {idx > 0 && (
                <div
                  className={cn(
                    "h-0.5 w-6 flex-shrink-0",
                    isDone ? "bg-[hsl(var(--arda-success))]" : "bg-border",
                  )}
                />
              )}
              <button
                type="button"
                disabled={!isClickable}
                onClick={() => onStepClick(step)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
                  isActive &&
                    "bg-[hsl(var(--arda-blue)/0.1)] text-[hsl(var(--arda-blue))] border border-[hsl(var(--arda-blue)/0.3)]",
                  isDone && !isActive &&
                    "bg-[hsl(var(--arda-success)/0.08)] text-[hsl(var(--arda-success))]",
                  !isActive && !isDone &&
                    "text-muted-foreground hover:bg-muted disabled:opacity-40",
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold flex-shrink-0",
                    isActive && "bg-[hsl(var(--arda-blue))] text-white",
                    isDone && !isActive && "bg-[hsl(var(--arda-success))] text-white",
                    !isActive && !isDone && "bg-muted text-muted-foreground",
                  )}
                >
                  {isDone ? <Check className="h-3.5 w-3.5" /> : idx + 1}
                </span>
                <span className="hidden lg:inline">{meta.label}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Step 1: Connect Email                                             */
/* ================================================================== */

function StepConnectEmail({
  connection,
  onConnect,
}: {
  connection: EmailConnection | null;
  onConnect: (provider: EmailProvider, email: string) => Promise<void>;
}) {
  const [email, setEmail] = React.useState("");
  const [provider, setProvider] = React.useState<EmailProvider>("gmail");
  const [isConnecting, setIsConnecting] = React.useState(false);

  const providers: { id: EmailProvider; label: string; icon: string }[] = [
    { id: "gmail", label: "Gmail / Google Workspace", icon: "📧" },
    { id: "outlook", label: "Outlook / Microsoft 365", icon: "📬" },
    { id: "yahoo", label: "Yahoo Mail", icon: "✉️" },
    { id: "other", label: "Other (IMAP)", icon: "🔗" },
  ];

  const handleConnect = async () => {
    if (!email.trim()) return;
    setIsConnecting(true);
    await onConnect(provider, email.trim());
    setIsConnecting(false);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
            Connect Your Email
          </CardTitle>
          <CardDescription>
            We'll scan your inbox for purchase orders, shipping confirmations, and
            invoices from your vendors to automatically detect products and order patterns.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connection?.status === "connected" ? (
            <div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--arda-success)/0.3)] bg-[hsl(var(--arda-success)/0.06)] p-4">
              <MailCheck className="h-6 w-6 text-[hsl(var(--arda-success))]" />
              <div>
                <p className="text-sm font-semibold text-[hsl(var(--arda-success))]">
                  Connected successfully
                </p>
                <p className="text-xs text-muted-foreground">
                  {connection.email} • {connection.provider}
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProvider(p.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                      provider === p.id
                        ? "border-[hsl(var(--arda-blue)/0.4)] bg-[hsl(var(--arda-blue)/0.06)]"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <span className="text-xl">{p.icon}</span>
                    <span className="text-sm font-medium">{p.label}</span>
                  </button>
                ))}
              </div>

              <label className="form-label-arda">
                Email Address
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="purchasing@company.com"
                />
              </label>

              <Button
                className="w-full"
                disabled={!email.trim() || isConnecting}
                onClick={() => void handleConnect()}
              >
                {isConnecting ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting...
                  </span>
                ) : (
                  <>
                    <Mail className="h-4 w-4" />
                    Connect Email
                  </>
                )}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="card-arda">
        <CardHeader>
          <CardTitle className="text-base">What we look for</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            { icon: Package, label: "Purchase order confirmations" },
            { icon: Download, label: "Shipping & tracking notifications" },
            { icon: FileSpreadsheet, label: "Invoices and receipts" },
            { icon: Globe, label: "Vendor account notifications" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-3 text-sm">
              <div className="rounded-full bg-[hsl(var(--arda-blue)/0.1)] p-2">
                <Icon className="h-4 w-4 text-[hsl(var(--arda-blue))]" />
              </div>
              <span>{label}</span>
            </div>
          ))}

          <div className="mt-4 rounded-lg bg-muted p-3">
            <p className="text-xs text-muted-foreground">
              <ShieldCheck className="mr-1 inline h-3.5 w-3.5" />
              We only read purchase-related emails. Your personal messages are never accessed or stored.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ================================================================== */
/*  Step 2: Select Vendors                                            */
/* ================================================================== */

function StepSelectVendors({
  selectedVendors,
  onToggleVendor,
  customVendors,
  onAddCustomVendor,
}: {
  selectedVendors: Set<string>;
  onToggleVendor: (id: string) => void;
  customVendors: VendorOption[];
  onAddCustomVendor: (vendor: VendorOption) => void;
}) {
  const [showCustomForm, setShowCustomForm] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customDomain, setCustomDomain] = React.useState("");

  const allVendors = [...PRESET_VENDORS, ...customVendors];

  const addCustom = () => {
    if (!customName.trim() || !customDomain.trim()) return;
    onAddCustomVendor({
      id: `custom-${Date.now()}`,
      name: customName.trim(),
      logo: "🏢",
      domain: customDomain.trim(),
      hasApi: false,
    });
    setCustomName("");
    setCustomDomain("");
    setShowCustomForm(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          Select Your Vendors
        </CardTitle>
        <CardDescription>
          Choose the suppliers you regularly order from. We'll search your email for
          orders from these vendors and connect to their APIs when available.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {allVendors.map((vendor) => {
            const selected = selectedVendors.has(vendor.id);
            return (
              <button
                key={vendor.id}
                type="button"
                onClick={() => onToggleVendor(vendor.id)}
                className={cn(
                  "relative flex flex-col items-center gap-2 rounded-xl border p-4 text-center transition-all",
                  selected
                    ? "border-[hsl(var(--arda-blue)/0.5)] bg-[hsl(var(--arda-blue)/0.06)] shadow-sm"
                    : "border-border hover:bg-muted",
                )}
              >
                {selected && (
                  <div className="absolute top-2 right-2">
                    <CheckCircle2 className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
                  </div>
                )}
                <span className="text-2xl">{vendor.logo}</span>
                <span className="text-sm font-semibold">{vendor.name}</span>
                <span className="text-xs text-muted-foreground">{vendor.domain}</span>
                {vendor.hasApi && (
                  <Badge variant="accent" className="mt-1">
                    API Available
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        {showCustomForm ? (
          <div className="rounded-xl border bg-muted/50 p-4 space-y-3">
            <p className="text-sm font-semibold">Add Custom Vendor</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                placeholder="Vendor name"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
              <Input
                placeholder="Domain (e.g. vendor.com)"
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={addCustom} disabled={!customName.trim() || !customDomain.trim()}>
                <Plus className="h-4 w-4" />
                Add Vendor
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowCustomForm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setShowCustomForm(true)}>
            <Plus className="h-4 w-4" />
            Add Custom Vendor
          </Button>
        )}

        <p className="text-sm text-muted-foreground">
          {selectedVendors.size} vendor{selectedVendors.size !== 1 ? "s" : ""} selected
        </p>
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/*  Step 3: Analyze Orders                                            */
/* ================================================================== */

function StepAnalyzeOrders({
  orders,
  isAnalyzing,
  onAnalyze,
  selectedVendors,
}: {
  orders: DetectedOrder[];
  isAnalyzing: boolean;
  onAnalyze: () => Promise<void>;
  selectedVendors: Set<string>;
}) {
  const totalItems = orders.reduce((n, o) => n + o.items.length, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
            Analyze Email Orders
          </CardTitle>
          <CardDescription>
            Scanning your inbox for purchase orders from {selectedVendors.size} selected
            vendor{selectedVendors.size !== 1 ? "s" : ""}. We'll determine order frequency
            and minimum order quantities.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {orders.length === 0 ? (
            <div className="text-center py-8 space-y-4">
              <Button onClick={() => void onAnalyze()} disabled={isAnalyzing || selectedVendors.size === 0}>
                {isAnalyzing ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Scanning emails...
                  </span>
                ) : (
                  <>
                    <Search className="h-4 w-4" />
                    Start Email Analysis
                  </>
                )}
              </Button>
              {selectedVendors.size === 0 && (
                <p className="text-sm text-[hsl(var(--arda-warning))]">
                  Go back and select at least one vendor first.
                </p>
              )}
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
                  <p className="text-2xl font-bold">{selectedVendors.size}</p>
                  <p className="text-xs text-muted-foreground">Vendors Matched</p>
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

/* ================================================================== */
/*  Step 4: Enrich Products                                           */
/* ================================================================== */

function StepEnrichProducts({
  products,
  isEnriching,
  onEnrich,
  orderCount,
}: {
  products: EnrichedProduct[];
  isEnriching: boolean;
  onEnrich: () => Promise<void>;
  orderCount: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          Enrich Product Data
        </CardTitle>
        <CardDescription>
          Scraping images, ASINs, and product details from Amazon Product Advertising API
          and other vendor APIs for {orderCount} detected line items.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {products.length === 0 ? (
          <div className="text-center py-8">
            <Button onClick={() => void onEnrich()} disabled={isEnriching || orderCount === 0}>
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

/* ================================================================== */
/*  Step 5: Scan UPCs                                                 */
/* ================================================================== */

function StepScanUpcs({
  scans,
  onScan,
}: {
  scans: UpcScanItem[];
  onScan: (upc: string) => void;
}) {
  const [manualUpc, setManualUpc] = React.useState("");

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualUpc.trim()) {
      onScan(manualUpc.trim());
      setManualUpc("");
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <QrCode className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
            Scan UPCs from Your Phone
          </CardTitle>
          <CardDescription>
            Scan this QR code with your phone to open the mobile barcode scanner.
            Scanned items will appear here in real-time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* QR code display */}
          <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.04)] p-8">
            <div className="rounded-2xl bg-white p-4 shadow-sm">
              {/* Stylized QR placeholder */}
              <div className="grid grid-cols-7 gap-1 w-[140px] h-[140px]">
                {Array.from({ length: 49 }, (_, i) => (
                  <div
                    key={i}
                    className={cn(
                      "rounded-sm",
                      Math.random() > 0.45 ? "bg-foreground" : "bg-white",
                    )}
                  />
                ))}
              </div>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold">Point your phone camera here</p>
              <p className="text-xs text-muted-foreground mt-1">
                Opens arda.cards/scan on your mobile device
              </p>
            </div>
          </div>

          {/* Manual entry */}
          <form onSubmit={handleManualSubmit} className="flex gap-2">
            <Input
              value={manualUpc}
              onChange={(e) => setManualUpc(e.target.value)}
              placeholder="Or type UPC manually..."
              className="flex-1"
            />
            <Button type="submit" variant="outline" disabled={!manualUpc.trim()}>
              <ScanBarcode className="h-4 w-4" />
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scanned Items ({scans.length})</CardTitle>
          <CardDescription>
            Products identified from barcode scans
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
          {scans.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              No barcodes scanned yet. Use the QR code or manual entry above.
            </p>
          )}

          {scans.map((scan) => (
            <div key={scan.id} className="card-order-item">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-mono font-semibold">{scan.upc}</p>
                  {scan.resolvedProduct?.name && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {scan.resolvedProduct.name}
                    </p>
                  )}
                </div>
                <Badge
                  variant={
                    scan.status === "resolved"
                      ? "success"
                      : scan.status === "pending"
                        ? "secondary"
                        : "warning"
                  }
                >
                  {scan.status === "pending" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                  {scan.status}
                </Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/* ================================================================== */
/*  Step 6: AI Image Identification                                   */
/* ================================================================== */

function StepIdentifyImages({
  images,
  onUpload,
  onSelectPrediction,
}: {
  images: ImageIdentification[];
  onUpload: (file: File) => void;
  onSelectPrediction: (imgId: string, pred: AiPrediction) => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      onUpload(files[i]);
    }
    e.target.value = "";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Camera className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          AI Product Identification
        </CardTitle>
        <CardDescription>
          Upload photos of products and our AI will identify them, suggest matches, and
          extract relevant details.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.04)] p-8 transition-colors hover:bg-[hsl(var(--arda-blue)/0.08)]"
        >
          <ImagePlus className="h-8 w-8 text-[hsl(var(--arda-blue))]" />
          <div className="text-center">
            <p className="text-sm font-semibold">Upload product images</p>
            <p className="text-xs text-muted-foreground mt-1">
              Drag and drop or click to browse. Supports JPG, PNG, WebP.
            </p>
          </div>
        </button>

        {images.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {images.map((img) => (
              <div key={img.id} className="rounded-xl border bg-card overflow-hidden">
                <div className="aspect-video bg-muted relative">
                  <img
                    src={img.imageDataUrl}
                    alt={img.fileName}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {img.status === "analyzing" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                      <div className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-sm font-medium">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Analyzing...
                      </div>
                    </div>
                  )}
                </div>
                <div className="p-3 space-y-2">
                  <p className="text-xs text-muted-foreground truncate">{img.fileName}</p>
                  {img.predictions.map((pred, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => onSelectPrediction(img.id, pred)}
                      className={cn(
                        "w-full rounded-lg border p-2 text-left transition-colors",
                        img.selectedPrediction === pred
                          ? "border-[hsl(var(--arda-blue)/0.4)] bg-[hsl(var(--arda-blue)/0.06)]"
                          : "hover:bg-muted",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">{pred.label}</span>
                        <Badge variant={pred.confidence >= 0.8 ? "success" : "warning"}>
                          {Math.round(pred.confidence * 100)}%
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/*  Step 7: Import Links & CSV                                        */
/* ================================================================== */

function StepImportLinks({
  links,
  csvResult,
  onAddLinks,
  onCsvUpload,
}: {
  links: LinkImportItem[];
  csvResult: CsvImportResult | null;
  onAddLinks: (urls: string[]) => void;
  onCsvUpload: (file: File) => void;
}) {
  const [linkText, setLinkText] = React.useState("");
  const csvInputRef = React.useRef<HTMLInputElement>(null);

  const handleAddLinks = () => {
    const urls = linkText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("http"));
    if (urls.length > 0) {
      onAddLinks(urls);
      setLinkText("");
    }
  };

  const handleCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onCsvUpload(file);
      e.target.value = "";
    }
  };

  return (
    <Tabs defaultValue="links" className="space-y-4">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="links">
          <Link2 className="h-4 w-4 mr-2" />
          Paste Links
        </TabsTrigger>
        <TabsTrigger value="csv">
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Upload CSV
        </TabsTrigger>
      </TabsList>

      <TabsContent value="links">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
              Import from Product Links
            </CardTitle>
            <CardDescription>
              Paste product URLs (one per line) and we'll scrape product details from those pages.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <textarea
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
              placeholder={"https://amazon.com/dp/B0XXXXX\nhttps://mcmaster.com/12345\nhttps://uline.com/product/S-XXXXX"}
              rows={5}
              className="form-input-arda resize-none font-mono text-xs"
            />
            <Button onClick={handleAddLinks} disabled={!linkText.trim()}>
              <Globe className="h-4 w-4" />
              Scrape Links
            </Button>

            {links.length > 0 && (
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {links.map((link) => (
                  <div key={link.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                    {link.status === "pending" || link.status === "scraping" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
                    ) : link.status === "scraped" ? (
                      <CheckCircle2 className="h-4 w-4 text-[hsl(var(--arda-success))] flex-shrink-0" />
                    ) : (
                      <CircleAlert className="h-4 w-4 text-[hsl(var(--arda-error))] flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-mono truncate">{link.url}</p>
                      {link.scrapedProduct?.name && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          → {link.scrapedProduct.name}
                        </p>
                      )}
                      {link.errorMessage && (
                        <p className="text-xs text-[hsl(var(--arda-error))] mt-0.5">
                          {link.errorMessage}
                        </p>
                      )}
                    </div>
                    <Badge variant={link.status === "scraped" ? "success" : link.status === "error" ? "destructive" : "secondary"}>
                      {link.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="csv">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
              Upload CSV Spreadsheet
            </CardTitle>
            <CardDescription>
              Upload a CSV file with product information. Expected columns: Name/Product,
              SKU/Part Number, Quantity/MOQ.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,.tsv"
              className="hidden"
              onChange={handleCsvChange}
            />
            <button
              type="button"
              onClick={() => csvInputRef.current?.click()}
              className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.04)] p-8 transition-colors hover:bg-[hsl(var(--arda-blue)/0.08)]"
            >
              <CloudUpload className="h-8 w-8 text-[hsl(var(--arda-blue))]" />
              <div className="text-center">
                <p className="text-sm font-semibold">Upload CSV file</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Drag and drop or click to browse
                </p>
              </div>
            </button>

            {csvResult && (
              <div className="rounded-xl border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{csvResult.fileName}</p>
                  <Badge variant="accent">{csvResult.totalRows} rows</Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-[hsl(var(--arda-success)/0.06)] border border-[hsl(var(--arda-success)/0.2)] p-3 text-center">
                    <p className="text-xl font-bold text-[hsl(var(--arda-success))]">
                      {csvResult.parsedItems.length}
                    </p>
                    <p className="text-xs text-muted-foreground">Parsed Successfully</p>
                  </div>
                  <div className="rounded-lg bg-[hsl(var(--arda-error)/0.06)] border border-[hsl(var(--arda-error)/0.2)] p-3 text-center">
                    <p className="text-xl font-bold text-[hsl(var(--arda-error))]">
                      {csvResult.errors.length}
                    </p>
                    <p className="text-xs text-muted-foreground">Errors</p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

/* ================================================================== */
/*  Step 8: Reconcile & Sync                                          */
/* ================================================================== */

function StepReconcile({
  items,
  isSyncing,
  onBuildReconciliation,
  onToggleApproval,
  onUpdateItem,
  onSync,
}: {
  items: ReconciliationItem[];
  isSyncing: boolean;
  onBuildReconciliation: () => void;
  onToggleApproval: (id: string) => void;
  onUpdateItem: (id: string, updates: Partial<EnrichedProduct>) => void;
  onSync: () => Promise<void>;
}) {
  const approvedCount = items.filter((i) => i.isApproved).length;

  const sourceColors: Record<ProductSource, string> = {
    "email-import": "bg-[hsl(var(--arda-blue)/0.1)] text-[hsl(var(--arda-blue))]",
    "api-enrichment": "bg-[hsl(var(--arda-success)/0.1)] text-[hsl(var(--arda-success))]",
    "upc-scan": "bg-[hsl(var(--arda-orange)/0.1)] text-[hsl(var(--arda-orange))]",
    "ai-image": "bg-purple-100 text-purple-700",
    "link-scrape": "bg-cyan-100 text-cyan-700",
    "csv-upload": "bg-amber-100 text-amber-700",
    manual: "bg-muted text-muted-foreground",
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
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onBuildReconciliation}>
                <Sparkles className="h-4 w-4" />
                Build Reconciliation
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              Click "Build Reconciliation" to aggregate products from all sources.
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
                        onChange={() => onToggleApproval(item.id)}
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
                                sourceColors[source],
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
                  onClick={() => void onSync()}
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
