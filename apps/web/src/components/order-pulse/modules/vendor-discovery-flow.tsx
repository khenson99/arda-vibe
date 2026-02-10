/**
 * Combined flow: Select Vendors + Enrich Products
 *
 * Renders both modules in a single dialog as collapsible sections,
 * so the user sees the full vendor-selection-to-enrichment flow at once.
 */

import * as React from "react";
import { ChevronDown, Package, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useImportContext } from "../import-context";
import { SelectVendorsModule } from "./select-vendors-module";
import { EnrichProductsModule } from "./enrich-products-module";

export function VendorDiscoveryFlow() {
  const { state } = useImportContext();
  const hasVendors = state.selectedVendors.size > 0;

  const [vendorsOpen, setVendorsOpen] = React.useState(true);
  const [enrichOpen, setEnrichOpen] = React.useState(false);

  // When vendors are selected and orders exist, auto-expand enrich
  React.useEffect(() => {
    if (hasVendors && state.detectedOrders.length > 0) {
      setVendorsOpen(false);
      setEnrichOpen(true);
    }
  }, [hasVendors, state.detectedOrders.length]);

  return (
    <div className="space-y-4">
      {/* Section 1: Select Vendors */}
      <CollapsibleSection
        title="Select Vendors"
        icon={<Package className="h-4 w-4" />}
        isOpen={vendorsOpen}
        onToggle={() => setVendorsOpen((v) => !v)}
        badge={
          state.selectedVendors.size > 0
            ? `${state.selectedVendors.size} selected`
            : undefined
        }
      >
        <SelectVendorsModule />
      </CollapsibleSection>

      {/* Section 2: Enrich Products */}
      <CollapsibleSection
        title="Enrich Products"
        icon={<Sparkles className="h-4 w-4" />}
        isOpen={enrichOpen}
        onToggle={() => setEnrichOpen((v) => !v)}
        badge={
          state.enrichedProducts.length > 0
            ? `${state.enrichedProducts.length} products`
            : undefined
        }
      >
        <EnrichProductsModule />
      </CollapsibleSection>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared collapsible section wrapper                                */
/* ------------------------------------------------------------------ */

function CollapsibleSection({
  title,
  icon,
  isOpen,
  onToggle,
  badge,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="text-[hsl(var(--arda-blue))]">{icon}</span>
          {title}
          {badge && (
            <span className="rounded-full bg-[hsl(var(--arda-success)/0.1)] px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--arda-success))]">
              {badge}
            </span>
          )}
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>
      {isOpen && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}
