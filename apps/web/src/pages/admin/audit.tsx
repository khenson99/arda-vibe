import * as React from "react";
import { Navigate } from "react-router-dom";
import {
  Shield,
  AlertTriangle,
  TrendingUp,
  Activity,
  BarChart3,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Download,
  ShieldCheck,
} from "lucide-react";
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
import { useAuditLogs, useAuditSummary, useAuditFilterOptions } from "@/hooks/use-audit";
import { useAuditExport, useIntegrityCheck } from "@/hooks/use-audit-export";
import { AuditEntryRow } from "@/components/audit/audit-entry-row";
import { AuditFilterBar } from "@/components/audit/audit-filter-bar";
import { ExportModal } from "@/components/audit/export-modal";
import { IntegrityCheckBanner } from "@/components/audit/integrity-check-banner";
import { formatActionLabel, formatEntityType } from "@/lib/audit-utils";
import type { AuthSession, AuditListFilters, AuditSummaryFilters } from "@/types";

/* ── Props ─────────────────────────────────────────────────── */

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

/* ── Tab type ──────────────────────────────────────────────── */

type AuditTab = "log" | "summary";

/* ── Component ─────────────────────────────────────────────── */

export function AuditRoute({ session, onUnauthorized }: Props) {
  // RBAC: only tenant_admin can access
  if (session.user.role !== "tenant_admin") {
    return <Navigate to="/" replace />;
  }

  return <AuditPage session={session} onUnauthorized={onUnauthorized} />;
}

