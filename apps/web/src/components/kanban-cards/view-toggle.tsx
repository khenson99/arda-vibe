import * as React from "react";
import { LayoutGrid, TableProperties } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "arda.web.cards.viewMode";

export type ViewMode = "table" | "board";

function readStoredViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "board") return "board";
  } catch {
    /* localStorage unavailable */
  }
  return "table";
}

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = React.useState<ViewMode>(readStoredViewMode);

  const setAndPersist = React.useCallback((next: ViewMode) => {
    setMode(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  return [mode, setAndPersist];
}

interface ViewToggleProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-muted/40 p-0.5">
      <button
        type="button"
        onClick={() => onChange("table")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
          mode === "table"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <TableProperties className="h-3.5 w-3.5" />
        Table
      </button>
      <button
        type="button"
        onClick={() => onChange("board")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
          mode === "board"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        Board
      </button>
    </div>
  );
}
