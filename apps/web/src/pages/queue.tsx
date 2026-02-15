import * as React from "react";
import { Loader2, Play, RefreshCw, Tag } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/error-banner";
import {
  VendorOrderConfigDialog,
  VendorOrderExecutionPanel,
  buildVendorQueueGroups,
  procurementOrderMethodLabel,
  type VendorExecutionSession,
  type VendorQueueGroup,
} from "@/components/procurement";
import { Badge, Button, Skeleton } from "@/components/ui";
import { useWorkspaceData } from "@/hooks/use-workspace-data";
import type { AppShellOutletContext, HeaderOption } from "@/layouts/app-shell";
import type { ProcurementOrderMethod } from "@/types";
import {
  createProcurementDrafts,
  parseApiError,
  sendPurchaseOrderEmailDraft,
  verifyProcurementDrafts,
} from "@/lib/api-client";
import type { AuthSession } from "@/types";

type QueueScope = "all" | "ready" | "draft";
type QueueSort = "vendor" | "oldest" | "lines";

const QUEUE_SCOPE_OPTIONS: HeaderOption[] = [
  { value: "all", label: "All vendors" },
  { value: "ready", label: "Ready to run" },
  { value: "draft", label: "Drafts only" },
];

const QUEUE_SORT_OPTIONS: HeaderOption[] = [
  { value: "vendor", label: "Vendor" },
  { value: "oldest", label: "Oldest card" },
  { value: "lines", label: "Most lines" },
];

function groupMatchesScope(group: VendorQueueGroup, scope: QueueScope) {
  if (scope === "draft") return group.draftPurchaseOrderIds.length > 0;
  if (scope === "ready") return group.draftPurchaseOrderIds.length === 0;
  return true;
}

function groupMatchesMethod(group: VendorQueueGroup, method: string | null) {
  if (!method) return true;
  return group.lines.some((line) => line.orderMethod === method);
}

function groupMatchesSearch(group: VendorQueueGroup, search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return true;

  if (group.supplierName.toLowerCase().includes(query)) return true;
  return group.lines.some((line) => {
    return (
      line.partName.toLowerCase().includes(query) ||
      String(line.card.cardNumber).includes(query) ||
      line.card.id.toLowerCase().includes(query)
    );
  });
}

function mapGroupToExecutionSession(group: VendorQueueGroup, poIds: string[]): VendorExecutionSession {
  const methods = Array.from(new Set(group.lines.map((line) => line.orderMethod).filter(Boolean))) as VendorExecutionSession["methods"];

  return {
    supplierId: group.supplierId ?? "",
    supplierName: group.supplierName,
    recipientEmail: group.supplierRecipientEmail ?? group.supplierContactEmail,
    poIds,
    cardIds: group.lines.map((line) => line.card.id),
    methods,
    lines: group.lines
      .filter((line): line is typeof line & { orderMethod: NonNullable<typeof line.orderMethod> } => !!line.orderMethod)
      .map((line) => ({
        cardId: line.card.id,
        partName: line.partName,
        orderMethod: line.orderMethod,
        sourceUrl: line.part?.primarySupplierLink ?? null,
      })),
  };
}

