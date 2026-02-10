import { cn } from "@/lib/utils";

/* ── Stage definitions ─────────────────────────────────────────────── */

/**
 * Kanban card lifecycle stages in order.
 * Matches the DB enum: packages/db/src/schema/kanban.ts → cardStageEnum
 */
const CARD_STAGES = [
  "created",
  "triggered",
  "ordered",
  "in_transit",
  "received",
  "restocked",
] as const;

type CardStage = (typeof CARD_STAGES)[number];

const STAGE_LABELS: Record<CardStage, string> = {
  created: "Created",
  triggered: "Triggered",
  ordered: "Ordered",
  in_transit: "In Transit",
  received: "Received",
  restocked: "Restocked",
};

/* ── Component ─────────────────────────────────────────────────────── */

interface StageProgressProps {
  /** Current stage of the kanban card (e.g. "triggered", "ordered") */
  currentStage: string;
  className?: string;
}

/**
 * Visual pipeline showing the kanban card lifecycle.
 * Each stage renders as a circle connected by lines:
 * - Completed stages: filled with success color
 * - Current stage: pulsing with primary color
 * - Future stages: muted / empty
 */
export function StageProgress({ currentStage, className }: StageProgressProps) {
  const normalizedStage = currentStage.toLowerCase().trim();
  const currentIndex = CARD_STAGES.indexOf(normalizedStage as CardStage);

  return (
    <div className={cn("flex items-center gap-0", className)} role="list" aria-label="Card stage progress">
      {CARD_STAGES.map((stage, index) => {
        const isCompleted = currentIndex >= 0 && index < currentIndex;
        const isCurrent = index === currentIndex;
        const isFuture = currentIndex >= 0 ? index > currentIndex : true;

        return (
          <div key={stage} className="flex items-center" role="listitem">
            {/* Connecting line before (skip first) */}
            {index > 0 && (
              <div
                className={cn(
                  "h-0.5 w-4 sm:w-6",
                  isCompleted || isCurrent
                    ? "bg-[hsl(var(--arda-success))]"
                    : "bg-border",
                )}
              />
            )}

            {/* Stage dot + label */}
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border-2 text-[9px] font-bold",
                  isCompleted &&
                    "border-[hsl(var(--arda-success))] bg-[hsl(var(--arda-success))] text-white",
                  isCurrent &&
                    "animate-pulse border-primary bg-primary text-white",
                  isFuture &&
                    "border-border bg-muted text-muted-foreground",
                )}
                aria-current={isCurrent ? "step" : undefined}
              >
                {isCompleted ? "✓" : index + 1}
              </div>
              <span
                className={cn(
                  "whitespace-nowrap text-[10px] leading-tight",
                  isCompleted && "font-medium text-[hsl(var(--arda-success))]",
                  isCurrent && "font-semibold text-primary",
                  isFuture && "text-muted-foreground",
                )}
              >
                {STAGE_LABELS[stage]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
