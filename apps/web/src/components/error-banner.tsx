import { Button } from "@/components/ui";
import { CircleAlert } from "lucide-react";

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void | Promise<void> }) {
  return (
    <div className="rounded-xl border border-[hsl(var(--arda-error)/0.28)] bg-[hsl(var(--arda-error)/0.1)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--arda-error))]">
          <CircleAlert className="h-4 w-4" />
          {message}
        </p>
        <Button variant="outline" size="sm" onClick={() => void onRetry()}>
          Retry
        </Button>
      </div>
    </div>
  );
}
