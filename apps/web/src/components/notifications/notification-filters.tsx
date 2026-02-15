import { cn } from "@/lib/utils";
import type { NotificationFilter } from "@/hooks/use-notifications";

const FILTER_OPTIONS: { value: NotificationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "orders", label: "Orders" },
  { value: "inventory", label: "Inventory" },
  { value: "system", label: "System" },
];

interface NotificationFiltersProps {
  activeFilter: NotificationFilter;
  onFilterChange: (filter: NotificationFilter) => void;
}

export function NotificationFilters({
  activeFilter,
  onFilterChange,
}: NotificationFiltersProps) {
  return (
    <div
      className="flex gap-1 overflow-x-auto px-4 pb-2"
      role="tablist"
      aria-label="Notification filters"
    >
      {FILTER_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={activeFilter === option.value}
          onClick={() => onFilterChange(option.value)}
          className={cn(
            "inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            activeFilter === option.value
              ? "bg-[hsl(var(--link))] text-white"
              : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