function AuditPage({ session, onUnauthorized }: Props) {
  const token = session.tokens.accessToken;
  const [activeTab, setActiveTab] = React.useState<AuditTab>("log");

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Shield className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Audit Log</h1>
          <p className="text-xs text-muted-foreground">
            View and filter all audit trail entries across your workspace.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs>
        <TabsList>
          <TabsTrigger
            active={activeTab === "log"}
            onClick={() => setActiveTab("log")}
          >
            Log
          </TabsTrigger>
          <TabsTrigger
            active={activeTab === "summary"}
            onClick={() => setActiveTab("summary")}
          >
            Summary
          </TabsTrigger>
        </TabsList>

        {activeTab === "log" && (
          <TabsContent>
            <LogTab token={token} onUnauthorized={onUnauthorized} />
          </TabsContent>
        )}

        {activeTab === "summary" && (
          <TabsContent>
            <SummaryTab token={token} onUnauthorized={onUnauthorized} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

/* ── Log Tab ─────────────────────────────────────────────────── */

function LogTab({
  token,
  onUnauthorized,
}: {
  token: string;
  onUnauthorized: () => void;
}) {
  const [filters, setFilters] = React.useState<AuditListFilters>({
    page: 1,
    limit: 50,
  });
  const [exportOpen, setExportOpen] = React.useState(false);

  const { entries, pagination, loading, error, refresh } = useAuditLogs({
    token,
    filters,
    onUnauthorized,
  });

  const { actions, entityTypes, loading: optionsLoading } =
    useAuditFilterOptions(token, onUnauthorized);

  const exportHook = useAuditExport({ token, onUnauthorized });
  const integrityHook = useIntegrityCheck({ token, onUnauthorized });

  return (
    <div className="space-y-4">
      {/* Action buttons + filter bar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <AuditFilterBar
            filters={filters}
            onFiltersChange={setFilters}
            actions={actions}
            entityTypes={entityTypes}
            loading={optionsLoading}
          />
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExportOpen(true)}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={integrityHook.phase === "running"}
            onClick={integrityHook.run}
          >
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            Integrity Check
          </Button>
        </div>
      </div>

      {/* Integrity check banner */}
      <IntegrityCheckBanner
        phase={integrityHook.phase}
        result={integrityHook.result}
        error={integrityHook.error}
        onDismiss={integrityHook.dismiss}
      />

      {/* Export modal */}
      <ExportModal
        open={exportOpen}
        onOpenChange={setExportOpen}
        filters={filters}
        pagination={pagination}
        phase={exportHook.phase}
        progress={exportHook.progress}
        error={exportHook.error}
        onExport={exportHook.startExport}
        onReset={exportHook.reset}
      />

      {/* Results */}
      {error && (
        <Card className="rounded-xl">
          <CardContent className="py-6 text-center">
            <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
            <p className="text-sm text-red-600 mb-2">{error}</p>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {!error && loading && <LogSkeleton />}

      {!error && !loading && entries.length === 0 && (
        <Card className="rounded-xl">
          <CardContent className="py-12 text-center">
            <Activity className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No audit entries match your filters.
            </p>
          </CardContent>
        </Card>
      )}

      {!error && entries.length > 0 && (
        <>
          <Card className="rounded-xl overflow-hidden">
            {/* Table header */}
            <div className="flex items-center gap-3 px-4 py-2 text-xs font-medium text-muted-foreground bg-muted border-b border-border">
              <span className="w-4 shrink-0" />
              <span className="w-28 shrink-0">Time</span>
              <span className="w-32 shrink-0">Actor</span>
              <span className="w-48 shrink-0">Action</span>
              <span className="flex-1">Entity</span>
            </div>
            {entries.map((entry) => (
              <AuditEntryRow key={entry.id} entry={entry} />
            ))}
          </Card>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {(pagination.page - 1) * pagination.limit + 1}–
              {Math.min(pagination.page * pagination.limit, pagination.total)} of{" "}
              {pagination.total}
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page <= 1 || loading}
                onClick={() =>
                  setFilters((f: AuditListFilters) => ({ ...f, page: (f.page ?? 1) - 1 }))
                }
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pagination.page >= pagination.pages || loading}
                onClick={() =>
                  setFilters((f: AuditListFilters) => ({ ...f, page: (f.page ?? 1) + 1 }))
                }
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LogSkeleton() {
  return (
    <Card className="rounded-xl overflow-hidden">
      <div className="bg-muted border-b border-border px-4 py-2">
        <Skeleton className="h-4 w-full max-w-md rounded" />
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0"
        >
          <Skeleton className="h-4 w-4 rounded-sm" />
          <Skeleton className="h-4 w-24 rounded" />
          <Skeleton className="h-4 w-28 rounded" />
          <Skeleton className="h-4 w-40 rounded" />
          <Skeleton className="h-4 flex-1 rounded" />
        </div>
      ))}
    </Card>
  );
}

/* ── Summary Tab ─────────────────────────────────────────────── */

function SummaryTab({
  token,
  onUnauthorized,
}: {
  token: string;
  onUnauthorized: () => void;
}) {
  const [filters] = React.useState<AuditSummaryFilters>({
    granularity: "day",
  });

  const { summary, loading, error, refresh } = useAuditSummary({
    token,
    filters,
    onUnauthorized,
  });

  if (error) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-6 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-600 mb-2">{error}</p>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (loading || !summary) {
    return <SummarySkeleton />;
  }

  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={Activity}
          label="Total Events"
          value={summary.total.toLocaleString()}
        />
        <SummaryCard
          icon={BarChart3}
          label="Distinct Actions"
          value={String(summary.byAction.length)}
        />
        <SummaryCard
          icon={TrendingUp}
          label="Entity Types"
          value={String(summary.byEntityType.length)}
        />
      </div>

      {/* Top actions */}
      <Card className="rounded-xl">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3">Top Actions</h3>
          {summary.topActions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No actions recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {summary.topActions.map((a) => {
                const pct = summary.total > 0 ? (a.count / summary.total) * 100 : 0;
                return (
                  <div key={a.action} className="flex items-center gap-2">
                    <span className="w-48 text-sm truncate">
                      {formatActionLabel(a.action)}
                    </span>
                    <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-primary h-2 rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-16 text-right text-xs text-muted-foreground">
                      {a.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activity by entity type */}
      <Card className="rounded-xl">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3">By Entity Type</h3>
          {summary.byEntityType.length === 0 ? (
            <p className="text-xs text-muted-foreground">No data yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {summary.byEntityType.map((et) => (
                <div
                  key={et.entityType}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <span className="text-sm truncate">
                    {formatEntityType(et.entityType)}
                  </span>
                  <Badge variant="secondary">{et.count}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Anomaly alerts */}
      {summary.recentAnomalies.length > 0 && (
        <Card className="rounded-xl border-yellow-300 dark:border-yellow-700">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-4 w-4 text-yellow-600" />
              <h3 className="text-sm font-semibold">
                Anomaly Alerts (last 7 days)
              </h3>
            </div>
            <div className="space-y-2">
              {summary.recentAnomalies.map((anomaly) => (
                <div
                  key={anomaly.action}
                  className="flex items-center justify-between text-sm rounded-md bg-yellow-50 dark:bg-yellow-950/20 px-3 py-2"
                >
                  <span>{formatActionLabel(anomaly.action)}</span>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        anomaly.severity === "high" ? "destructive" : "warning"
                      }
                    >
                      {anomaly.severity}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {anomaly.previousCount} &rarr; {anomaly.currentCount}
                      {anomaly.percentChange != null && (
                        <> (+{anomaly.percentChange}%)</>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Status transition funnel */}
      {summary.statusTransitionFunnel.length > 0 && (
        <Card className="rounded-xl">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3">
              Status Transitions
            </h3>
            <div className="space-y-1.5">
              {summary.statusTransitionFunnel.map((s) => (
                <div
                  key={s.status}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="capitalize">
                    {s.status.replace(/_/g, " ")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {s.count}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <Card className="rounded-xl">
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-lg font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="rounded-xl">
            <CardContent className="flex items-center gap-3 p-4">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="space-y-1">
                <Skeleton className="h-3 w-20 rounded" />
                <Skeleton className="h-5 w-12 rounded" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="rounded-xl">
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-4 w-32 rounded" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full rounded" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
