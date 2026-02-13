import * as React from "react";
import { Download, FileText, FileJson, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Badge,
  Checkbox,
} from "@/components/ui";
import type { AuditExportFormat, AuditListFilters, AuditPagination } from "@/types";
import type { ExportPhase } from "@/hooks/use-audit-export";

/* ── Props ─────────────────────────────────────────────────── */

interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: AuditListFilters;
  pagination: AuditPagination;
  phase: ExportPhase;
  progress: number | null;
  error: string | null;
  onExport: (
    format: AuditExportFormat,
    filters: Omit<AuditListFilters, "page" | "limit">,
    includeArchived?: boolean,
  ) => void;
  onReset: () => void;
}

/* ── Helpers ───────────────────────────────────────────────── */

const FORMAT_OPTIONS: Array<{
  value: AuditExportFormat;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "csv", label: "CSV", icon: FileSpreadsheet },
  { value: "json", label: "JSON", icon: FileJson },
  { value: "pdf", label: "PDF", icon: FileText },
];

function buildFilterSummary(filters: AuditListFilters): string[] {
  const summary: string[] = [];
  if (filters.action) summary.push(`Action: ${filters.action}`);
  if (filters.entityType) summary.push(`Entity: ${filters.entityType}`);
  if (filters.dateFrom) summary.push(`From: ${new Date(filters.dateFrom).toLocaleDateString()}`);
  if (filters.dateTo) summary.push(`To: ${new Date(filters.dateTo).toLocaleDateString()}`);
  if (filters.search) summary.push(`Search: "${filters.search}"`);
  if (filters.actorName) summary.push(`Actor: ${filters.actorName}`);
  if (filters.entityName) summary.push(`Entity name: ${filters.entityName}`);
  return summary;
}

/* ── Component ─────────────────────────────────────────────── */

export function ExportModal({
  open,
  onOpenChange,
  filters,
  pagination,
  phase,
  progress,
  error,
  onExport,
  onReset,
}: ExportModalProps) {
  const [format, setFormat] = React.useState<AuditExportFormat>("csv");
  const [includeArchived, setIncludeArchived] = React.useState(false);

  const filterSummary = buildFilterSummary(filters);
  const isRunning = phase === "starting" || phase === "downloading" || phase === "polling";
  const isDone = phase === "completed";
  const isError = phase === "error";

  const handleExport = () => {
    const { page: _p, limit: _l, ...rest } = filters;
    onExport(format, rest, includeArchived);
  };

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen && isRunning) return; // prevent closing while running
    if (!nextOpen) {
      onReset();
      setFormat("csv");
      setIncludeArchived(false);
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" />
            Export Audit Log
          </DialogTitle>
          <DialogDescription>
            Download audit entries matching your current filters.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Format selector */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Format
            </p>
            <div className="flex gap-2">
              {FORMAT_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const selected = format === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={isRunning}
                    onClick={() => setFormat(opt.value)}
                    className={`
                      flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors
                      ${
                        selected
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border bg-background text-foreground hover:bg-muted"
                      }
                      disabled:opacity-50 disabled:cursor-not-allowed
                    `}
                  >
                    <Icon className="h-4 w-4" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Filter summary */}
          {filterSummary.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">
                Active Filters
              </p>
              <div className="flex flex-wrap gap-1">
                {filterSummary.map((item) => (
                  <Badge key={item} variant="secondary" className="text-xs">
                    {item}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Row estimate */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Estimated rows</span>
            <span className="font-medium">{pagination.total.toLocaleString()}</span>
          </div>

          {/* Include archived toggle */}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              disabled={isRunning}
            />
            <span>Include archived entries</span>
          </label>

          {/* Progress / status */}
          {isRunning && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {phase === "starting" && "Starting export..."}
                {phase === "polling" &&
                  `Processing${progress != null ? ` (${Math.round(progress)}%)` : ""}...`}
                {phase === "downloading" && "Downloading..."}
              </span>
            </div>
          )}

          {isDone && (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" />
              <span>Export downloaded successfully.</span>
            </div>
          )}

          {isError && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4" />
              <span>{error ?? "An unexpected error occurred."}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          {isDone || isError ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleClose(false)}
            >
              Close
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={isRunning}
                onClick={() => handleClose(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={isRunning}
                onClick={handleExport}
              >
                {isRunning ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    Export
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
