import * as React from "react";
import type { NotificationRecord } from "@/types";
import {
  isUnauthorized,
  parseApiError,
  fetchNotifications,
  fetchUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/lib/api-client";

/* ── Filter category types ──────────────────────────────────── */

export type NotificationFilter = "all" | "unread" | "orders" | "inventory" | "system";

/**
 * Maps UI filter pills to the notification `type` field values coming from
 * the backend.  Each pill may cover several backend types.
 */
const FILTER_TYPE_MAP: Record<NotificationFilter, string[] | null> = {
  all: null,
  unread: null, // special: uses isRead flag
  orders: [
    "po_created",
    "po_approved",
    "po_sent",
    "po_received",
    "wo_created",
    "wo_completed",
    "order_exception",
    "order_status_change",
  ],
  inventory: [
    "low_stock",
    "stockout",
    "reorder_point",
    "inventory_adjustment",
    "transfer_created",
    "transfer_completed",
    "receiving_complete",
  ],
  system: [
    "system",
    "system_alert",
    "user_mention",
    "announcement",
    "integration_error",
  ],
};

/* ── Hook ────────────────────────────────────────────────────── */

export interface UseNotificationsReturn {
  /** The full notification list (may be filtered). */
  notifications: NotificationRecord[];
  /** Total unread count (always from the unfiltered set). */
  unreadCount: number;
  /** True during the very first fetch. */
  isLoading: boolean;
  /** Non-null when the last request failed. */
  error: string | null;
  /** Currently active filter pill. */
  activeFilter: NotificationFilter;
  /** Change the active filter pill. */
  setActiveFilter: (filter: NotificationFilter) => void;
  /** Mark a single notification as read. */
  markRead: (id: string) => Promise<void>;
  /** Mark every notification as read. */
  markAllRead: () => Promise<void>;
  /** Force-refresh notifications. */
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;

export function useNotifications(
  token: string | null,
  onUnauthorized: () => void,
): UseNotificationsReturn {
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [allNotifications, setAllNotifications] = React.useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [activeFilter, setActiveFilter] = React.useState<NotificationFilter>("all");

  /* ── Request helper ──────────────────────────────────────── */

  const runRequest = React.useCallback(
    async <T,>(request: () => Promise<T>): Promise<T | null> => {
      try {
        return await request();
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
          return null;
        }
        throw err;
      }
    },
    [onUnauthorized],
  );

  /* ── Fetch ───────────────────────────────────────────────── */

  const fetchData = React.useCallback(async () => {
    if (!token) {
      setAllNotifications([]);
      setUnreadCount(0);
      setIsLoading(false);
      return;
    }

    try {
      const [notifs, count] = await Promise.all([
        runRequest(() => fetchNotifications(token)),
        runRequest(() => fetchUnreadNotificationCount(token)),
      ]);

      if (notifs === null || count === null) return;

      if (isMountedRef.current) {
        setAllNotifications(notifs);
        setUnreadCount(count);
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) setError(parseApiError(err));
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, [runRequest, token]);

  /* ── Initial load ────────────────────────────────────────── */

  React.useEffect(() => {
    void fetchData();
  }, [fetchData]);

  /* ── Polling fallback (30 s) ─────────────────────────────── */

  React.useEffect(() => {
    if (!token || typeof window === "undefined") return;

    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchData();
      }
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(id);
  }, [fetchData, token]);

  /* ── WebSocket for real-time unread count ─────────────────── */

  React.useEffect(() => {
    if (!token || typeof window === "undefined") return;

    // Attempt WS connection — gracefully degrade if server doesn't support it.
    let ws: WebSocket | null = null;
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/notifications?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(wsUrl);

      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data as string) as {
            type: string;
            unreadCount?: number;
          };
          if (data.type === "unread_count_update" && typeof data.unreadCount === "number") {
            if (isMountedRef.current) {
              setUnreadCount(data.unreadCount);
              // Also refresh the full list so new notifications show up
              void fetchData();
            }
          }
        } catch {
          // ignore non-JSON messages
        }
      });

      ws.addEventListener("error", () => {
        // WS not available — polling fallback is already active
      });
    } catch {
      // WebSocket constructor failed — ignore
    }

    return () => {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    };
  }, [fetchData, token]);

  /* ── Filtered view ───────────────────────────────────────── */

  const notifications = React.useMemo(() => {
    if (activeFilter === "all") return allNotifications;
    if (activeFilter === "unread") return allNotifications.filter((n) => !n.isRead);

    const allowedTypes = FILTER_TYPE_MAP[activeFilter];
    if (!allowedTypes) return allNotifications;

    return allNotifications.filter((n) => allowedTypes.includes(n.type));
  }, [allNotifications, activeFilter]);

  /* ── Mutations ───────────────────────────────────────────── */

  const markRead = React.useCallback(
    async (id: string) => {
      if (!token) return;
      try {
        const result = await runRequest(() => markNotificationRead(token, id));
        if (result === null) return;

        // Optimistic update
        setAllNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch (err) {
        if (isMountedRef.current) setError(parseApiError(err));
      }
    },
    [runRequest, token],
  );

  const markAllRead = React.useCallback(async () => {
    if (!token) return;
    try {
      const result = await runRequest(() => markAllNotificationsRead(token));
      if (result === null) return;

      // Optimistic update
      setAllNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch (err) {
      if (isMountedRef.current) setError(parseApiError(err));
    }
  }, [runRequest, token]);

  return {
    notifications,
    unreadCount,
    isLoading,
    error,
    activeFilter,
    setActiveFilter,
    markRead,
    markAllRead,
    refresh: fetchData,
  };
}
