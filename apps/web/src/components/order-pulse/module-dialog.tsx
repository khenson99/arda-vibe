/**
 * Module Dialog — renders the active import module inside a shadcn Dialog.
 *
 * Controlled by `state.activeModule` from ImportContext. When null the dialog
 * is closed; when set to an ImportModuleId the corresponding module renders.
 */

import * as React from "react";

import {
  Badge,
  Button,
  SidePanel,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  ONBOARDING_STEPS,
  STEP_META,
  type ImportModuleId,
  type OnboardingStep,
} from "./types";
import { useImportContext, type ImportState } from "./import-context";
import { runBackgroundImportPipeline } from "./background-import";
import {
  ConnectEmailModule,
  SelectVendorsModule,
  AnalyzeOrdersModule,
  EnrichProductsModule,
  ScanUpcsModule,
  AiIdentifyModule,
  ImportLinksModule,
  UploadCsvModule,
  ReconcileSyncModule,
  EmailScanFlow,
  VendorDiscoveryFlow,
} from "./modules";

const STEP_TO_MODULE: Record<OnboardingStep, ImportModuleId> = {
  "connect-email": "connect-email",
  "select-vendors": "select-vendors",
  "scan-upcs": "scan-upcs",
  "identify-images": "identify-images",
  "import-links": "import-links",
  "upload-csv": "upload-csv",
  reconcile: "reconcile",
  // Legacy/manual modules
  "analyze-orders": "analyze-orders",
  "enrich-products": "enrich-products",
};

/* ------------------------------------------------------------------ */
/*  Module metadata for dialog titles / sizes                         */
/* ------------------------------------------------------------------ */

const MODULE_META: Record<
  ImportModuleId,
  { title: string; description: string; wide?: boolean }
> = {
  "email-scan": {
    title: "Connect Email & Scan Orders",
    description: "Link your email and scan for purchase orders",
    wide: true,
  },
  "import-links": {
    title: "Import Product Links",
    description: "Paste product URLs and scrape item data",
  },
  "upload-csv": {
    title: "Upload CSV",
    description: "Upload a spreadsheet of products",
  },
  "vendor-discovery": {
    title: "Vendor Product Search",
    description: "Browse and enrich from vendor catalogs",
    wide: true,
  },
  "scan-upcs": {
    title: "Scan UPC Barcodes",
    description: "Use your phone to scan barcodes",
    wide: true,
  },
  "ai-identify": {
    title: "AI Photo Identify",
    description: "Upload photos for AI matching",
  },
  reconcile: {
    title: "Review & Sync",
    description: "Review, correct, and sync everything to Arda",
    wide: true,
  },
  // Individual steps (for guided onboarding)
  "connect-email": {
    title: "Connect Email",
    description: "Link your email to import purchase orders",
    wide: true,
  },
  "select-vendors": {
    title: "Select Vendors",
    description: "Choose the suppliers you order from regularly",
  },
  "analyze-orders": {
    title: "Analyze Orders",
    description: "Scan for purchase orders and order patterns",
  },
  "enrich-products": {
    title: "Enrich Products",
    description: "Pull images, ASINs, and product details",
  },
  "identify-images": {
    title: "AI Identify",
    description: "Upload photos and let AI identify your products",
  },
};

