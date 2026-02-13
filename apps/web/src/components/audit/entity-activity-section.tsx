import * as React from "react";
import { History, RefreshCw, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Card, CardContent, Skeleton } from "@/components/ui";
import { useEntityActivity } from "@/hooks/use-audit";
import { AuditEntryRow } from "./audit-entry-row";

/* ── Reusable entity activity / history section ──────────────── */

interface EntityActivitySectionProps {
  token: string;
  entityType: string;
  entityId: string;
  onUnauthorized: () => void;
  /** Number of entries per page. Default 15. */
  pageSize?: number;
}

export function EntityActivitySection({
  token,
  entityType,
  entityId,
  onUnauthorized,
  pageSize = 15,
}: EntityActivitySectionProps) {
  const { entries, pagination, loading, error, page, setPage, refresh } =
    useEntityActivity({
      token,
      entityType,
      entityId,
      onUnauthorized,
      pageSize,
    });

  if (loading && entries.length === 0) {
    return <EntityActivitySkeleton />;
  }

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

  if (entries.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="py-8 text-center">
          <History className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            No activity recorded yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="rounded-xl">
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {entries.map((entry) => (
              <AuditEntryRow key={entry.id} entry={entry} compact />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      {pagination.pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {pagination.page} of {pagination.pages} ({pagination.total}{" "}
            entries)
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.pages || loading}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Skeleton for loading state ──────────────────────────────── */

export function EntityActivitySkeleton() {
  return (
    <Card className="rounded-xl">
      <CardContent className="p-4 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-2 border-l-2 border-border pl-3 py-2">
            <Skeleton className="h-3.5 w-3.5 shrink-0 mt-0.5 rounded-sm" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-3/4 rounded" />
              <Skeleton className="h-3 w-24 rounded" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
