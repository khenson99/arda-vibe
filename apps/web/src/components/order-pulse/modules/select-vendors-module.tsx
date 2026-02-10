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
import { cn } from "@/lib/utils";
import { PRESET_VENDORS } from "../types";
import { useImportContext } from "../import-context";
import { runBackgroundImportPipeline } from "../background-import";

export function SelectVendorsModule() {
  const { state, dispatch } = useImportContext();
  const { selectedVendors, customVendors, detectedOrders, guidedStep } = state;

  const [showCustomForm, setShowCustomForm] = React.useState(false);
  const [customName, setCustomName] = React.useState("");
  const [customDomain, setCustomDomain] = React.useState("");

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
  const inferredSelectedCount = inferredVendorIds.filter((id) => selectedVendors.has(id)).length;
  const missingInferredVendorIds = inferredVendorIds.filter((id) => !selectedVendors.has(id));
  const isGuidedVendorStep = guidedStep === "select-vendors";
  const selectedVendorNames = React.useMemo(
    () =>
      Array.from(selectedVendors)
        .map((vendorId) => vendorById.get(vendorId)?.name || vendorId)
        .slice(0, 5),
    [selectedVendors, vendorById],
  );

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
    if (inferredVendorIds.length === 0) return;
    const merged = new Set([...selectedVendors, ...inferredVendorIds]);
    dispatch({ type: "SET_VENDORS", vendorIds: Array.from(merged) });
  };

  const handleContinue = () => {
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

        {inferredVendorIds.length > 0 && (
          <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.07)] p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[hsl(var(--arda-blue))]">
                  Suppliers detected from scanned emails
                </p>
                <p className="text-xs text-muted-foreground">
                  {inferredSelectedCount} of {inferredVendorIds.length} detected supplier
                  {inferredVendorIds.length !== 1 ? "s" : ""} selected
                </p>
              </div>
              {missingInferredVendorIds.length > 0 && (
                <Button size="sm" variant="accent" onClick={handleSelectAllDetected}>
                  Select detected
                </Button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {inferredVendorIds.map((vendorId) => {
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
            {selectedVendors.size > 0 ? (
              <Badge variant="success">Ready to continue</Badge>
            ) : (
              <Badge variant="warning">Smart discovery available</Badge>
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
          >
            {selectedVendors.size > 0
              ? isGuidedVendorStep
                ? "Continue and start background analysis"
                : "Start background analysis"
              : "Continue with smart discovery in background"}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
