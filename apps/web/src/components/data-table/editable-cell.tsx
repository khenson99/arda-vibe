import * as React from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";

type EditState = "idle" | "editing" | "saving" | "saved" | "error";

interface EditableCellProps {
  /** Current display value (formatted for reading) */
  displayValue: string;
  /** Raw value used to seed the input when editing starts */
  rawValue: string;
  /** Whether this cell can be edited (e.g. requires entity ID) */
  editable?: boolean;
  /** Input type for the edit field */
  inputType?: "text" | "number";
  /** Placeholder shown in the edit input */
  placeholder?: string;
  /** Called with the new raw value when the user commits an edit.
   *  Return a resolved promise on success, or throw/reject on error. */
  onCommit: (nextValue: string) => Promise<void>;
}

/**
 * Self-contained inline-editable cell with a 5-state lifecycle:
 * idle → editing → saving → saved (1.5s) → idle
 *                         ↘ error → editing
 *
 * This replaces the previous approach of lifting all edit state to the
 * parent (5 separate useState calls in PartsRoute). Each cell now manages
 * its own lifecycle, keeping the parent clean.
 */
export const EditableCell = React.memo(function EditableCell({
  displayValue,
  rawValue,
  editable = true,
  inputType = "text",
  placeholder,
  onCommit,
}: EditableCellProps) {
  const [state, setState] = React.useState<EditState>("idle");
  const [draft, setDraft] = React.useState(rawValue);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const savedTimerRef = React.useRef<ReturnType<typeof setTimeout>>();

  // Keep draft in sync when rawValue changes externally (e.g. after parent refetch)
  React.useEffect(() => {
    if (state === "idle") {
      setDraft(rawValue);
    }
  }, [rawValue, state]);

  // Clean up saved timer on unmount
  React.useEffect(() => () => clearTimeout(savedTimerRef.current), []);

  const startEditing = React.useCallback(() => {
    if (!editable) return;
    setState("editing");
    setDraft(rawValue);
    setErrorMsg(null);
  }, [editable, rawValue]);

  const cancel = React.useCallback(() => {
    setState("idle");
    setDraft(rawValue);
    setErrorMsg(null);
  }, [rawValue]);

  const commit = React.useCallback(async () => {
    const trimmed = draft.trim();

    // No change — just cancel
    if (trimmed === rawValue.trim()) {
      cancel();
      return;
    }

    setState("saving");
    setErrorMsg(null);

    try {
      await onCommit(trimmed);
      setState("saved");
      savedTimerRef.current = setTimeout(() => setState("idle"), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setErrorMsg(msg);
      setState("error");
    }
  }, [cancel, draft, onCommit, rawValue]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commit();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    },
    [cancel, commit],
  );

  // ── Editing state ────────────────────────────────────────────
  if (state === "editing" || state === "error") {
    return (
      <div className="space-y-0.5">
        <Input
          autoFocus
          type={inputType}
          value={draft}
          placeholder={placeholder}
          className="h-7 min-w-[80px] bg-background px-2 text-[length:var(--font-size-base,12px)] ring-1 ring-[hsl(var(--link))]"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => void commit()}
        />
        {errorMsg && (
          <p className="flex items-center gap-1 text-[10px] text-[hsl(var(--arda-error))]">
            <X className="h-3 w-3 shrink-0" />
            {errorMsg}
          </p>
        )}
      </div>
    );
  }

  // ── Saving state ─────────────────────────────────────────────
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 animate-pulse text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="truncate">{displayValue || "—"}</span>
      </span>
    );
  }

  // ── Saved state (brief green flash) ──────────────────────────
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[hsl(var(--arda-success))]">
        <Check className="h-3 w-3" />
        <span className="truncate">{displayValue || "—"}</span>
      </span>
    );
  }

  // ── Idle state ───────────────────────────────────────────────
  if (!editable) {
    return <span className="text-muted-foreground">{displayValue || "—"}</span>;
  }

  return (
    <button
      type="button"
      className={cn(
        "group inline-flex w-full items-center justify-between gap-1 rounded-sm px-1 py-0.5 text-left",
        "border-b border-dashed border-border/60 transition-colors",
        "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "cursor-text",
      )}
      onClick={startEditing}
      title="Click to edit. Press Enter to save, Escape to cancel."
    >
      <span className="truncate">{displayValue || "—"}</span>
      <Pencil className="h-3 w-3 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
});
