import * as React from "react";
import { useNavigate } from "react-router-dom";
import { BellOff, CheckCheck, Loader2 } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, Skeleton } from "@/components/ui";
import { NotificationFilters } from "./notification-filters";
import { NotificationItem } from "./notification-item";
import type { UseNotificationsReturn } from "@/hooks/use-notifications";

interface NotificationPopoverProps extends UseNotificationsReturn {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function NotificationPopover({
  open,
  onOpenChange,
  children,
  notifications,
  unreadCount,
  isLoading,
  activeFilter,
  setActiveFilter,
  markRead,
  markAllRead,
}: NotificationPopoverProps) {
  const navigate = useNavigate();
  const listRef = React.useRef<HTMLDivElement>(null);

  /* ── Refresh when opening ─────────────────────────────────── */

  const prevOpenRef = React.useRef(open);
  React.useEffect(() => {
    if (open && !prevOpenRef.current) {
      // Reset filter to "all" when re-opening
      setActiveFilter("all");
    }
    prevOpenRef.current = open;
  }, [open, setActiveFilter]);

  /* ── Keyboard navigation ──────────────────────────────────── */

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
        return;
      }

      if (!listRef.current) return;

      const items = Array.from(
        listRef.current.querySelectorAll<HTMLElement>('[role="button"]'),
      );
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = currentIndex + 1 < items.length ? currentIndex + 1 : 0;
        items[next]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = currentIndex - 1 >= 0 ? currentIndex - 1 : items.length - 1;
        items[prev]?.focus();
      }
    },
    [onOpenChange],
  );

  /* ── Handlers ─────────────────────────────────────────────── */

  const handleMarkRead = React.useCallback(
    (id: string) => {
      void markRead(id);
    },
    [markRead],
  );

  const handleNavigate = React.useCallback(
    (url: string) => {
      onOpenChange(false);
      // Support both relative paths and full URLs
      if (url.startsWith("http")) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        navigate(url);
      }
    },
    [navigate, onOpenChange],
  );

  const handleMarkAllRead = React.useCallback(() => {
    void markAllRead();
  }, [markAllRead]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[380px] p-0"
        onKeyDown={handleKeyDown}
        aria-label="Notifications"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Notifications</h2>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleMarkAllRead}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Filter pills */}
        <div className="border-b border-border pt-2">
          <NotificationFilters
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
          />
        </div>

        {/* Notification list */}
        <div
          ref={listRef}
          className="max-h-[400px] overflow-y-auto"
          role="list"
          aria-label="Notification list"
        >
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
              <BellOff className="h-8 w-8" />
              <p className="text-sm">
                {activeFilter === "all"
                  ? "No notifications yet"
                  : `No ${activeFilter} notifications`}
              </p>
            </div>
          ) : (
            <div className="py-1">
              {notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onMarkRead={handleMarkRead}
                  onNavigate={handleNavigate}
                />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
