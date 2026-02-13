import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { AuthSession, WOStatus, RoutingStepStatus, WorkOrderRoutingStep } from "@/types";
import { useWorkOrderDetail } from "@/hooks/use-work-order-detail";
import {
  Button,
  Card,
  CardContent,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Skeleton,
} from "@/components/ui";
import {
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  Play,
  Pause,
  CheckCircle2,
  XCircle,
  Clock,
  Hammer,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { parseApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { EntityActivitySection } from "@/components/audit/entity-activity-section";

/* ── Props ─────────────────────────────────────────────────── */

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

/* ── Status helpers ────────────────────────────────────────── */

const STATUS_BADGE: Record<WOStatus, { label: string; variant: "default" | "secondary" | "success" | "warning" | "accent" | "destructive" }> = {
  draft: { label: "Draft", variant: "secondary" },
  scheduled: { label: "Scheduled", variant: "accent" },
  in_progress: { label: "In Progress", variant: "warning" },
  on_hold: { label: "On Hold", variant: "destructive" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

const ROUTING_STATUS_BADGE: Record<RoutingStepStatus, { label: string; variant: "default" | "secondary" | "success" | "warning" | "accent" }> = {
  pending: { label: "Pending", variant: "secondary" },
  in_progress: { label: "In Progress", variant: "warning" },
  complete: { label: "Complete", variant: "success" },
  on_hold: { label: "On Hold", variant: "accent" },
  skipped: { label: "Skipped", variant: "secondary" },
};

/** Valid next statuses from current status */
const STATUS_TRANSITIONS: Record<WOStatus, WOStatus[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["on_hold", "completed", "cancelled"],
  on_hold: ["in_progress", "cancelled"],
  completed: [],
  cancelled: [],
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ── Tab type ──────────────────────────────────────────────── */

type DetailTab = "overview" | "routing" | "production" | "activity";

/* ── Skeleton ─────────────────────────────────────────────── */

function WODetailSkeleton() {
  return (
    <div className="space-y-4">
      <Card className="rounded-xl">
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-10 w-72" />
      <Card className="rounded-xl">
        <CardContent className="p-4 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Component ─────────────────────────────────────────────── */

export function WODetailRoute({ session, onUnauthorized }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = React.useState<DetailTab>("overview");

  const {
    wo,
    loading,
    error,
    statusUpdating,
    updateStatus,
    updateRoutingStep,
    reportProduction,
    refresh,
  } = useWorkOrderDetail({
    token: session.tokens.accessToken,
    woId: id ?? "",
    onUnauthorized,
  });

  const handleBack = React.useCallback(() => {
    navigate("/orders");
  }, [navigate]);

  const handleStatusChange = React.useCallback(
    async (status: WOStatus) => {
      try {
        const opts: Record<string, string> = {};
        if (status === "cancelled") opts.cancelReason = "Cancelled from WO detail page";
        if (status === "on_hold") opts.holdReason = "Paused from WO detail page";
        const ok = await updateStatus(status, opts);
        if (ok) {
          const label = STATUS_BADGE[status]?.label ?? status;
          toast.success(`Status updated to ${label}`);
        }
      } catch (err) {
        toast.error(parseApiError(err));
      }
    },
    [updateStatus],
  );

  const handleRoutingStepAction = React.useCallback(
    async (step: WorkOrderRoutingStep, nextStatus: RoutingStepStatus) => {
      try {
        const ok = await updateRoutingStep(step.id, { status: nextStatus });
        if (ok) {
          const label = ROUTING_STATUS_BADGE[nextStatus]?.label ?? nextStatus;
          toast.success(`Step "${step.operationName}" → ${label}`);
        }
      } catch (err) {
        toast.error(parseApiError(err));
      }
    },
    [updateRoutingStep],
  );

  /* Loading state */
  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <WODetailSkeleton />
      </div>
    );
  }

  /* Error state */
  if (error) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-400" />
            <p className="text-sm text-red-600 mb-3">{error}</p>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* No WO found */
  if (!wo) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Work order not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  const badge = STATUS_BADGE[wo.status] ?? { label: wo.status, variant: "secondary" as const };
  const nextStatuses = STATUS_TRANSITIONS[wo.status] ?? [];
  const progress = wo.quantityToProduce > 0
    ? Math.round((wo.quantityProduced / wo.quantityToProduce) * 100)
    : 0;

  return (
    <div className="space-y-4 p-4">
      {/* Back navigation */}
      <Button variant="ghost" size="sm" onClick={handleBack}>
        <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
      </Button>

      {/* Header card */}
      <Card className="rounded-xl">
        <CardContent className="p-4">
          {/* Title row */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h1 className="text-lg font-semibold">{wo.woNumber}</h1>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {wo.isExpedited && <Badge variant="destructive">Expedited</Badge>}
            {wo.isRework && <Badge variant="warning">Rework</Badge>}
            {wo.priority > 0 && (
              <span className="text-xs text-muted-foreground">Priority {wo.priority}</span>
            )}
          </div>

          {/* Part info */}
          {wo.partName && (
            <p className="text-sm text-muted-foreground mb-3">
              Part: <span className="font-semibold text-card-foreground">{wo.partName}</span>
            </p>
          )}

          {/* Metric cards row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
            <MetricCard label="To Produce" value={wo.quantityToProduce.toLocaleString()} />
            <MetricCard label="Produced" value={wo.quantityProduced.toLocaleString()} accent />
            <MetricCard label="Rejected" value={wo.quantityRejected.toLocaleString()} warn={wo.quantityRejected > 0} />
            <MetricCard label="Progress" value={`${progress}%`} accent={progress >= 100} />
          </div>

          {/* Progress bar */}
          <div className="h-2 rounded-full bg-muted overflow-hidden mb-4">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                progress >= 100 ? "bg-[hsl(var(--arda-success))]" : "bg-primary",
              )}
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm mb-4">
            <div className="name-value-pair">
              <span className="text-muted-foreground">Scheduled Start:</span>{" "}
              <span className="font-semibold">{formatDate(wo.scheduledStartDate)}</span>
            </div>
            <div className="name-value-pair">
              <span className="text-muted-foreground">Scheduled End:</span>{" "}
              <span className="font-semibold">{formatDate(wo.scheduledEndDate)}</span>
            </div>
            <div className="name-value-pair">
              <span className="text-muted-foreground">Actual Start:</span>{" "}
              <span className="font-semibold">{formatDate(wo.actualStartDate)}</span>
            </div>
            <div className="name-value-pair">
              <span className="text-muted-foreground">Actual End:</span>{" "}
              <span className="font-semibold">{formatDate(wo.actualEndDate)}</span>
            </div>
          </div>

          {/* Hold / cancel info */}
          {wo.holdReason && (
            <div className="rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3 mb-4 text-sm">
              <div className="flex items-center gap-1.5 font-semibold text-yellow-700 dark:text-yellow-400 mb-1">
                <AlertTriangle className="h-3.5 w-3.5" /> On Hold
              </div>
              <p className="text-yellow-600 dark:text-yellow-300">{wo.holdReason}</p>
              {wo.holdNotes && <p className="text-yellow-600/80 dark:text-yellow-300/80 mt-1">{wo.holdNotes}</p>}
            </div>
          )}
          {wo.cancelReason && (
            <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 mb-4 text-sm">
              <div className="flex items-center gap-1.5 font-semibold text-red-700 dark:text-red-400 mb-1">
                <XCircle className="h-3.5 w-3.5" /> Cancelled
              </div>
              <p className="text-red-600 dark:text-red-300">{wo.cancelReason}</p>
            </div>
          )}

          {/* Notes */}
          {wo.notes && (
            <p className="text-sm text-muted-foreground mb-4">{wo.notes}</p>
          )}

          {/* Action buttons */}
          {nextStatuses.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {nextStatuses.map((s) => (
                <StatusActionButton
                  key={s}
                  status={s}
                  onClick={() => handleStatusChange(s)}
                  disabled={statusUpdating}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs>
        <TabsList>
          <TabsTrigger active={activeTab === "overview"} onClick={() => setActiveTab("overview")}>
            Overview
          </TabsTrigger>
          <TabsTrigger active={activeTab === "routing"} onClick={() => setActiveTab("routing")}>
            Routing{wo.routingSteps?.length ? ` (${wo.routingSteps.length})` : ""}
          </TabsTrigger>
          <TabsTrigger active={activeTab === "production"} onClick={() => setActiveTab("production")}>
            Production
          </TabsTrigger>
          <TabsTrigger active={activeTab === "activity"} onClick={() => setActiveTab("activity")}>
            Activity
          </TabsTrigger>
        </TabsList>

        {activeTab === "overview" && (
          <TabsContent>
            <OverviewTab wo={wo} />
          </TabsContent>
        )}

        {activeTab === "routing" && (
          <TabsContent>
            <RoutingTab
              steps={wo.routingSteps ?? []}
              woStatus={wo.status}
              onStepAction={handleRoutingStepAction}
            />
          </TabsContent>
        )}

        {activeTab === "production" && (
          <TabsContent>
            <ProductionTab
              wo={wo}
              onReport={reportProduction}
            />
          </TabsContent>
        )}

        {activeTab === "activity" && (
          <TabsContent>
            <EntityActivitySection
              token={session.tokens.accessToken}
              entityType="work_order"
              entityId={id ?? ""}
              onUnauthorized={onUnauthorized}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────── */

function MetricCard({ label, value, accent, warn }: { label: string; value: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center">
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className={cn(
        "text-lg font-semibold",
        accent && "text-[hsl(var(--arda-success))]",
        warn && "text-red-500",
      )}>{value}</p>
    </div>
  );
}

function StatusActionButton({ status, onClick, disabled }: { status: WOStatus; onClick: () => void; disabled: boolean }) {
  const config: Record<string, { label: string; icon: React.ReactNode; variant: "default" | "outline" | "destructive" }> = {
    scheduled: { label: "Schedule", icon: <Clock className="mr-1.5 h-3.5 w-3.5" />, variant: "outline" },
    in_progress: { label: "Start", icon: <Play className="mr-1.5 h-3.5 w-3.5" />, variant: "default" },
    on_hold: { label: "Hold", icon: <Pause className="mr-1.5 h-3.5 w-3.5" />, variant: "outline" },
    completed: { label: "Complete", icon: <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />, variant: "default" },
    cancelled: { label: "Cancel", icon: <XCircle className="mr-1.5 h-3.5 w-3.5" />, variant: "destructive" },
  };
  const c = config[status] ?? { label: status, icon: null, variant: "outline" as const };
  return (
    <Button size="sm" variant={c.variant} onClick={onClick} disabled={disabled}>
      {c.icon}{c.label}
    </Button>
  );
}

/* ── Overview Tab ──────────────────────────────────────────── */

function OverviewTab({ wo }: { wo: NonNullable<ReturnType<typeof useWorkOrderDetail>["wo"]> }) {
  return (
    <Card className="rounded-xl">
      <CardContent className="p-4 space-y-3 text-sm">
        <h3 className="font-semibold text-base">Details</h3>
        <div className="grid grid-cols-1 gap-y-2 gap-x-8 sm:grid-cols-2">
          <NameValue label="WO Number" value={wo.woNumber} />
          <NameValue label="Status" value={STATUS_BADGE[wo.status]?.label ?? wo.status} />
          <NameValue label="Part" value={wo.partName ?? wo.partId} />
          <NameValue label="Facility" value={wo.facilityId} />
          <NameValue label="Priority" value={String(wo.priority)} />
          <NameValue label="Expedited" value={wo.isExpedited ? "Yes" : "No"} />
          <NameValue label="Rework" value={wo.isRework ? "Yes" : "No"} />
          <NameValue label="Created" value={formatDateTime(wo.createdAt)} />
          <NameValue label="Updated" value={formatDateTime(wo.updatedAt)} />
          {wo.kanbanCardId && <NameValue label="Kanban Card" value={wo.kanbanCardId} />}
          {wo.parentWorkOrderId && <NameValue label="Parent WO" value={wo.parentWorkOrderId} />}
        </div>
      </CardContent>
    </Card>
  );
}

function NameValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="name-value-pair">
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className="font-semibold text-card-foreground">{value}</span>
    </div>
  );
}

/* ── Routing Tab ──────────────────────────────────────────── */

function RoutingTab({
  steps,
  woStatus,
  onStepAction,
}: {
  steps: WorkOrderRoutingStep[];
  woStatus: WOStatus;
  onStepAction: (step: WorkOrderRoutingStep, nextStatus: RoutingStepStatus) => void;
}) {
  if (steps.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No routing steps defined for this work order.
        </CardContent>
      </Card>
    );
  }

  const sorted = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);
  const isWoActive = woStatus === "in_progress";

  return (
    <Card className="rounded-xl">
      <CardContent className="p-4">
        <div className="space-y-0">
          {sorted.map((step, idx) => {
            const badge = ROUTING_STATUS_BADGE[step.status] ?? { label: step.status, variant: "secondary" as const };
            const isLast = idx === sorted.length - 1;

            return (
              <div key={step.id} className="flex gap-3">
                {/* Timeline connector */}
                <div className="flex flex-col items-center">
                  <div className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold",
                    step.status === "complete" && "border-[hsl(var(--arda-success))] bg-[hsl(var(--arda-success))] text-white",
                    step.status === "in_progress" && "border-primary bg-primary text-white",
                    step.status === "pending" && "border-border bg-card text-muted-foreground",
                    step.status === "skipped" && "border-border bg-muted text-muted-foreground",
                    step.status === "on_hold" && "border-yellow-400 bg-yellow-100 text-yellow-700",
                  )}>
                    {step.status === "complete" ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      step.stepNumber
                    )}
                  </div>
                  {!isLast && (
                    <div className={cn(
                      "w-0.5 flex-1 min-h-[24px]",
                      step.status === "complete" ? "bg-[hsl(var(--arda-success))]" : "bg-border",
                    )} />
                  )}
                </div>

                {/* Step content */}
                <div className={cn("flex-1 pb-4", isLast && "pb-0")}>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-semibold text-sm">{step.operationName}</span>
                    <Badge variant={badge.variant} className="text-[10px] px-1.5 py-0">
                      {badge.label}
                    </Badge>
                  </div>

                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {step.estimatedMinutes != null && (
                      <p>Est: {step.estimatedMinutes} min{step.actualMinutes != null ? ` · Actual: ${step.actualMinutes} min` : ""}</p>
                    )}
                    {step.startedAt && <p>Started: {formatDateTime(step.startedAt)}</p>}
                    {step.completedAt && <p>Completed: {formatDateTime(step.completedAt)}</p>}
                    {step.notes && <p className="italic">{step.notes}</p>}
                  </div>

                  {/* Step actions */}
                  {isWoActive && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {step.status === "pending" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onStepAction(step, "in_progress")}>
                          <Play className="mr-1 h-3 w-3" /> Start
                        </Button>
                      )}
                      {step.status === "in_progress" && (
                        <>
                          <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => onStepAction(step, "complete")}>
                            <CheckCircle2 className="mr-1 h-3 w-3" /> Complete
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onStepAction(step, "on_hold")}>
                            <Pause className="mr-1 h-3 w-3" /> Hold
                          </Button>
                        </>
                      )}
                      {step.status === "on_hold" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onStepAction(step, "in_progress")}>
                          <Play className="mr-1 h-3 w-3" /> Resume
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Production Tab ───────────────────────────────────────── */

function ProductionTab({
  wo,
  onReport,
}: {
  wo: NonNullable<ReturnType<typeof useWorkOrderDetail>["wo"]>;
  onReport: (input: { quantityProduced: number; quantityRejected?: number }) => Promise<boolean>;
}) {
  const [produced, setProduced] = React.useState("");
  const [rejected, setRejected] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const canReport = wo.status === "in_progress";

  const handleSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const qty = parseInt(produced, 10);
      if (!qty || qty <= 0) {
        toast.error("Quantity produced must be greater than 0");
        return;
      }
      setSubmitting(true);
      try {
        const rej = parseInt(rejected, 10);
        const ok = await onReport({
          quantityProduced: qty,
          quantityRejected: rej > 0 ? rej : undefined,
        });
        if (ok) {
          toast.success(`Reported ${qty} produced`);
          setProduced("");
          setRejected("");
        }
      } catch (err) {
        toast.error(parseApiError(err));
      } finally {
        setSubmitting(false);
      }
    },
    [produced, rejected, onReport],
  );

  return (
    <div className="space-y-4">
      {/* Production summary */}
      <Card className="rounded-xl">
        <CardContent className="p-4">
          <h3 className="font-semibold text-base mb-3">Production Summary</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard label="Target" value={wo.quantityToProduce.toLocaleString()} />
            <MetricCard label="Produced" value={wo.quantityProduced.toLocaleString()} accent />
            <MetricCard label="Rejected" value={wo.quantityRejected.toLocaleString()} warn={wo.quantityRejected > 0} />
            <MetricCard label="Scrapped" value={wo.quantityScrapped.toLocaleString()} warn={wo.quantityScrapped > 0} />
          </div>
        </CardContent>
      </Card>

      {/* Report production form */}
      {canReport && (
        <Card className="rounded-xl">
          <CardContent className="p-4">
            <h3 className="font-semibold text-base mb-3">
              <Hammer className="inline-block mr-1.5 h-4 w-4" />
              Report Production
            </h3>
            <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Qty Produced *</label>
                <input
                  type="number"
                  min={1}
                  value={produced}
                  onChange={(e) => setProduced(e.target.value)}
                  className="h-9 w-28 rounded-md border border-border bg-background px-3 text-sm"
                  placeholder="0"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Qty Rejected</label>
                <input
                  type="number"
                  min={0}
                  value={rejected}
                  onChange={(e) => setRejected(e.target.value)}
                  className="h-9 w-28 rounded-md border border-border bg-background px-3 text-sm"
                  placeholder="0"
                />
              </div>
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}
                Submit
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
