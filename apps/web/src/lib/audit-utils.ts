/**
 * Audit utility helpers — human-readable labels, formatters, and diff logic
 * for the admin audit viewer and entity activity sections.
 */

/* ── Action → human-readable label ──────────────────────────── */

const ACTION_LABELS: Record<string, string> = {
  // Purchase orders
  "po.created": "Created purchase order",
  "po.updated": "Updated purchase order",
  "po.status_changed": "Changed PO status",
  "po.deleted": "Deleted purchase order",
  "po.approved": "Approved purchase order",
  "po.rejected": "Rejected purchase order",
  "po.submitted": "Submitted purchase order",
  "po.cancelled": "Cancelled purchase order",
  "po.received": "Received purchase order",
  // Work orders
  "wo.created": "Created work order",
  "wo.updated": "Updated work order",
  "wo.status_changed": "Changed WO status",
  "wo.deleted": "Deleted work order",
  "wo.started": "Started work order",
  "wo.completed": "Completed work order",
  "wo.cancelled": "Cancelled work order",
  // Transfer orders
  "to.created": "Created transfer order",
  "to.updated": "Updated transfer order",
  "to.status_changed": "Changed TO status",
  "to.deleted": "Deleted transfer order",
  "to.shipped": "Shipped transfer order",
  "to.received": "Received transfer order",
  // Kanban
  "card.created": "Created card",
  "card.updated": "Updated card",
  "card.triggered": "Triggered card",
  "card.transitioned": "Transitioned card stage",
  "card.archived": "Archived card",
  "card.deleted": "Deleted card",
  // Loop
  "loop.created": "Created loop",
  "loop.updated": "Updated loop",
  "loop.deleted": "Deleted loop",
  // Parts / catalog
  "part.created": "Created part",
  "part.updated": "Updated part",
  "part.deleted": "Deleted part",
  "supplier.created": "Created supplier",
  "supplier.updated": "Updated supplier",
  "supplier.deleted": "Deleted supplier",
  "category.created": "Created category",
  "category.updated": "Updated category",
  "category.deleted": "Deleted category",
  "bom.created": "Created BOM entry",
  "bom.updated": "Updated BOM entry",
  "bom.deleted": "Deleted BOM entry",
  // Notifications
  "notification.preference_updated": "Updated notification preference",
  "notification.dismissed": "Dismissed notification",
  // Auth
  "user.login": "Logged in",
  "user.logout": "Logged out",
  "user.created": "Created user",
  "user.updated": "Updated user",
  // Receipts
  "receipt.created": "Created receipt",
  "receipt.updated": "Updated receipt",
  // Receiving
  "exception.created": "Created receiving exception",
  "exception.resolved": "Resolved receiving exception",
};

export function formatActionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  // Fallback: replace dots and underscores with spaces, title case
  return action
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── Entity type → human-readable name ──────────────────────── */

const ENTITY_TYPE_LABELS: Record<string, string> = {
  purchase_order: "Purchase Order",
  work_order: "Work Order",
  transfer_order: "Transfer Order",
  kanban_card: "Kanban Card",
  kanban_loop: "Kanban Loop",
  part: "Part",
  supplier: "Supplier",
  category: "Category",
  bom_entry: "BOM Entry",
  user: "User",
  receipt: "Receipt",
  receiving_exception: "Receiving Exception",
  notification_preference: "Notification Preference",
  notification: "Notification",
  facility: "Facility",
  storage_location: "Storage Location",
};

export function formatEntityType(entityType: string): string {
  if (ENTITY_TYPE_LABELS[entityType]) return ENTITY_TYPE_LABELS[entityType];
  return entityType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── Entity type → detail page route ────────────────────────── */

export function entityDetailPath(
  entityType: string,
  entityId: string,
): string | null {
  switch (entityType) {
    case "purchase_order":
      return `/orders/po/${entityId}`;
    case "work_order":
      return `/orders/wo/${entityId}`;
    case "transfer_order":
      return `/orders/to/${entityId}`;
    case "kanban_card":
      return `/scan/${entityId}`;
    case "kanban_loop":
      return `/loops/${entityId}`;
    case "part":
      return `/parts?partId=${entityId}`;
    default:
      return null;
  }
}

/* ── Relative time formatting ───────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();

  if (diff < MINUTE) return "just now";
  if (diff < HOUR) {
    const mins = Math.floor(diff / MINUTE);
    return `${mins}m ago`;
  }
  if (diff < DAY) {
    const hrs = Math.floor(diff / HOUR);
    return `${hrs}h ago`;
  }
  if (diff < DAY * 7) {
    const days = Math.floor(diff / DAY);
    return `${days}d ago`;
  }

  return new Date(isoString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatTimestamp(isoString: string): string {
  return new Date(isoString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/* ── JSON diff helpers ──────────────────────────────────────── */

export interface DiffEntry {
  key: string;
  type: "added" | "removed" | "changed" | "unchanged";
  oldValue?: unknown;
  newValue?: unknown;
}

export function computeJsonDiff(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): DiffEntry[] {
  const prev = previous ?? {};
  const curr = next ?? {};
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const entries: DiffEntry[] = [];

  for (const key of allKeys) {
    const oldVal = prev[key];
    const newVal = curr[key];

    if (!(key in prev)) {
      entries.push({ key, type: "added", newValue: newVal });
    } else if (!(key in curr)) {
      entries.push({ key, type: "removed", oldValue: oldVal });
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      entries.push({ key, type: "changed", oldValue: oldVal, newValue: newVal });
    }
    // Skip unchanged fields — they add noise
  }

  return entries;
}

export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/* ── Audit entity type → backend mapping ────────────────────── */

/** Maps route entity types to audit entity type strings for the API call. */
export function routeEntityTypeToAudit(routeType: string): string {
  const mapping: Record<string, string> = {
    po: "purchase_order",
    wo: "work_order",
    to: "transfer_order",
    card: "kanban_card",
    loop: "kanban_loop",
    part: "part",
  };
  return mapping[routeType] ?? routeType;
}
