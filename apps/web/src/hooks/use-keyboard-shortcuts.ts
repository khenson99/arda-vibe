import * as React from "react";

interface KeyboardShortcutHandlers {
  /** Focus the header search input (`/` or `Cmd+K`) */
  onFocusSearch?: () => void;
  /** Refresh data (`r`) */
  onRefresh?: () => void;
  /** Navigate to a route (`g` then letter) */
  onNavigate?: (path: string) => void;
}

/**
 * Global keyboard shortcuts for the Arda workspace.
 *
 * Bindings:
 * - `/` or `Cmd+K` → focus search
 * - `r` → refresh data
 * - `Escape` → blur current element (close dialogs, cancel edits)
 *
 * All single-key shortcuts are suppressed when the user is typing in an
 * input, textarea, or contentEditable element. Meta-key combos (`Cmd+K`)
 * fire regardless.
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;

  React.useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!target || !(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;

      // Cmd+K / Ctrl+K → focus search (works even in inputs)
      if (meta && event.key === "k") {
        event.preventDefault();
        handlersRef.current.onFocusSearch?.();
        return;
      }

      // Escape → blur active element
      if (event.key === "Escape") {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        return;
      }

      // Below here: single-key shortcuts — skip if in an editable field
      if (isEditableTarget(event.target)) return;

      // `/` → focus search
      if (event.key === "/") {
        event.preventDefault();
        handlersRef.current.onFocusSearch?.();
        return;
      }

      // `r` → refresh
      if (event.key === "r") {
        event.preventDefault();
        handlersRef.current.onRefresh?.();
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
