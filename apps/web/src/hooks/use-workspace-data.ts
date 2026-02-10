import * as React from "react";
import type {
  QueueSummary,
  QueueByLoop,
  PartRecord,
  OrderLineByItemSummary,
  NotificationRecord,
} from "@/types";
import {
  isUnauthorized,
  parseApiError,
  fetchQueueSummary,
  fetchQueueByLoop,
  fetchParts,
  fetchOrderLineSummaries,
  fetchNotifications,
  fetchUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/lib/api-client";

export interface WorkspaceData {
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  queueSummary: QueueSummary | null;
  queueByLoop: QueueByLoop;
  parts: PartRecord[];
  partCount: number;
  orderLineByItem: Record<string, OrderLineByItemSummary>;
  notifications: NotificationRecord[];
  unreadNotifications: number;
  refreshAll: () => Promise<void>;
  refreshQueueOnly: () => Promise<void>;
  refreshNotificationsOnly: () => Promise<void>;
  markOneNotificationRead: (id: string) => Promise<void>;
  markEveryNotificationRead: () => Promise<void>;
}

export function useWorkspaceData(token: string | null, onUnauthorized: () => void): WorkspaceData {
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  const [isLoading, setIsLoading] = React.useState(true);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [queueSummary, setQueueSummary] = React.useState<QueueSummary | null>(null);
  const [queueByLoop, setQueueByLoop] = React.useState<QueueByLoop>({
    procurement: [],
    production: [],
    transfer: [],
  });
  const [parts, setParts] = React.useState<PartRecord[]>([]);
  const [partCount, setPartCount] = React.useState(0);
  const [orderLineByItem, setOrderLineByItem] = React.useState<Record<string, OrderLineByItemSummary>>({});
  const [notifications, setNotifications] = React.useState<NotificationRecord[]>([]);
  const [unreadNotifications, setUnreadNotifications] = React.useState(0);

  const runRequest = React.useCallback(
    async <T,>(request: () => Promise<T>): Promise<T | null> => {
      try {
        return await request();
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return null;
        }

        throw error;
      }
    },
    [onUnauthorized],
  );

  const refreshAll = React.useCallback(async () => {
    if (!token) {
      setQueueSummary(null);
      setQueueByLoop({ procurement: [], production: [], transfer: [] });
      setParts([]);
      setPartCount(0);
      setOrderLineByItem({});
      setNotifications([]);
      setUnreadNotifications(0);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsRefreshing(true);

    try {
      const [summaryResult, queueResult, partsResult, notificationsResult, unreadResult] =
        await Promise.all([
          runRequest(() => fetchQueueSummary(token)),
          runRequest(() => fetchQueueByLoop(token)),
          runRequest(() => fetchParts(token)),
          runRequest(() => fetchNotifications(token)),
          runRequest(() => fetchUnreadNotificationCount(token)),
        ]);

      if (
        summaryResult === null ||
        queueResult === null ||
        partsResult === null ||
        notificationsResult === null ||
        unreadResult === null
      ) {
        return;
      }

      setQueueSummary(summaryResult);
      setQueueByLoop(queueResult);
      setParts(partsResult.data ?? []);
      setPartCount(partsResult.pagination.total ?? partsResult.data.length);

      let nextOrderLineByItem: Record<string, OrderLineByItemSummary> = {};
      try {
        const orderLineResult = await runRequest(() => fetchOrderLineSummaries(token));
        if (orderLineResult === null) {
          return;
        }
        nextOrderLineByItem = orderLineResult;
      } catch {
        nextOrderLineByItem = {};
      }
      setOrderLineByItem(nextOrderLineByItem);

      setNotifications(notificationsResult);
      setUnreadNotifications(unreadResult);
      setError(null);
    } catch (error) {
      if (isMountedRef.current) setError(parseApiError(error));
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [runRequest, token]);

  const refreshQueueOnly = React.useCallback(async () => {
    if (!token) return;

    setIsRefreshing(true);
    try {
      const [summaryResult, queueResult] = await Promise.all([
        runRequest(() => fetchQueueSummary(token)),
        runRequest(() => fetchQueueByLoop(token)),
      ]);

      if (summaryResult === null || queueResult === null) {
        return;
      }

      setQueueSummary(summaryResult);
      setQueueByLoop(queueResult);
      setError(null);
    } catch (error) {
      if (isMountedRef.current) setError(parseApiError(error));
    } finally {
      if (isMountedRef.current) setIsRefreshing(false);
    }
  }, [runRequest, token]);

  const refreshNotificationsOnly = React.useCallback(async () => {
    if (!token) return;

    setIsRefreshing(true);
    try {
      const [notificationResult, unreadResult] = await Promise.all([
        runRequest(() => fetchNotifications(token)),
        runRequest(() => fetchUnreadNotificationCount(token)),
      ]);

      if (notificationResult === null || unreadResult === null) {
        return;
      }

      setNotifications(notificationResult);
      setUnreadNotifications(unreadResult);
      setError(null);
    } catch (error) {
      if (isMountedRef.current) setError(parseApiError(error));
    } finally {
      if (isMountedRef.current) setIsRefreshing(false);
    }
  }, [runRequest, token]);

  const markOneNotificationRead = React.useCallback(
    async (id: string) => {
      if (!token) return;

      try {
        const result = await runRequest(() => markNotificationRead(token, id));
        if (result === null) return;

        await refreshNotificationsOnly();
      } catch (error) {
        if (isMountedRef.current) setError(parseApiError(error));
      }
    },
    [refreshNotificationsOnly, runRequest, token],
  );

  const markEveryNotificationRead = React.useCallback(async () => {
    if (!token) return;

    try {
      const result = await runRequest(() => markAllNotificationsRead(token));
      if (result === null) return;

      await refreshNotificationsOnly();
    } catch (error) {
      if (isMountedRef.current) setError(parseApiError(error));
    }
  }, [refreshNotificationsOnly, runRequest, token]);

  React.useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  return {
    isLoading,
    isRefreshing,
    error,
    queueSummary,
    queueByLoop,
    parts,
    partCount,
    orderLineByItem,
    notifications,
    unreadNotifications,
    refreshAll,
    refreshQueueOnly,
    refreshNotificationsOnly,
    markOneNotificationRead,
    markEveryNotificationRead,
  };
}
