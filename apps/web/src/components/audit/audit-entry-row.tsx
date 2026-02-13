import * as React from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatActionLabel,
  formatEntityType,
  relativeTime,
  entityDetailPath,
} from "@/lib/audit-utils";
import { AuditDiffPanel } from "./audit-diff-panel";
import type { AuditLogEntry } from "@/types";

/* ── Single audit entry with expand/collapse ─────────────────── */

interface AuditEntryRowProps {
  entry: AuditLogEntry;
  /** When true, renders a compact version suitable for entity detail pages. */
  compact?: boolean;
  className?: string;
}

export function AuditEntryRow({ entry, compact, className }: AuditEntryRowProps) {
  const [expanded, setExpanded] = React.useState(false);

  const actorName = React.useMemo(() => {
    const meta = entry.metadata;
    if (meta?.actorName && typeof meta.actorName === "string") return meta.actorName;
    if (meta?.actor_name && typeof meta.actor_name === "string") return meta.actor_name;
    if (meta?.userName && typeof meta.userName === "string") return meta.userName;
    if (meta?.user_name && typeof meta.user_name === "string") return meta.user_name;
    return entry.userId ? "User" : "System";
  }, [entry.metadata, entry.userId]);

  const detailPath = entityDetailPath(entry.entityType, entry.entityId ?? "");
  const hasDetail =
    entry.previousState != null ||
    entry.newState != null ||
    (entry.metadata && Object.keys(entry.metadata).length > 0);

  const toggle = React.useCallback(() => {
    if (hasDetail) setExpanded((p) => !p);
  }, [hasDetail]);

  if (compact) {
    return (
      <div className={cn("border-l-2 border-border pl-3 py-2", className)}>
        <div className="flex items-start gap-2">
          {hasDetail && (
            <button
              type="button"
              onClick={toggle}
              className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {!hasDetail && <span className="w-3.5 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <span className="font-semibold">{actorName}</span>{" "}
              <span className="text-muted-foreground">
                {formatActionLabel(entry.action)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {relativeTime(entry.timestamp)}
            </p>
          </div>
        </div>
        {expanded && (
          <div className="mt-2 ml-5">
            <AuditDiffPanel entry={entry} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "border-b border-border last:border-b-0",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center gap-3 px-4 py-2.5 text-sm",
          hasDetail && "cursor-pointer hover:bg-muted/50",
        )}
        onClick={toggle}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        onKeyDown={
          hasDetail
            ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }
            : undefined
        }
      >
        {/* Expand icon */}
        <span className="w-4 shrink-0 text-muted-foreground">
          {hasDetail &&
            (expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            ))}
        </span>

        {/* Timestamp */}
        <span className="w-28 shrink-0 text-xs text-muted-foreground">
          {relativeTime(entry.timestamp)}
        </span>

        {/* Actor */}
        <span className="w-32 shrink-0 font-medium truncate" title={actorName}>
          {actorName}
        </span>

        {/* Action */}
        <span className="w-48 shrink-0 truncate">
          {formatActionLabel(entry.action)}
        </span>

        {/* Entity */}
        <span className="flex-1 min-w-0 flex items-center gap-1 text-muted-foreground">
          <span className="truncate">
            {formatEntityType(entry.entityType)}
          </span>
          {detailPath && entry.entityId && (
            <a
              href={detailPath}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 text-[hsl(var(--link))] hover:underline"
              title="View entity"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </span>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-3 pl-11">
          <AuditDiffPanel entry={entry} />
        </div>
      )}
    </div>
  );
}
