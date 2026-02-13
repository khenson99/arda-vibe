import * as React from "react";
import { cn } from "@/lib/utils";
import {
  computeJsonDiff,
  formatDiffValue,
  formatTimestamp,
} from "@/lib/audit-utils";
import type { AuditLogEntry } from "@/types";

interface AuditDiffPanelProps {
  entry: AuditLogEntry;
  className?: string;
}

export function AuditDiffPanel({ entry, className }: AuditDiffPanelProps) {
  const diffs = React.useMemo(
    () =>
      computeJsonDiff(
        entry.previousState as Record<string, unknown> | null,
        entry.newState as Record<string, unknown> | null,
      ),
    [entry.previousState, entry.newState],
  );

  const hasDiffs = diffs.length > 0;
  const hasMetadata =
    entry.metadata && Object.keys(entry.metadata).length > 0;

  return (
    <div className={cn("space-y-3 text-xs", className)}>
      {/* State diff */}
      {hasDiffs && (
        <div>
          <p className="font-semibold text-muted-foreground mb-1.5">
            State Changes
          </p>
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-1.5 font-medium text-muted-foreground w-1/4">
                    Field
                  </th>
                  <th className="px-3 py-1.5 font-medium text-muted-foreground w-[37.5%]">
                    Before
                  </th>
                  <th className="px-3 py-1.5 font-medium text-muted-foreground w-[37.5%]">
                    After
                  </th>
                </tr>
              </thead>
              <tbody>
                {diffs.map((d) => (
                  <tr
                    key={d.key}
                    className={cn(
                      "border-t border-border",
                      d.type === "added" && "bg-green-50 dark:bg-green-950/20",
                      d.type === "removed" && "bg-red-50 dark:bg-red-950/20",
                      d.type === "changed" &&
                        "bg-yellow-50 dark:bg-yellow-950/20",
                    )}
                  >
                    <td className="px-3 py-1.5 font-medium break-all">
                      {d.key}
                    </td>
                    <td className="px-3 py-1.5 break-all">
                      {d.type === "added" ? (
                        <span className="text-muted-foreground italic">
                          --
                        </span>
                      ) : (
                        <code className="text-red-600 dark:text-red-400">
                          {formatDiffValue(d.oldValue)}
                        </code>
                      )}
                    </td>
                    <td className="px-3 py-1.5 break-all">
                      {d.type === "removed" ? (
                        <span className="text-muted-foreground italic">
                          --
                        </span>
                      ) : (
                        <code className="text-green-600 dark:text-green-400">
                          {formatDiffValue(d.newValue)}
                        </code>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No diffs but we have states */}
      {!hasDiffs &&
        (entry.previousState || entry.newState) && (
          <p className="text-muted-foreground italic">No field changes detected.</p>
        )}

      {/* Metadata */}
      {hasMetadata && (
        <div>
          <p className="font-semibold text-muted-foreground mb-1.5">
            Metadata
          </p>
          <pre className="rounded-md border border-border bg-muted/50 p-2 overflow-x-auto text-[11px] leading-4">
            {JSON.stringify(entry.metadata, null, 2)}
          </pre>
        </div>
      )}

      {/* Technical details */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
        <span>
          <strong className="text-card-foreground">Timestamp:</strong>{" "}
          {formatTimestamp(entry.timestamp)}
        </span>
        {entry.ipAddress && (
          <span>
            <strong className="text-card-foreground">IP:</strong>{" "}
            {entry.ipAddress}
          </span>
        )}
        {entry.userAgent && (
          <span
            className="truncate max-w-xs"
            title={entry.userAgent}
          >
            <strong className="text-card-foreground">UA:</strong>{" "}
            {entry.userAgent}
          </span>
        )}
        <span>
          <strong className="text-card-foreground">Hash:</strong>{" "}
          <code className="text-[10px]">{entry.hashChain.slice(0, 12)}...</code>
        </span>
        <span>
          <strong className="text-card-foreground">Seq:</strong>{" "}
          {entry.sequenceNumber}
        </span>
      </div>
    </div>
  );
}
