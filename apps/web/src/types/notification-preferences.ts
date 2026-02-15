/* ── Notification Preference Types ─────────────────────────── */

/** Channels available for notification delivery */
export type NotificationChannel = "inApp" | "email" | "webhook";

/** Per-channel toggle state for a single notification type */
export interface ChannelPreferences {
  inApp: boolean;
  email: boolean;
  webhook: boolean;
}

/** Full preferences map: notificationType -> channel preferences */
export type NotificationPreferencesMap = Record<string, ChannelPreferences>;

/** API response shape from GET /api/notifications/preferences */
export interface NotificationPreferencesResponse {
  data: NotificationPreferencesMap;
}

/** Digest frequency options */
export type DigestFrequency = "realtime" | "hourly" | "daily" | "weekly";

/** Category grouping for the preference matrix */
export interface NotificationCategory {
  id: string;
  label: string;
  types: NotificationType[];
}

/** Individual notification type metadata for display */
export interface NotificationType {
  id: string;
  label: string;
  description: string;
}

/* ── Notification type metadata catalog ─────────────────────── */

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  {
    id: "procurement",
    label: "Procurement",
    types: [
      {
        id: "po_created",
        label: "PO Created",
        description: "When a purchase order is created",
      },
      {
        id: "po_sent",
        label: "PO Sent",
        description: "When a purchase order is sent to a supplier",
      },
      {
        id: "po_received",
        label: "PO Received",
        description: "When goods from a purchase order are received",
      },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    types: [
      {
        id: "card_triggered",
        label: "Card Triggered",
        description: "When a kanban card signals a reorder",
      },
      {
        id: "stockout_warning",
        label: "Stockout Warning",
        description: "When inventory drops below minimum levels",
      },
      {
        id: "relowisa_recommendation",
        label: "ReLoWiSa Recommendation",
        description: "Automated reorder recommendations",
      },
      {
        id: "receiving_completed",
        label: "Receiving Completed",
        description: "When a receiving session is completed",
      },
    ],
  },
  {
    id: "production",
    label: "Production",
    types: [
      {
        id: "wo_status_change",
        label: "Work Order Status",
        description: "When a work order changes status",
      },
      {
        id: "production_hold",
        label: "Production Hold",
        description: "When production is placed on hold",
      },
    ],
  },
  {
    id: "transfers",
    label: "Transfers",
    types: [
      {
        id: "transfer_status_change",
        label: "Transfer Status",
        description: "When a transfer order changes status",
      },
    ],
  },
  {
    id: "system",
    label: "System",
    types: [
      {
        id: "exception_alert",
        label: "Exception Alert",
        description: "Critical exceptions requiring attention",
      },
      {
        id: "system_alert",
        label: "System Alert",
        description: "Platform-level system notifications",
      },
      {
        id: "automation_escalated",
        label: "Automation Escalated",
        description: "When an automated process requires human review",
      },
    ],
  },
];

/** Digest frequency options with labels */
export const DIGEST_FREQUENCY_OPTIONS: {
  value: DigestFrequency;
  label: string;
  description: string;
}[] = [
  {
    value: "realtime",
    label: "Real-time",
    description: "Receive emails as events happen",
  },
  {
    value: "hourly",
    label: "Hourly",
    description: "Batch digest every hour",
  },
  {
    value: "daily",
    label: "Daily",
    description: "One digest per day at 8:00 AM",
  },
  {
    value: "weekly",
    label: "Weekly",
    description: "Weekly summary on Monday mornings",
  },
];
