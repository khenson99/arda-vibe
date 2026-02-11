import type { PurchaseOrder, POStatus, Receipt } from "@/types";
import { PO_STATUS_META } from "@/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Skeleton,
} from "@/components/ui";
import { CheckCircle2, CircleDot, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

/* ── Helpers ───────────────────────────────────────────────── */

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ── Status ordering ───────────────────────────────────────── */

const STATUS_PROGRESSION: POStatus[] = [
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "acknowledged",
  "partially_received",
  "received",
  "closed",
];

/* ── Props ─────────────────────────────────────────────────── */

interface POTimelineProps {
  po: PurchaseOrder;
}

/* ── Component ─────────────────────────────────────────────── */

export function POTimeline({ po }: POTimelineProps) {
  const currentIdx = STATUS_PROGRESSION.indexOf(po.status);
  const isCancelled = po.status === "cancelled";

  type TimelineStep = {
    status: string;
    label: string;
    date: string | null;
    state: "completed" | "active" | "pending";
  };

  const steps: TimelineStep[] = [];

  steps.push({
    status: "created",
    label: "Created",
    date: po.createdAt,
    state: "completed",
  });

  if (isCancelled) {
    steps.push({
      status: "cancelled",
      label: "Cancelled",
      date: po.updatedAt,
      state: "active",
    });
  } else {
    for (let i = 0; i < STATUS_PROGRESSION.length; i++) {
      const status = STATUS_PROGRESSION[i];
      if (status === "draft") continue;

      const meta = PO_STATUS_META[status];
      let state: TimelineStep["state"] = "pending";

      if (i <= currentIdx) {
        state = i === currentIdx ? "active" : "completed";
      }

      // Only show steps up to 2 beyond current
      if (i > currentIdx + 2) break;

      steps.push({
        status,
        label: meta.label,
        date: state !== "pending" ? po.updatedAt : null,
        state,
      });
    }
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-0">
          {steps.map((step, i) => (
            <div
              key={step.status + i}
              className="flex items-start gap-3 pb-3 last:pb-0"
            >
              <div className="flex flex-col items-center">
                {step.state === "completed" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                ) : step.state === "active" ? (
                  <CircleDot
                    className={cn(
                      "h-4 w-4 shrink-0",
                      step.status === "cancelled"
                        ? "text-red-500"
                        : "text-[hsl(var(--link))]",
                    )}
                  />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground/30 shrink-0" />
                )}
                {i < steps.length - 1 && (
                  <div className="w-px h-4 bg-border mt-0.5" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    "text-xs font-medium leading-4",
                    step.state === "active" || step.state === "completed"
                      ? "text-foreground"
                      : "text-muted-foreground/50",
                  )}
                >
                  {step.label}
                </p>
                {step.date && (
                  <p className="text-[10px] text-muted-foreground">
                    {formatDateTime(step.date)}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Receiving section ──────────────────────────────────────── */

interface POReceivingProps {
  receipts: Receipt[];
  loading: boolean;
}

export function POReceiving({ receipts, loading }: POReceivingProps) {
  if (loading) {
    return (
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Receiving History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (receipts.length === 0) {
    return (
      <Card className="rounded-xl shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Receiving History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground py-4 text-center">
            No receipts recorded yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Receiving History ({receipts.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {receipts.map((receipt) => (
          <div
            key={receipt.id}
            className="rounded-lg border border-border px-3 py-2 text-xs space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">
                Receipt #{receipt.id.slice(0, 8)}
              </span>
              <Badge
                variant={
                  receipt.status === "completed"
                    ? "default"
                    : receipt.status === "rejected"
                      ? "destructive"
                      : "secondary"
                }
                className="text-[10px]"
              >
                {receipt.status}
              </Badge>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <span>Received: {formatDateTime(receipt.receivedAt)}</span>
              {receipt.receivedBy && <span>By: {receipt.receivedBy}</span>}
            </div>
            {receipt.notes && (
              <p className="text-muted-foreground">{receipt.notes}</p>
            )}
            {receipt.lines && receipt.lines.length > 0 && (
              <div className="mt-1 pl-2 border-l-2 border-border space-y-0.5">
                {receipt.lines.map((line) => (
                  <div key={line.id} className="flex items-center gap-2">
                    <span>{line.partName ?? line.partId}</span>
                    <span className="text-emerald-600">
                      +{line.quantityAccepted}
                    </span>
                    {line.quantityDamaged > 0 && (
                      <span className="text-amber-600">
                        dmg: {line.quantityDamaged}
                      </span>
                    )}
                    {line.quantityRejected > 0 && (
                      <span className="text-red-600">
                        rej: {line.quantityRejected}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function POTimelineSkeleton() {
  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="pb-2">
        <Skeleton className="h-5 w-20" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="h-4 w-4 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2 w-32" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
