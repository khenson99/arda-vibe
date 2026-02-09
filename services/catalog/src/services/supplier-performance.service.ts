/**
 * Supplier Performance Metrics Service
 *
 * Computes supplier performance grades from existing PO lifecycle data.
 * Uses a "read model" approach — all metrics are derived from timestamps
 * on the purchase_orders and purchase_order_lines tables.
 *
 * Key metrics:
 *  - On-Time Delivery Rate (OTD): % of POs where actual <= expected delivery
 *  - Average Lead Time: mean(sentAt -> actualDeliveryDate) in days
 *  - Lead Time Variance: mean(actual - expected) in days (positive = late)
 *  - Quality Acceptance Rate: accepted / (accepted + damaged + rejected)
 *
 * Grade:
 *  A: OTD >= 95% AND quality >= 98%
 *  B: OTD >= 85% AND quality >= 95%
 *  C: OTD >= 70% AND quality >= 90%
 *  D: below C thresholds
 *  N/A: fewer than 3 completed POs (insufficient data)
 */

// ─── Types ───────────────────────────────────────────────────────────

export type SupplierGrade = 'A' | 'B' | 'C' | 'D' | 'N/A';

export interface SupplierPerformanceMetrics {
  supplierId: string;
  supplierName: string;
  grade: SupplierGrade;
  /** Total completed POs (received or closed). */
  completedPOs: number;
  /** Total active POs (draft through acknowledged). */
  activePOs: number;
  /** On-time delivery rate as a percentage (0-100). */
  onTimeDeliveryRate: number | null;
  /** Average actual lead time in days. */
  avgLeadTimeDays: number | null;
  /** Average variance from expected delivery in days (positive = late). */
  avgLeadTimeVarianceDays: number | null;
  /** Quality acceptance rate as percentage (0-100). */
  qualityRate: number | null;
  /** Total parts this supplier provides. */
  partCount: number;
  /** Stated lead time from supplier profile. */
  statedLeadTimeDays: number | null;
}

export interface LeadTimeTrendPoint {
  month: string;   // YYYY-MM
  avgLeadTimeDays: number;
  poCount: number;
  onTimeRate: number;
}

// ─── Pure Helper Functions ───────────────────────────────────────────

/**
 * Calculate lead time in calendar days between two dates.
 * Returns null if either date is missing.
 */
export function calculateLeadTimeDays(
  sentAt: Date | null,
  deliveredAt: Date | null
): number | null {
  if (!sentAt || !deliveredAt) return null;

  const msPerDay = 1000 * 60 * 60 * 24;
  // Normalize to midnight UTC to get calendar day difference
  const sentDay = Date.UTC(sentAt.getUTCFullYear(), sentAt.getUTCMonth(), sentAt.getUTCDate());
  const deliveredDay = Date.UTC(deliveredAt.getUTCFullYear(), deliveredAt.getUTCMonth(), deliveredAt.getUTCDate());

  return Math.round((deliveredDay - sentDay) / msPerDay);
}

/**
 * Determine if a delivery was on time.
 * On time = actualDeliveryDate <= expectedDeliveryDate (comparing calendar days).
 */
export function isOnTimeDelivery(
  actualDeliveryDate: Date | null,
  expectedDeliveryDate: Date | null
): boolean | null {
  if (!actualDeliveryDate || !expectedDeliveryDate) return null;

  const actualDay = Date.UTC(actualDeliveryDate.getUTCFullYear(), actualDeliveryDate.getUTCMonth(), actualDeliveryDate.getUTCDate());
  const expectedDay = Date.UTC(expectedDeliveryDate.getUTCFullYear(), expectedDeliveryDate.getUTCMonth(), expectedDeliveryDate.getUTCDate());

  return actualDay <= expectedDay;
}

/**
 * Calculate lead time variance in days.
 * Positive = late, negative = early, zero = on time.
 */
export function calculateLeadTimeVariance(
  actualDeliveryDate: Date | null,
  expectedDeliveryDate: Date | null
): number | null {
  if (!actualDeliveryDate || !expectedDeliveryDate) return null;

  const msPerDay = 1000 * 60 * 60 * 24;
  const actualDay = Date.UTC(actualDeliveryDate.getUTCFullYear(), actualDeliveryDate.getUTCMonth(), actualDeliveryDate.getUTCDate());
  const expectedDay = Date.UTC(expectedDeliveryDate.getUTCFullYear(), expectedDeliveryDate.getUTCMonth(), expectedDeliveryDate.getUTCDate());

  return Math.round((actualDay - expectedDay) / msPerDay);
}

/**
 * Compute supplier grade from OTD rate and quality rate.
 * Returns 'N/A' if fewer than minCompletedPOs completed orders.
 */
export function computeGrade(
  onTimeDeliveryRate: number | null,
  qualityRate: number | null,
  completedPOs: number,
  minCompletedPOs: number = 3
): SupplierGrade {
  if (completedPOs < minCompletedPOs) return 'N/A';

  // Default to 0 if null (no data available)
  const otd = onTimeDeliveryRate ?? 0;
  const quality = qualityRate ?? 0;

  if (otd >= 95 && quality >= 98) return 'A';
  if (otd >= 85 && quality >= 95) return 'B';
  if (otd >= 70 && quality >= 90) return 'C';
  return 'D';
}

/**
 * Compute average from an array of numbers, ignoring nulls.
 */
export function safeAverage(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  const sum = valid.reduce((a, b) => a + b, 0);
  return Math.round((sum / valid.length) * 100) / 100;
}
