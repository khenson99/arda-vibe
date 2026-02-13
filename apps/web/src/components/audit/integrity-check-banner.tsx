import * as React from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Loader2,
  AlertCircle,
  X,
} from "lucide-react";
import { Button, Badge } from "@/components/ui";
import type { AuditIntegrityCheckResult } from "@/types";

/* ── Props ─────────────────────────────────────────────────── */

interface IntegrityCheckBannerProps {
  phase: "idle" | "running" | "done" | "error";
  result: AuditIntegrityCheckResult | null;
  error: string | null;
  onDismiss: () => void;
}

/* ── Component ─────────────────────────────────────────────── */

export function IntegrityCheckBanner({
  phase,
  result,
  error,
  onDismiss,
}: IntegrityCheckBannerProps) {
  if (phase === "idle") return null;

  /* Running state */
  if (phase === "running") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">
          Running integrity check...
        </span>
      </div>
    );
  }

  /* Error state */
  if (phase === "error") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/20 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error ?? "Integrity check failed."}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 h-7 w-7 p-0"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Dismiss</span>
        </Button>
      </div>
    );
  }

  /* Done — success */
  if (result?.valid) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/20 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          <span>
            Integrity check passed.{" "}
            <span className="font-medium">
              {result.totalChecked.toLocaleString()}
            </span>{" "}
            entries verified.
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 h-7 w-7 p-0"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Dismiss</span>
        </Button>
      </div>
    );
  }

  /* Done — violations found */
  if (result && !result.valid) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/20 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <div>
            <span>
              Integrity check failed.{" "}
              <span className="font-medium">
                {result.violationCount}
              </span>{" "}
              violation{result.violationCount !== 1 ? "s" : ""} detected
              out of{" "}
              <span className="font-medium">
                {result.totalChecked.toLocaleString()}
              </span>{" "}
              entries.
            </span>
            {result.firstInvalidEntry && (
              <span className="ml-1">
                First invalid entry:{" "}
                <Badge variant="destructive" className="text-xs font-mono">
                  {result.firstInvalidEntry}
                </Badge>
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 h-7 w-7 p-0"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Dismiss</span>
        </Button>
      </div>
    );
  }

  return null;
}
