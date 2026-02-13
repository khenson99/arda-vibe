import * as React from "react";
import { Search, X } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { formatActionLabel, formatEntityType } from "@/lib/audit-utils";
import type { AuditListFilters } from "@/types";

/* ── Filter bar for the admin audit log tab ──────────────────── */

interface AuditFilterBarProps {
  filters: AuditListFilters;
  onFiltersChange: (next: AuditListFilters) => void;
  actions: string[];
  entityTypes: string[];
  loading?: boolean;
}

export function AuditFilterBar({
  filters,
  onFiltersChange,
  actions,
  entityTypes,
  loading,
}: AuditFilterBarProps) {
  const [localSearch, setLocalSearch] = React.useState(filters.search ?? "");

  const update = React.useCallback(
    (patch: Partial<AuditListFilters>) => {
      onFiltersChange({ ...filters, page: 1, ...patch });
    },
    [filters, onFiltersChange],
  );

  const handleSearchSubmit = React.useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      update({ search: localSearch || undefined });
    },
    [localSearch, update],
  );

  const clearAll = React.useCallback(() => {
    setLocalSearch("");
    onFiltersChange({ page: 1, limit: filters.limit });
  }, [filters.limit, onFiltersChange]);

  const hasActiveFilters =
    filters.action ||
    filters.entityType ||
    filters.dateFrom ||
    filters.dateTo ||
    filters.search;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        {/* Search */}
        <form
          onSubmit={handleSearchSubmit}
          className="flex items-center gap-1.5"
        >
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search actions, entities..."
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              className="pl-8 w-56 h-9 text-sm"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={loading}>
            Search
          </Button>
        </form>

        {/* Action filter */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Action
          </label>
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            value={filters.action ?? ""}
            onChange={(e) =>
              update({ action: e.target.value || undefined })
            }
          >
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {formatActionLabel(a)}
              </option>
            ))}
          </select>
        </div>

        {/* Entity type filter */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            Entity Type
          </label>
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            value={filters.entityType ?? ""}
            onChange={(e) =>
              update({ entityType: e.target.value || undefined })
            }
          >
            <option value="">All types</option>
            {entityTypes.map((t) => (
              <option key={t} value={t}>
                {formatEntityType(t)}
              </option>
            ))}
          </select>
        </div>

        {/* Date from */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            From
          </label>
          <Input
            type="date"
            value={filters.dateFrom?.slice(0, 10) ?? ""}
            onChange={(e) =>
              update({
                dateFrom: e.target.value
                  ? new Date(e.target.value).toISOString()
                  : undefined,
              })
            }
            className="h-9 w-36 text-sm"
          />
        </div>

        {/* Date to */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            To
          </label>
          <Input
            type="date"
            value={filters.dateTo?.slice(0, 10) ?? ""}
            onChange={(e) =>
              update({
                dateTo: e.target.value
                  ? new Date(
                      new Date(e.target.value).getTime() + 86_399_999,
                    ).toISOString()
                  : undefined,
              })
            }
            className="h-9 w-36 text-sm"
          />
        </div>

        {/* Clear button */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="text-muted-foreground"
          >
            <X className="mr-1 h-3.5 w-3.5" /> Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
