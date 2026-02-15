import * as React from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { NotificationPopover } from "./notification-popover";
import { useNotifications } from "@/hooks/use-notifications";

interface NotificationBellProps {
  token: string;
  onUnauthorized: () => void;
}

export function NotificationBell({ token, onUnauthorized }: NotificationBellProps) {
  const [open, setOpen] = React.useState(false);

  const notificationState = useNotifications(token, onUnauthorized);

  const { unreadCount } = notificationState;

  return (
    <NotificationPopover open={open} onOpenChange={setOpen} {...notificationState}>
      <Button
        variant="ghost"
        size="icon"
        className="relative h-8 w-8 text-muted-foreground"
        aria-label={
          unreadCount > 0
            ? `Notifications: ${unreadCount} unread`
            : "Notifications: none unread"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span
            className={cn(
              "absolute flex items-center justify-center rounded-full bg-primary text-[10px] font-bold leading-none text-primary-foreground",
              unreadCount > 9
                ? "-right-0.5 -top-0.5 h-4 min-w-4 px-0.5"
                : "right-0.5 top-0.5 h-3.5 w-3.5",
            )}
            aria-hidden="true"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>
    </NotificationPopover>
  );
}
