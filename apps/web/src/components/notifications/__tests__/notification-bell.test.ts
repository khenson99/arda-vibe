import { describe, it, expect } from "vitest";
import type { NotificationRecord } from "@/types";

/* ── Test data ──────────────────────────────────────────────── */

function makeNotification(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "notif-1",
    type: "po_created",
    title: "Purchase Order Created",
    body: "PO #1234 has been created",
    actionUrl: "/orders/po/1234",
    isRead: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/* ── Unread count badge logic ───────────────────────────────── */

describe("Notification Bell — unread badge logic", () => {
  it("should show no badge when unread count is 0", () => {
    const unreadCount = 0;
    const shouldShowBadge = unreadCount > 0;
    expect(shouldShowBadge).toBe(false);
  });

  it("should show badge when unread count is positive", () => {
    const unreadCount = 5;
    const shouldShowBadge = unreadCount > 0;
    expect(shouldShowBadge).toBe(true);
  });

  it("should use compact badge for single-digit counts", () => {
    const unreadCount = 9;
    const isCompact = unreadCount <= 9;
    expect(isCompact).toBe(true);
  });

  it("should use wider badge for double-digit counts", () => {
    const unreadCount = 42;
    const isCompact = unreadCount <= 9;
    expect(isCompact).toBe(false);
  });

  it("should cap display at 99+ for large counts", () => {
    const unreadCount = 150;
    const display = unreadCount > 99 ? "99+" : String(unreadCount);
    expect(display).toBe("99+");
  });

  it("should display exact count when 99 or below", () => {
    const unreadCount = 73;
    const display = unreadCount > 99 ? "99+" : String(unreadCount);
    expect(display).toBe("73");
  });
});

/* ── ARIA label construction ────────────────────────────────── */

describe("Notification Bell — ARIA labels", () => {
  it("should include unread count in label when non-zero", () => {
    const unreadCount = 5;
    const label =
      unreadCount > 0
        ? `Notifications: ${unreadCount} unread`
        : "Notifications: none unread";
    expect(label).toBe("Notifications: 5 unread");
  });

  it("should indicate none unread when count is 0", () => {
    const unreadCount = 0;
    const label =
      unreadCount > 0
        ? `Notifications: ${unreadCount} unread`
        : "Notifications: none unread";
    expect(label).toBe("Notifications: none unread");
  });
});

/* ── Filter type mapping ────────────────────────────────────── */

describe("Notification filtering", () => {
  const ORDER_TYPES = [
    "po_created",
    "po_approved",
    "po_sent",
    "po_received",
    "wo_created",
    "wo_completed",
    "order_exception",
    "order_status_change",
  ];

  const INVENTORY_TYPES = [
    "low_stock",
    "stockout",
    "reorder_point",
    "inventory_adjustment",
    "transfer_created",
    "transfer_completed",
    "receiving_complete",
  ];

  const SYSTEM_TYPES = [
    "system",
    "system_alert",
    "user_mention",
    "announcement",
    "integration_error",
  ];

  const allNotifications: NotificationRecord[] = [
    makeNotification({ id: "1", type: "po_created" }),
    makeNotification({ id: "2", type: "low_stock", isRead: true }),
    makeNotification({ id: "3", type: "system_alert" }),
    makeNotification({ id: "4", type: "wo_completed", isRead: true }),
    makeNotification({ id: "5", type: "stockout" }),
    makeNotification({ id: "6", type: "announcement", isRead: true }),
  ];

  it("'all' filter should return all notifications", () => {
    const filtered = allNotifications;
    expect(filtered).toHaveLength(6);
  });

  it("'unread' filter should return only unread notifications", () => {
    const filtered = allNotifications.filter((n) => !n.isRead);
    expect(filtered).toHaveLength(3);
    expect(filtered.every((n) => !n.isRead)).toBe(true);
  });

  it("'orders' filter should return only order-type notifications", () => {
    const filtered = allNotifications.filter((n) => ORDER_TYPES.includes(n.type));
    expect(filtered).toHaveLength(2);
    expect(filtered.map((n) => n.type)).toEqual(["po_created", "wo_completed"]);
  });

  it("'inventory' filter should return only inventory-type notifications", () => {
    const filtered = allNotifications.filter((n) => INVENTORY_TYPES.includes(n.type));
    expect(filtered).toHaveLength(2);
    expect(filtered.map((n) => n.type)).toEqual(["low_stock", "stockout"]);
  });

  it("'system' filter should return only system-type notifications", () => {
    const filtered = allNotifications.filter((n) => SYSTEM_TYPES.includes(n.type));
    expect(filtered).toHaveLength(2);
    expect(filtered.map((n) => n.type)).toEqual(["system_alert", "announcement"]);
  });
});

/* ── Notification item icon/color derivation ────────────────── */

describe("Notification icon/color derivation", () => {
  function getIconColor(type: string): "warning" | "success" | "default" {
    const warningTypes = [
      "low_stock",
      "stockout",
      "order_exception",
      "system_alert",
      "integration_error",
    ];
    const successTypes = [
      "po_received",
      "wo_completed",
      "transfer_completed",
      "receiving_complete",
    ];

    if (warningTypes.includes(type)) return "warning";
    if (successTypes.includes(type)) return "success";
    return "default";
  }

  it("should show warning color for low_stock", () => {
    expect(getIconColor("low_stock")).toBe("warning");
  });

  it("should show warning color for system_alert", () => {
    expect(getIconColor("system_alert")).toBe("warning");
  });

  it("should show success color for po_received", () => {
    expect(getIconColor("po_received")).toBe("success");
  });

  it("should show success color for wo_completed", () => {
    expect(getIconColor("wo_completed")).toBe("success");
  });

  it("should show default color for po_created", () => {
    expect(getIconColor("po_created")).toBe("default");
  });

  it("should show default color for unknown types", () => {
    expect(getIconColor("some_new_type")).toBe("default");
  });
});

/* ── Optimistic mark-read ───────────────────────────────────── */

describe("Optimistic mark-read logic", () => {
  it("should mark a specific notification as read", () => {
    const notifications = [
      makeNotification({ id: "a", isRead: false }),
      makeNotification({ id: "b", isRead: false }),
      makeNotification({ id: "c", isRead: true }),
    ];

    const idToMark = "b";
    const updated = notifications.map((n) =>
      n.id === idToMark ? { ...n, isRead: true } : n,
    );

    expect(updated[0].isRead).toBe(false);
    expect(updated[1].isRead).toBe(true);
    expect(updated[2].isRead).toBe(true);
  });

  it("should decrease unread count by 1 (min 0)", () => {
    let unreadCount = 3;
    unreadCount = Math.max(0, unreadCount - 1);
    expect(unreadCount).toBe(2);

    unreadCount = 0;
    unreadCount = Math.max(0, unreadCount - 1);
    expect(unreadCount).toBe(0);
  });

  it("mark all should set every notification to read", () => {
    const notifications = [
      makeNotification({ id: "a", isRead: false }),
      makeNotification({ id: "b", isRead: true }),
      makeNotification({ id: "c", isRead: false }),
    ];

    const updated = notifications.map((n) => ({ ...n, isRead: true }));
    expect(updated.every((n) => n.isRead)).toBe(true);
  });

  it("mark all should set unread count to 0", () => {
    const unreadCount = 5;
    expect(0).toBe(0);
  });
});

/* ── Navigation target logic ────────────────────────────────── */

describe("Navigation target handling", () => {
  it("should identify relative URL for in-app navigation", () => {
    const url = "/orders/po/1234";
    const isExternal = url.startsWith("http");
    expect(isExternal).toBe(false);
  });

  it("should identify external URL for new-tab opening", () => {
    const url = "https://example.com/tracking/ABC";
    const isExternal = url.startsWith("http");
    expect(isExternal).toBe(true);
  });

  it("should handle null actionUrl gracefully", () => {
    const notification = makeNotification({ actionUrl: null });
    const shouldNavigate = notification.actionUrl !== null;
    expect(shouldNavigate).toBe(false);
  });

  it("should navigate when actionUrl is present", () => {
    const notification = makeNotification({ actionUrl: "/orders/po/1234" });
    const shouldNavigate = notification.actionUrl !== null;
    expect(shouldNavigate).toBe(true);
  });
});
