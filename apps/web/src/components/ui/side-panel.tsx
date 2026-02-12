import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** "default" = max-w-lg, "wide" = max-w-2xl */
  width?: "default" | "wide";
  resizable?: boolean;
  children: React.ReactNode;
  /** Extra header actions rendered to the left of close button */
  headerActions?: React.ReactNode;
}

const SIDE_PANEL_WIDTH_STORAGE_KEY = "arda.web.sidePanel.width.v1";
const DEFAULT_WIDTHS: Record<NonNullable<SidePanelProps["width"]>, number> = {
  default: 560,
  wide: 900,
};
const MIN_WIDTH = 420;
const MAX_WIDTH = 1200;

export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  width = "default",
  resizable = true,
  children,
  headerActions,
}: SidePanelProps) {
  const [panelWidth, setPanelWidth] = React.useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_WIDTHS[width];
    const raw = window.localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
      return parsed;
    }
    return DEFAULT_WIDTHS[width];
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const maxViewportWidth = Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.92));
    if (panelWidth > maxViewportWidth) {
      setPanelWidth(maxViewportWidth);
    }
  }, [panelWidth]);

  const handleResizePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizable) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    let currentWidth = startWidth;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      const maxViewportWidth = Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.92));
      const nextWidth = Math.min(maxViewportWidth, Math.max(MIN_WIDTH, startWidth + delta));
      currentWidth = nextWidth;
      setPanelWidth(nextWidth);
    };

    const onPointerUp = () => {
      window.localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(currentWidth));
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }, [panelWidth, resizable]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
  }, [panelWidth]);

  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-border bg-background shadow-xl transition-transform duration-300 ease-in-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
        style={{ maxWidth: `${panelWidth}px` }}
      >
        {resizable && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            className="absolute left-0 top-0 z-50 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-primary/20"
            onPointerDown={handleResizePointerDown}
          />
        )}

        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {subtitle && (
              <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <div className="ml-3 flex items-center gap-1.5">
            {headerActions}
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