const DEEP_LINKABLE_MODULES: ImportModuleId[] = [
  "email-scan",
  "import-links",
  "upload-csv",
  "vendor-discovery",
  "scan-upcs",
  "ai-identify",
  "reconcile",
  "connect-email",
  "select-vendors",
  "analyze-orders",
  "enrich-products",
  "identify-images",
];

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function ModuleDialog() {
  const { state, dispatch } = useImportContext();
  const { activeModule } = state;

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeModule) return;

    const params = new URLSearchParams(window.location.search);
    if (!params.get("gmail_oauth")) return;

    dispatch({ type: "OPEN_MODULE", module: "connect-email" });
  }, [activeModule, dispatch]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeModule) return;

    const params = new URLSearchParams(window.location.search);
    const moduleParam = params.get("import");
    if (!moduleParam) return;
    if (!DEEP_LINKABLE_MODULES.includes(moduleParam as ImportModuleId)) return;

    dispatch({ type: "OPEN_MODULE", module: moduleParam as ImportModuleId });

    params.delete("import");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [activeModule, dispatch]);

  const isOpen = activeModule !== null;
  const meta = activeModule ? MODULE_META[activeModule] : null;
  const workflow = React.useMemo(() => {
    if (!activeModule) return null;

    const currentStep = inferCurrentStep(activeModule, state);
    if (!currentStep) return null;

    const index = ONBOARDING_STEPS.indexOf(currentStep);
    if (index < 0) return null;

    const previousStep = index > 0 ? ONBOARDING_STEPS[index - 1] : null;
    const nextStep = index < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[index + 1] : null;
    const isComplete = isStepComplete(currentStep, state);

    return {
      currentStep,
      currentStepIndex: index,
      previousStep,
      nextStep,
      isComplete,
    };
  }, [activeModule, state]);

  const openStep = React.useCallback(
    (step: OnboardingStep) => {
      const stepsNeedingBackgroundAnalysis: OnboardingStep[] = [
        "scan-upcs",
        "identify-images",
        "import-links",
        "upload-csv",
        "reconcile",
      ];

      if (
        stepsNeedingBackgroundAnalysis.includes(step) &&
        state.backgroundImportStatus === "idle"
      ) {
        void runBackgroundImportPipeline(state, dispatch);
      }

      dispatch({ type: "SET_GUIDED_STEP", step });
      dispatch({ type: "OPEN_MODULE", module: STEP_TO_MODULE[step] });
    },
    [dispatch, state],
  );

  return (
    <SidePanel
      open={isOpen}
      onClose={() => dispatch({ type: "CLOSE_MODULE" })}
      title={meta?.title ?? "Import Module"}
      subtitle={meta?.description}
      width={meta?.wide ? "wide" : "default"}
    >
      <div className="p-4">
        <div className="mt-2">{activeModule && <ModuleRenderer module={activeModule} />}</div>

        {workflow && (
          <div className="mt-4 rounded-xl border bg-muted/30 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Step {workflow.currentStepIndex + 1} of {ONBOARDING_STEPS.length}:{" "}
                {STEP_META[workflow.currentStep].label}
              </p>
              <Badge variant={workflow.isComplete ? "success" : "warning"}>
                {workflow.isComplete ? "Completed" : "In progress"}
              </Badge>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {workflow.previousStep && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openStep(workflow.previousStep!)}
                >
                  Back
                </Button>
              )}

              {workflow.nextStep && !workflow.isComplete && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openStep(workflow.nextStep!)}
                >
                  Skip step
                </Button>
              )}

              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => dispatch({ type: "CLOSE_MODULE" })}
                >
                  Close
                </Button>

                {workflow.nextStep ? (
                  <Button size="sm" onClick={() => openStep(workflow.nextStep!)}>
                    {workflow.isComplete ? "Continue" : "Continue anyway"}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => dispatch({ type: "CLOSE_MODULE" })}>
                    Finish
                  </Button>
                )}
              </div>
            </div>

            {(state.backgroundImportStatus === "running" ||
              state.backgroundImportStatus === "complete" ||
              state.backgroundImportStatus === "error") && (
              <div className="mt-3 rounded-lg border bg-background/80 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">Background Catalog Analysis</p>
                  <span className="text-[11px] text-muted-foreground">
                    {Math.round(state.backgroundImportProgress)}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-500",
                      state.backgroundImportStatus === "error"
                        ? "bg-[hsl(var(--arda-error))]"
                        : "bg-[hsl(var(--arda-blue))]",
                    )}
                    style={{
                      width: `${Math.min(100, Math.max(0, state.backgroundImportProgress))}%`,
                    }}
                  />
                </div>
                {state.backgroundImportMessage && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {state.backgroundImportMessage}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  );
}

/* ------------------------------------------------------------------ */
/*  Maps module ID → component                                        */
/* ------------------------------------------------------------------ */

function ModuleRenderer({ module }: { module: ImportModuleId }) {
  switch (module) {
    case "email-scan":
      return <EmailScanFlow />;
    case "import-links":
      return <ImportLinksModule mode="links" />;
    case "upload-csv":
      return <UploadCsvModule />;
    case "vendor-discovery":
      return <VendorDiscoveryFlow />;
    case "scan-upcs":
      return <ScanUpcsModule />;
    case "ai-identify":
      return <AiIdentifyModule />;
    case "reconcile":
      return <ReconcileSyncModule />;
    // Individual steps
    case "connect-email":
      return <ConnectEmailModule />;
    case "select-vendors":
      return <SelectVendorsModule />;
    case "analyze-orders":
      return <AnalyzeOrdersModule />;
    case "enrich-products":
      return <EnrichProductsModule />;
    case "identify-images":
      return <AiIdentifyModule />;
    default:
      return null;
  }
}

function inferCurrentStep(
  module: ImportModuleId,
  _state: ImportState,
): OnboardingStep | null {
  switch (module) {
    case "connect-email":
    case "select-vendors":
    case "analyze-orders":
    case "enrich-products":
    case "scan-upcs":
    case "identify-images":
    case "import-links":
    case "upload-csv":
    case "reconcile":
      return module;
    case "ai-identify":
      return "identify-images";
    case "email-scan":
      return null;
    case "vendor-discovery":
      return null;
    default:
      return null;
  }
}

function isStepComplete(step: OnboardingStep, state: ImportState): boolean {
  switch (step) {
    case "connect-email":
      return state.emailConnection?.status === "connected";
    case "select-vendors":
      return state.selectedVendors.size > 0;
    case "analyze-orders":
      return state.detectedOrders.length > 0;
    case "enrich-products":
      return state.enrichedProducts.length > 0;
    case "scan-upcs":
      return state.upcScans.length > 0;
    case "identify-images":
      return state.imageIdentifications.length > 0;
    case "import-links":
      return state.linkImports.some((item) => item.status === "scraped");
    case "upload-csv":
      return Boolean(state.csvResult?.parsedItems.length);
    case "reconcile":
      return state.reconciliationItems.length > 0;
    default:
      return false;
  }
}
