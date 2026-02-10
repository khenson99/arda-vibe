/**
 * Combined flow: Connect Email + Analyze Orders
 *
 * Renders both modules in a single dialog as collapsible sections,
 * so the user sees the full email-to-order-analysis flow at once.
 */

import * as React from "react";
import { CheckCircle2, ChevronDown, Mail, Search, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useImportContext } from "../import-context";
import { ConnectEmailModule } from "./connect-email-module";
import { AnalyzeOrdersModule } from "./analyze-orders-module";

export function EmailScanFlow() {
  const { state } = useImportContext();
  const isEmailConnected = state.emailConnection?.status === "connected";
  const hasOrders = state.detectedOrders.length > 0;

  // Auto-expand the section the user should focus on
  const [emailOpen, setEmailOpen] = React.useState(true);
  const [analyzeOpen, setAnalyzeOpen] = React.useState(false);

  // When email connects, collapse email section and expand analyze
  React.useEffect(() => {
    if (isEmailConnected) {
      setEmailOpen(false);
      setAnalyzeOpen(true);
    }
  }, [isEmailConnected]);

  const completedSteps = (isEmailConnected ? 1 : 0) + (hasOrders ? 1 : 0);
  const progress = (completedSteps / 2) * 100;
  const nextAction = !isEmailConnected
    ? "Link your purchasing inbox"
    : hasOrders
      ? "Review detected orders"
      : state.isAnalyzing
        ? "Analyzing inbox activity"
        : "Start your first order scan";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.28)] bg-[linear-gradient(135deg,hsl(var(--arda-blue)/0.1),hsl(var(--arda-orange)/0.08))] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Onboarding mission progress</p>
            <p className="text-xs text-muted-foreground">Next action: {nextAction}</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-[hsl(var(--arda-blue)/0.25)] bg-background/80 px-2 py-1 text-[11px] font-semibold text-[hsl(var(--arda-blue))]">
            <Sparkles className="h-3.5 w-3.5" />
            {completedSteps * 50} pts
          </span>
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/70">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <StepChip label="Link email" complete={isEmailConnected} />
          <StepChip label="Analyze orders" complete={hasOrders} active={!hasOrders && isEmailConnected} />
        </div>
      </div>

      {/* Section 1: Connect Email */}
      <CollapsibleSection
        title="Connect Email"
        icon={<Mail className="h-4 w-4" />}
        isOpen={emailOpen}
        onToggle={() => setEmailOpen((v) => !v)}
        badge={isEmailConnected ? "Connected" : undefined}
      >
        <ConnectEmailModule
          onConnected={() => {
            setEmailOpen(false);
            setAnalyzeOpen(true);
          }}
          onContinue={() => {
            setEmailOpen(false);
            setAnalyzeOpen(true);
          }}
        />
      </CollapsibleSection>

      {/* Section 2: Analyze Orders */}
      <CollapsibleSection
        title="Analyze Orders"
        icon={<Search className="h-4 w-4" />}
        isOpen={analyzeOpen}
        onToggle={() => setAnalyzeOpen((v) => !v)}
        badge={
          state.detectedOrders.length > 0
            ? `${state.detectedOrders.length} orders`
            : undefined
        }
      >
        <AnalyzeOrdersModule
          autoStartWhenReady={isEmailConnected}
          onAnalyzingStart={() => setAnalyzeOpen(true)}
        />
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

function StepChip({
  label,
  complete,
  active = false,
}: {
  label: string;
  complete: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        complete
          ? "border-[hsl(var(--arda-success)/0.4)] bg-[hsl(var(--arda-success)/0.1)] text-[hsl(var(--arda-success))]"
          : active
            ? "border-[hsl(var(--arda-blue)/0.35)] bg-[hsl(var(--arda-blue)/0.1)] text-[hsl(var(--arda-blue))]"
            : "border-border/70 bg-background/80 text-muted-foreground",
      )}
    >
      <CheckCircle2
        className={cn(
          "h-3.5 w-3.5",
          complete ? "opacity-100" : active ? "opacity-60" : "opacity-30",
        )}
      />
      <span className="font-medium">{label}</span>
    </div>
  );
}
