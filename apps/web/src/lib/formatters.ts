import { DATE_TIME_FORMATTER } from "./constants";
import type { LoopType, QueueCard } from "@/types";
import { LOOP_META } from "@/types";

export function formatRelativeTime(isoTimestamp: string): string {
  const timestamp = new Date(isoTimestamp).getTime();
  const deltaMs = timestamp - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60000);

  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (Math.abs(deltaMinutes) < 60) {
    return formatter.format(deltaMinutes, "minute");
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) {
    return formatter.format(deltaHours, "hour");
  }

  const deltaDays = Math.round(deltaHours / 24);
  return formatter.format(deltaDays, "day");
}

export function formatLoopType(loopType: string): string {
  if (loopType in LOOP_META) {
    return LOOP_META[loopType as LoopType].label;
  }

  return loopType;
}

export function formatDateTime(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return "\u2014";
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return "\u2014";
  return DATE_TIME_FORMATTER.format(parsed).replace(",", "");
}

export function formatReadableLabel(value: string | null | undefined): string {
  if (!value) return "\u2014";
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * Format a status string using a known-status map for consistent display.
 * Falls back to formatReadableLabel for unknown statuses.
 */
const STATUS_DISPLAY_MAP: Record<string, string> = {
  // Kanban card stages
  created: "Created",
  triggered: "Triggered",
  ordered: "Ordered",
  in_transit: "In Transit",
  received: "Received",
  restocked: "Restocked",
  // PO statuses
  draft: "Draft",
  pending_approval: "Pending Approval",
  approved: "Approved",
  sent: "Sent",
  acknowledged: "Acknowledged",
  partially_received: "Partially Received",
  closed: "Closed",
  cancelled: "Cancelled",
  // WO statuses
  scheduled: "Scheduled",
  in_progress: "In Progress",
  on_hold: "On Hold",
  completed: "Completed",
  // Transfer statuses
  requested: "Requested",
  picking: "Picking",
  shipped: "Shipped",
  // Routing step
  pending: "Pending",
  complete: "Complete",
  skipped: "Skipped",
  // Item states
  active: "Active",
  inactive: "Inactive",
  // Generic
  new: "New",
  committed: "Committed",
  receiving: "Receiving",
  depleted: "Depleted",
  withdrawn: "Withdrawn",
  accepted: "Accepted",
};

export function formatStatus(value: string | null | undefined): string {
  if (!value) return "\u2014";
  const normalized = value.toLowerCase().trim();
  return STATUS_DISPLAY_MAP[normalized] ?? formatReadableLabel(value);
}

export function formatNumericValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "\u2014";
  return value.toLocaleString();
}

export function formatQuantity(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
  return `${value.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

export function formatMoney(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "\u2014";
  const normalizedCurrency = currency?.trim().toUpperCase() || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${normalizedCurrency} ${value.toFixed(2)}`;
  }
}

export function queueAgingHours(card: QueueCard): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(card.currentStageEnteredAt).getTime()) / (1000 * 60 * 60)),
  );
}
