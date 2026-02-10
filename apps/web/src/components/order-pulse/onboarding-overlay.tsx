/**
 * Onboarding Overlay — shown on Dashboard when the tenant has zero parts.
 *
 * Semi-transparent backdrop with a centered welcome card offering:
 *  - "Get Started" button → opens guided sequential flow through all modules
 *  - Quick-launch shortcut buttons for the top 3 import methods
 *  - "Skip for now" text link → persists dismissal to localStorage
 *
 * Auto-dismisses when partCount > 0. If the user dismisses manually but
 * partCount drops back to 0, the dismissed flag is cleared.
 */

import * as React from "react";
import { Link2, Mail, Package, Rocket, Sparkles } from "lucide-react";

import { Button, Card, CardContent } from "@/components/ui";
import type { ImportModuleId } from "./types";
import { ONBOARDING_STEPS } from "./types";
import { useImportContext } from "./import-context";

const STORAGE_KEY = "arda.onboarding.dismissed";

interface OnboardingOverlayProps {
  tenantName: string;
  partCount: number;
}

export function OnboardingOverlay({ tenantName, partCount }: OnboardingOverlayProps) {
  const { dispatch } = useImportContext();
  const [dismissed, setDismissed] = React.useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  // Auto-dismiss when the tenant has parts
  React.useEffect(() => {
    if (partCount > 0) {
      setDismissed(true);
      try {
        localStorage.setItem(STORAGE_KEY, "true");
      } catch {
        // localStorage may be unavailable
      }
    }
  }, [partCount]);

  // Reset dismissed flag if partCount drops to 0 (e.g. all items deleted)
  React.useEffect(() => {
    if (partCount === 0) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // localStorage may be unavailable
      }
      setDismissed(false);
    }
  }, [partCount]);

  // Don't render if dismissed or if there are parts
  if (dismissed || partCount > 0) return null;

  const handleGetStarted = () => {
    // Start guided flow from the first step
    dispatch({ type: "SET_GUIDED_STEP", step: ONBOARDING_STEPS[0] });
    dispatch({ type: "OPEN_MODULE", module: ONBOARDING_STEPS[0] as ImportModuleId });
  };

  const handleQuickLaunch = (moduleId: ImportModuleId) => {
    dispatch({ type: "OPEN_MODULE", module: moduleId });
  };

  const handleSkip = () => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // localStorage may be unavailable
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="mx-4 w-full max-w-lg shadow-lg">
        <CardContent className="space-y-6 p-8">
          {/* Welcome header */}
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[hsl(var(--arda-orange))] to-[hsl(var(--arda-orange-hover))] shadow-lg">
              <Rocket className="h-8 w-8 text-white" />
            </div>
            <h2 className="text-2xl font-bold">Welcome to Arda</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {tenantName} doesn&apos;t have any products yet. Let&apos;s get your
              catalog set up — it only takes a few minutes.
            </p>
          </div>

          {/* Get Started — primary action */}
          <Button
            className="w-full"
            size="lg"
            onClick={handleGetStarted}
          >
            <Sparkles className="h-4 w-4" />
            Get Started — Guided Setup
          </Button>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or jump to</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* Quick-launch shortcuts for top 3 import methods */}
          <div className="grid gap-2">
            <QuickLaunchButton
              icon={Mail}
              label="Connect Email & Scan Orders"
              description="Import from purchase order emails"
              onClick={() => handleQuickLaunch("email-scan")}
            />
            <QuickLaunchButton
              icon={Link2}
              label="Import Product Links"
              description="Paste URLs and scrape product details"
              onClick={() => handleQuickLaunch("import-links")}
            />
            <QuickLaunchButton
              icon={Package}
              label="Vendor Product Search"
              description="Browse and enrich from vendor catalogs"
              onClick={() => handleQuickLaunch("vendor-discovery")}
            />
          </div>

          {/* Skip */}
          <div className="text-center">
            <button
              type="button"
              onClick={handleSkip}
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Skip for now
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Quick Launch Button                                                */
/* ------------------------------------------------------------------ */

function QuickLaunchButton({
  icon: Icon,
  label,
  description,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--arda-blue)/0.1)]">
        <Icon className="h-4 w-4 text-[hsl(var(--arda-blue))]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}
