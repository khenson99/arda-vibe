import { Card, CardContent } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone?: "default" | "warning" | "accent";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-bold">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </div>
          <div
            className={cn(
              "rounded-full p-2",
              tone === "warning" && "bg-[hsl(var(--arda-warning)/0.12)] text-[hsl(var(--arda-warning))]",
              tone === "accent" && "bg-[hsl(var(--arda-blue)/0.12)] text-[hsl(var(--arda-blue))]",
              tone === "default" && "bg-muted text-muted-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