export function QueueRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const { setQueueHeaderControls } = useOutletContext<AppShellOutletContext>();
  const { isLoading, isRefreshing, error, queueByLoop, parts, refreshQueueOnly } = useWorkspaceData(
    session.tokens.accessToken,
    onUnauthorized,
  );

  const [scope, setScope] = React.useState<QueueScope>("all");
  const [searchTerm, setSearchTerm] = React.useState("");
  const [sortKey, setSortKey] = React.useState<QueueSort>("vendor");
  const [methodFilter, setMethodFilter] = React.useState<string | null>(null);
  const [activeConfigGroup, setActiveConfigGroup] = React.useState<VendorQueueGroup | null>(null);
  const [executionSession, setExecutionSession] = React.useState<VendorExecutionSession | null>(null);
  const [isCreatingDrafts, setIsCreatingDrafts] = React.useState(false);
  const [isVerifying, setIsVerifying] = React.useState(false);
  const [isSendingEmail, setIsSendingEmail] = React.useState(false);

  React.useEffect(() => {
    setQueueHeaderControls({
      query: searchTerm,
      onQueryChange: setSearchTerm,
      queryPlaceholder: "Search vendor, part, card",
      scope,
      onScopeChange: (next) => setScope(next as QueueScope),
      scopeOptions: QUEUE_SCOPE_OPTIONS,
      sortKey,
      onSortKeyChange: (next) => setSortKey(next as QueueSort),
      sortOptions: QUEUE_SORT_OPTIONS,
    });

    return () => setQueueHeaderControls(null);
  }, [scope, searchTerm, setQueueHeaderControls, sortKey]);

  const allGroups = React.useMemo(
    () =>
      buildVendorQueueGroups({
      cards: queueByLoop.procurement,
      parts,
      }),
    [parts, queueByLoop.procurement],
  );

  const uniqueMethods = React.useMemo(() => {
    const methodCounts = new Map<string, number>();
    for (const group of allGroups) {
      for (const line of group.lines) {
        if (line.orderMethod) {
          methodCounts.set(line.orderMethod, (methodCounts.get(line.orderMethod) ?? 0) + 1);
        }
      }
    }
    return Array.from(methodCounts.entries()).sort((a, b) => b[1] - a[1]);
  }, [allGroups]);

  const groups = React.useMemo(() => {
    const filtered = allGroups
      .filter((group) => groupMatchesScope(group, scope))
      .filter((group) => groupMatchesSearch(group, searchTerm))
      .filter((group) => groupMatchesMethod(group, methodFilter));

    filtered.sort((a, b) => {
      if (sortKey === "vendor") {
        return a.supplierName.localeCompare(b.supplierName);
      }
      if (sortKey === "lines") {
        return b.lines.length - a.lines.length;
      }
      const aOldest = Math.min(...a.lines.map((line) => new Date(line.card.currentStageEnteredAt).getTime()));
      const bOldest = Math.min(...b.lines.map((line) => new Date(line.card.currentStageEnteredAt).getTime()));
      return aOldest - bOldest;
    });

    return filtered;
  }, [allGroups, methodFilter, scope, searchTerm, sortKey]);

  const unknownMethodLineCount = React.useMemo(
    () =>
      allGroups.reduce(
        (count, group) => count + group.lines.filter((line) => line.orderMethod === null).length,
        0,
      ),
    [allGroups],
  );

  const handleCreateDrafts = React.useCallback(
    async (payload: Parameters<typeof createProcurementDrafts>[1]) => {
      if (!activeConfigGroup) return;

      setIsCreatingDrafts(true);
      try {
        const result = await createProcurementDrafts(session.tokens.accessToken, payload);

        const methods = Array.from(new Set(payload.lines.map((line) => line.orderMethod)));
        const linesByCardId = new Map(activeConfigGroup.lines.map((line) => [line.card.id, line]));

        setExecutionSession({
          supplierId: payload.supplierId,
          supplierName: activeConfigGroup.supplierName,
          recipientEmail: result.recipientEmail,
          poIds: result.drafts.map((draft) => draft.poId),
          cardIds: payload.lines.map((line) => line.cardId),
          methods,
          lines: payload.lines.map((line) => ({
            cardId: line.cardId,
            orderMethod: line.orderMethod,
            sourceUrl: line.sourceUrl ?? null,
            partName: linesByCardId.get(line.cardId)?.partName ?? line.cardId,
          })),
        });

        setActiveConfigGroup(null);
        await refreshQueueOnly();
        toast.success(`Created ${result.totalDrafts} draft purchase order(s)`);
      } catch (error) {
        toast.error(parseApiError(error));
      } finally {
        setIsCreatingDrafts(false);
      }
    },
    [activeConfigGroup, refreshQueueOnly, session.tokens.accessToken],
  );

  const handleSendEmail = React.useCallback(
    async (
      method: "email" | "purchase_order" | "rfq",
      input: {
        to: string;
        cc: string[];
        subject: string;
        bodyText: string;
        includeAttachment: boolean;
      },
    ) => {
      if (!executionSession) return;

      setIsSendingEmail(true);
      try {
        await Promise.all(
          executionSession.poIds.map((poId) =>
            sendPurchaseOrderEmailDraft(session.tokens.accessToken, poId, {
              to: input.to,
              cc: input.cc,
              subject: input.subject,
              bodyText: input.bodyText,
              includeAttachment: method === "purchase_order",
            }),
          ),
        );
        toast.success(`Sent ${procurementOrderMethodLabel(method)} email draft(s)`);
      } catch (error) {
        toast.error(parseApiError(error));
        throw error;
      } finally {
        setIsSendingEmail(false);
      }
    },
    [executionSession, session.tokens.accessToken],
  );

  const handleVerify = React.useCallback(
    async (input: { poIds: string[]; cardIds: string[] }) => {
      setIsVerifying(true);
      try {
        await verifyProcurementDrafts(session.tokens.accessToken, input);
        toast.success("Order verification complete");
        setExecutionSession(null);
        await refreshQueueOnly();
      } catch (error) {
        toast.error(parseApiError(error));
      } finally {
        setIsVerifying(false);
      }
    },
    [refreshQueueOnly, session.tokens.accessToken],
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onRetry={refreshQueueOnly} />}

      <div className="rounded-xl border bg-card px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Procurement Vendor Queue</h2>
            <p className="text-sm text-muted-foreground">
              Triggered procurement cards grouped by vendor with verify-to-send workflow.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refreshQueueOnly()}>
            {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {executionSession && (
        <VendorOrderExecutionPanel
          session={executionSession}
          isVerifying={isVerifying || isSendingEmail}
          onClose={() => setExecutionSession(null)}
          onVerify={handleVerify}
          onSendEmail={handleSendEmail}
        />
      )}

      {unknownMethodLineCount > 0 && (
        <div className="rounded-xl border border-[hsl(var(--arda-warning)/0.35)] bg-[hsl(var(--arda-warning-light))] px-4 py-3 text-sm text-[hsl(var(--arda-warning))]">
          {unknownMethodLineCount} queued line{unknownMethodLineCount === 1 ? "" : "s"} still has an unsupported legacy order method. Update the item order method to continue vendor automation.
        </div>
      )}

      {uniqueMethods.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Tag className="h-3 w-3" />
            Method:
          </span>
          <button
            type="button"
            onClick={() => setMethodFilter(null)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              methodFilter === null
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-foreground hover:bg-muted"
            }`}
          >
            All
          </button>
          {uniqueMethods.map(([method, count]) => (
            <button
              key={method}
              type="button"
              onClick={() => setMethodFilter(methodFilter === method ? null : method)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                methodFilter === method
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-foreground hover:bg-muted"
              }`}
            >
              {procurementOrderMethodLabel(method as ProcurementOrderMethod)}
              <span className="rounded-full bg-black/10 px-1.5 text-[10px]">{count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {groups.length === 0 && (
          <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            No triggered procurement cards match this filter.
          </div>
        )}

        {groups.map((group) => (
          <section key={group.supplierId ?? group.supplierName} className="rounded-xl border bg-card p-4">
            <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">{group.supplierName}</h3>
                <p className="text-xs text-muted-foreground">
                  {group.lines.length} line(s) • {Object.keys(group.facilityCounts).length} facility(ies)
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {group.draftPurchaseOrderIds.length > 0 && (
                  <Badge variant="warning">Drafts: {group.draftPurchaseOrderIds.length}</Badge>
                )}
                {group.hasUnknownMethods && <Badge variant="destructive">Unknown order method</Badge>}

                {group.draftPurchaseOrderIds.length > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={group.hasUnknownMethods || !group.supplierId}
                    onClick={() =>
                      setExecutionSession(mapGroupToExecutionSession(group, group.draftPurchaseOrderIds))
                    }
                  >
                    Resume Draft
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={group.hasUnknownMethods || !group.supplierId}
                    onClick={() => setActiveConfigGroup(group)}
                  >
                    <Play className="h-4 w-4" />
                    Run Vendor Automation
                  </Button>
                )}
              </div>
            </header>

            <div className="mb-3 flex flex-wrap gap-2">
              {group.methods.map((method) => (
                <Badge key={method} variant="outline">
                  {procurementOrderMethodLabel(method)}
                </Badge>
              ))}
            </div>

            <div className="space-y-1 text-xs">
              {group.lines.map((line) => (
                <div key={line.card.id} className="flex items-center justify-between rounded-md bg-muted/25 px-2 py-1.5">
                  <span>
                    Card #{line.card.cardNumber} • {line.partName}
                  </span>
                  <span className="text-muted-foreground">
                    {line.orderMethod ? procurementOrderMethodLabel(line.orderMethod) : line.orderMethodError}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <VendorOrderConfigDialog
        open={!!activeConfigGroup}
        group={activeConfigGroup}
        isSubmitting={isCreatingDrafts}
        onOpenChange={(open) => {
          if (!open) {
            setActiveConfigGroup(null);
          }
        }}
        onSubmit={handleCreateDrafts}
      />
    </div>
  );
}
