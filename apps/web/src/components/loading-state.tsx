import { Loader2 } from "lucide-react";

export function LoadingState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center rounded-xl border border-dashed border-border bg-card">
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {message}
      </span>
    </div>
  );
}
