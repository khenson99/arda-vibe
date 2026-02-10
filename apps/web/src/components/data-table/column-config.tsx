import * as React from "react";
import { GripVertical, Settings2, ChevronDown } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { ITEM_TABLE_COLUMNS, ITEM_TABLE_COLUMN_KEYS, ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS } from "@/types";
import type { ItemTableColumnKey } from "@/types";
import { cn } from "@/lib/utils";

interface ColumnConfigProps {
  visibleColumns: ItemTableColumnKey[];
  onColumnsChange: (columns: ItemTableColumnKey[]) => void;
}

/**
 * Column visibility + order manager rendered inside a Popover.
 *
 * Features:
 * - Checkbox toggles for each column
 * - Drag-to-reorder via native HTML5 DnD
 * - Order number shown next to each column
 * - Required columns are locked (can't be hidden or moved to bottom)
 * - "Reset to defaults" restores original column set and order
 * - Auto-persists on every change (no Save button)
 */
export function ColumnConfig({ visibleColumns, onColumnsChange }: ColumnConfigProps) {
  const visibleSet = React.useMemo(() => new Set(visibleColumns), [visibleColumns]);

  // Ordered list: visible columns first (in their order), then hidden columns
  const orderedColumns = React.useMemo(() => {
    const visible = visibleColumns
      .map((key) => ITEM_TABLE_COLUMNS.find((c) => c.key === key)!)
      .filter(Boolean);
    const hidden = ITEM_TABLE_COLUMNS.filter((c) => !visibleSet.has(c.key));
    return [...visible, ...hidden];
  }, [visibleColumns, visibleSet]);

  const [draggedKey, setDraggedKey] = React.useState<string | null>(null);

  const toggleColumn = React.useCallback(
    (columnKey: ItemTableColumnKey) => {
      const column = ITEM_TABLE_COLUMNS.find((c) => c.key === columnKey);
      if (column?.required) return;

      const nextSet = new Set(visibleColumns);
      if (nextSet.has(columnKey)) {
        nextSet.delete(columnKey);
      } else {
        nextSet.add(columnKey);
      }

      // Enforce required columns
      for (const c of ITEM_TABLE_COLUMNS) {
        if (c.required) nextSet.add(c.key);
      }

      // Preserve order of existing visible columns, append new ones at end
      const result = visibleColumns.filter((k) => nextSet.has(k));
      for (const k of ITEM_TABLE_COLUMN_KEYS) {
        if (nextSet.has(k as ItemTableColumnKey) && !result.includes(k as ItemTableColumnKey)) {
          result.push(k as ItemTableColumnKey);
        }
      }

      onColumnsChange(result);
    },
    [onColumnsChange, visibleColumns],
  );

  const handleDragStart = React.useCallback((key: string) => {
    setDraggedKey(key);
  }, []);

  const handleDragOver = React.useCallback(
    (event: React.DragEvent, targetKey: string) => {
      event.preventDefault();
      if (!draggedKey || draggedKey === targetKey) return;

      // Only reorder within visible columns
      if (!visibleSet.has(draggedKey as ItemTableColumnKey) || !visibleSet.has(targetKey as ItemTableColumnKey)) {
        return;
      }

      const newOrder = [...visibleColumns];
      const fromIndex = newOrder.indexOf(draggedKey as ItemTableColumnKey);
      const toIndex = newOrder.indexOf(targetKey as ItemTableColumnKey);
      if (fromIndex === -1 || toIndex === -1) return;

      newOrder.splice(fromIndex, 1);
      newOrder.splice(toIndex, 0, draggedKey as ItemTableColumnKey);
      onColumnsChange(newOrder);
    },
    [draggedKey, onColumnsChange, visibleColumns, visibleSet],
  );

  const handleDragEnd = React.useCallback(() => {
    setDraggedKey(null);
  }, []);

  const resetDefaults = React.useCallback(() => {
    onColumnsChange([...ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS]);
  }, [onColumnsChange]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9">
          <Settings2 className="h-4 w-4" />
          View
          <ChevronDown className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="border-b px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Visible columns
          </p>
          <p className="text-xs text-muted-foreground">
            {visibleColumns.length} of {ITEM_TABLE_COLUMNS.length} shown — drag to reorder
          </p>
        </div>

        <div className="max-h-[340px] space-y-0.5 overflow-y-auto p-2">
          {orderedColumns.map((column, index) => {
            const isVisible = visibleSet.has(column.key);
            const visibleIndex = isVisible ? visibleColumns.indexOf(column.key) : -1;

            return (
              <div
                key={column.key}
                draggable={isVisible && !column.required}
                onDragStart={() => handleDragStart(column.key)}
                onDragOver={(e) => handleDragOver(e, column.key)}
                onDragEnd={handleDragEnd}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/70",
                  column.required && "cursor-not-allowed opacity-70 hover:bg-transparent",
                  draggedKey === column.key && "opacity-50",
                  !isVisible && "text-muted-foreground",
                )}
              >
                {isVisible && !column.required ? (
                  <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/60" />
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}

                <span className="min-w-[18px] text-center text-[10px] font-semibold text-muted-foreground">
                  {isVisible ? visibleIndex + 1 : ""}
                </span>

                <label className="flex flex-1 cursor-pointer items-center justify-between">
                  <span>{column.label}</span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
                    checked={isVisible}
                    disabled={column.required}
                    onChange={() => toggleColumn(column.key)}
                  />
                </label>
              </div>
            );
          })}
        </div>

        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-center text-xs"
            onClick={resetDefaults}
          >
            Reset defaults
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
