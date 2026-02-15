import {
  AlertTriangle,
  Boxes,
  ClipboardList,
  Info,
  PackageCheck,
  Settings,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/formatters";
import type { NotificationRecord } from "@/types";

/* ── Type-to-icon mapping ───────────────────────────────────── */

function getNotificationIcon(type: string) {
  if (
    type.startsWith("po_") ||
    type === "order_status_change" ||
    type === "order_exception"
  ) {
    return ClipboardList;
  }

  if (type.startsWith("wo_")) {
    return Settings;
  }

  if (type === "transfer_created" || type === "transfer_completed") {
    return Truck;
  }

  if (type === "receiving_complete") {
    return PackageCheck;
  }

  if (
    type === "low_stock" ||
    type === "stockout" ||
    type === "reorder_point" ||
    type === "inventory_adjustment"
  ) {
    return Boxes;
  }

  if (type === "system_alert" || type === "integration_error") {
    return AlertTriangle;
  }

  if (type === "system" || type === "announcement" || type === "user_mention") {
    return Info;
  }

  return ShoppingCart;
}

function getIconColor(type: string): string {
  if (
    type === "low_stock" ||
    type === "stockout" ||
    type === "order_exception" ||
    type === "system_alert" ||
    type === "integration_error"
  ) {
    return "text-[hsl(var(--arda-warning))]";
  }

  if (
    type === "po_received" ||
    type === "wo_completed" ||
    type === "transfer_completed" ||
    type === "receiving_complete"
  ) {
    return "text-[hsl(var(--arda-success))]";
  }

  return "text-[hsl(var(--link))]";
}

/* ── Component ──────────────────────────────────────────────── */

interface NotificationItemProps {
  notification: NotificationRecord;
  onMarkRead: (id: string) => void;
  onNavigate: (url: string) => void;
}

export function NotificationItem({
  notification,
  onMarkRead,
  onNavigate,
}: NotificationItemProps) {
  const Icon = getNotificationIcon(notification.type);
  const iconColor = getIconColor(notification.type);

  const handleClick = () => {
    if (!notification.isRead) {
      onMarkRead(notification.id);
    }
    if (notification.actionUrl) {
      onNavigate(notification.actionUrl);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        "cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !notification.isRead && "bg-[hsl(var(--arda-blue)/0.05)]",
      )}
      aria-label={`${notification.isRead ? "" : "Unread: "}${notification.title}`}
    >
      {/* Icon */}
      <div
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          !notification.isRead
            ? "bg-[hsl(var(--arda-blue)/0.1)]"
            : "bg-muted",
        )}
      >
        <Icon className={cn("h-4 w-4", iconColor)} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p
            className={cn(
              "truncate text-sm",
              !notification.isRead ? "font-semibold text-foreground" : "text-foreground",
            )}
          >
            {notification.title}
          </p>
          {!notification.isRead && (
            <span
              className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--link))]"
              aria-hidden="true"
            />
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {notification.body}
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          {formatRelativeTime(notification.createdAt)}
        </p>
      </div>
    </div>
  );
}
