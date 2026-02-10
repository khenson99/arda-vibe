import * as React from "react";
import { ArrowRight, CheckCircle2, Package, Plus } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@/components/ui";
import {
  discoverGmailSuppliers,
  parseApiError,
  readStoredSession,
  type GmailDiscoveredSupplier,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { PRESET_VENDORS } from "../types";
import { useImportContext } from "../import-context";
import { runBackgroundImportPipeline } from "../background-import";

export function SelectVendorsModule() {
  const { state, dispatch } = useImportContext();
  const { selectedVendors, customVendors, detectedOrders, guidedStep, emailConnection } = state;

  const [showCustomForm, setShowCustomForm] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customDomain, setCustomDomain] = React.useState("");
  const [discoveredSuppliers, setDiscoveredSuppliers] = React.useState<GmailDiscoveredSupplier[]>([]);
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  const [discoveryError, setDiscoveryError] = React.useState<string | null>(null);
  const customVendorIdsRef = React.useRef<Set<string>>(new Set());

  const allVendors = [...PRESET_VENDORS, ...customVendors];
  const vendorById = React.useMemo(
    () => new Map(allVendors.map((vendor) => [vendor.id, vendor])),
    [allVendors],
  );
  const inferredVendorIds = React.useMemo(
    () =>
      Array.from(
        new Set(
          detectedOrders
            .map((order) => order.vendorId)
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [detectedOrders],
  );
  const discoveredVendorIds = React.useMemo(
    () => discoveredSuppliers.map((supplier) => supplier.vendorId),
    [discoveredSuppliers],
  );
  const candidateVendorIds = React.useMemo(() => {
    const merged = Array.from(new Set([...discoveredVendorIds, ...inferredVendorIds]));
    return merged.filter((vendorId) => allVendors.some((vendor) => vendor.id === vendorId));
  }, [allVendors, discoveredVendorIds, inferredVendorIds]);

  const candidateSelectedCount = candidateVendorIds.filter((id) => selectedVendors.has(id)).length;
  const missingCandidateVendorIds = candidateVendorIds.filter((id) => !selectedVendors.has(id));
  const isGuidedVendorStep = guidedStep === "select-vendors";
  const canContinue = selectedVendors.size > 0 && !isDiscovering;
  const selectedVendorNames = React.useMemo(
    () =>
      Array.from(selectedVendors)
        .map((vendorId) => vendorById.get(vendorId)?.name || vendorId)
        .slice(0, 5),
    [selectedVendors, vendorById],
  );

  React.useEffect(() => {
    const linkedGmail =
      emailConnection?.status === "connected" && emailConnection.provider === "gmail";
    if (!linkedGmail) return;
    if (discoveredSuppliers.length > 0) return;
    if (isDiscovering) return;

    const session = readStoredSession();
    const accessToken = session?.tokens.accessToken;
    if (!accessToken) return;

    let cancelled = false;
    setIsDiscovering(true);
    setDiscoveryError(null);

    void discoverGmailSuppliers(accessToken, {
      maxResults: 220,
      lookbackDays: 180,
    })
      .then((result) => {
        if (cancelled) return;
        setDiscoveredSuppliers(result.suppliers);

        const existingVendorIds = new Set(
          [...PRESET_VENDORS.map((vendor) => vendor.id), ...customVendors.map((vendor) => vendor.id)],
        );

        for (const supplier of result.suppliers) {
          if (existingVendorIds.has(supplier.vendorId)) continue;
          if (customVendorIdsRef.current.has(supplier.vendorId)) continue;

          customVendorIdsRef.current.add(supplier.vendorId);
          existingVendorIds.add(supplier.vendorId);

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
      })
      .catch((error) => {
        if (cancelled) return;
        setDiscoveryError(parseApiError(error));
      })
      .finally(() => {
        if (!cancelled) {
          setIsDiscovering(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    customVendors,
    dispatch,
    discoveredSuppliers.length,
    emailConnection,
    isDiscovering,
  ]);

  const addCustom = () => {
    if (!customName.trim() || !customDomain.trim()) return;
    dispatch({
      type: "ADD_CUSTOM_VENDOR",
      vendor: {
        id: `custom-${Date.now()}`,
        name: customName.trim(),
        logo: "🏢",
        domain: customDomain.trim(),
        hasApi: false,
      },
    });
    setCustomName("");
    setCustomDomain("");
    setShowCustomForm(false);
  };

  const handleSelectAllDetected = () => {
    if (candidateVendorIds.length === 0) return;
    const merged = new Set([...selectedVendors, ...candidateVendorIds]);
    dispatch({ type: "SET_VENDORS", vendorIds: Array.from(merged) });
  };

  const handleContinue = () => {
    if (!canContinue) return;

    void runBackgroundImportPipeline(state, dispatch);

    if (isGuidedVendorStep) {
      dispatch({ type: "SET_GUIDED_STEP", step: "scan-upcs" });
      dispatch({ type: "OPEN_MODULE", module: "scan-upcs" });
      return;
    }

    dispatch({ type: "OPEN_MODULE", module: "scan-upcs" });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          Select Your Vendors
        </CardTitle>
        <CardDescription>
          We scan the last 6 months of email activity, prioritize Amazon and industrial
          distributors, then let you choose which suppliers to import from.
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
                onClick={() => dispatch({ type: "TOGGLE_VENDOR", vendorId: vendor.id })}
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

        {isDiscovering && (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Scanning inbox URLs and sender domains from the last 6 months to build supplier candidates...
          </div>
        )}

        {discoveryError && (
          <div className="rounded-xl border border-[hsl(var(--arda-error)/0.25)] bg-[hsl(var(--arda-error)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-error))]">
            Supplier discovery failed: {discoveryError}
          </div>
        )}

        {!isDiscovering && candidateVendorIds.length === 0 && !discoveryError && (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            No supplier domains were auto-detected yet. Select vendors manually or add a custom vendor domain.
          </div>
        )}

        {candidateVendorIds.length > 0 && (
          <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.07)] p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[hsl(var(--arda-blue))]">
                  Potential suppliers detected from inbox activity
                </p>
                <p className="text-xs text-muted-foreground">
                  {candidateSelectedCount} of {candidateVendorIds.length} detected supplier
                  {candidateVendorIds.length !== 1 ? "s" : ""} selected
                </p>
              </div>
              {missingCandidateVendorIds.length > 0 && (
                <Button size="sm" variant="accent" onClick={handleSelectAllDetected}>
                  Select detected
                </Button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {candidateVendorIds.map((vendorId) => {
                const vendor = vendorById.get(vendorId);
                const selected = selectedVendors.has(vendorId);

                return (
                  <Badge
                    key={vendorId}
                    variant={selected ? "success" : "outline"}
                    className="gap-1 rounded-full px-2 py-1 text-[11px]"
                  >
                    {vendor?.logo ?? "🏢"} {vendor?.name ?? vendorId}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        <div className="rounded-xl border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              <span className="font-semibold">{selectedVendors.size}</span> vendor
              {selectedVendors.size !== 1 ? "s" : ""} selected
            </p>
            {isDiscovering ? (
              <Badge variant="secondary">Scanning inbox…</Badge>
            ) : selectedVendors.size > 0 ? (
              <Badge variant="success">Ready to continue</Badge>
            ) : (
              <Badge variant="warning">Select one or more vendors</Badge>
            )}
          </div>

          {selectedVendors.size > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Selected: {selectedVendorNames.join(", ")}
              {selectedVendors.size > selectedVendorNames.length ? "…" : ""}
            </p>
          )}

          <Button
            className="mt-3 w-full"
            onClick={handleContinue}
            disabled={!canContinue}
          >
            {isGuidedVendorStep
              ? "Continue and start background analysis"
              : "Start background analysis"}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
