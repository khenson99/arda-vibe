/**
 * CSV Export Service (Ticket #170)
 *
 * Streaming CSV generation for KPI drilldowns and summary exports.
 * Implements RFC 4180-compliant CSV encoding with formula injection sanitization.
 */

import { format } from '@fast-csv/format';
import { Transform } from 'stream';

// ─── Types ────────────────────────────────────────────────────────────

export interface CSVExportOptions {
  headers: string[];
  filename: string;
}

export interface KPIExportContext {
  kpiName: string;
  facilityId?: string;
  facilityName?: string;
  dateFrom?: string;
  dateTo?: string;
}

// ─── CSV Sanitization ────────────────────────────────────────────────

/**
 * Sanitize a cell value to prevent CSV formula injection.
 * Prepends a single quote (') to values beginning with =, +, -, or @.
 *
 * Per OWASP guidelines, this prevents spreadsheet applications from
 * interpreting cell values as formulas.
 */
export function sanitizeCSVCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);
  const firstChar = str.charAt(0);

  // Formula injection risk: values starting with =, +, -, or @
  if (firstChar === '=' || firstChar === '+' || firstChar === '-' || firstChar === '@') {
    return `'${str}`;
  }

  return str;
}

/**
 * Sanitize an entire row of CSV data.
 */
export function sanitizeCSVRow(row: Record<string, unknown>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    sanitized[key] = sanitizeCSVCell(value);
  }
  return sanitized;
}

// ─── Filename Generation ─────────────────────────────────────────────

/**
 * Generate a safe, descriptive filename for a KPI export.
 * Format: arda-{kpi-name}-{facility}-{dateRange}-{timestamp}.csv
 *
 * Example: arda-scrap-rate-facility-austin-2024-01-01-to-2024-01-31-20240201T143022Z.csv
 */
export function generateExportFilename(context: KPIExportContext): string {
  const parts: string[] = ['arda'];

  // KPI name (kebab-case)
  parts.push(context.kpiName.toLowerCase().replace(/\s+/g, '-'));

  // Facility (if provided)
  if (context.facilityName) {
    const safeFacility = context.facilityName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    parts.push('facility', safeFacility);
  }

  // Date range (if provided)
  if (context.dateFrom && context.dateTo) {
    const from = context.dateFrom.split('T')[0]; // YYYY-MM-DD
    const to = context.dateTo.split('T')[0];
    parts.push(`${from}-to-${to}`);
  } else if (context.dateFrom) {
    const from = context.dateFrom.split('T')[0];
    parts.push(`from-${from}`);
  } else if (context.dateTo) {
    const to = context.dateTo.split('T')[0];
    parts.push(`to-${to}`);
  }

  // Timestamp (ISO 8601 without colons for filesystem safety)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '');
  parts.push(timestamp);

  return `${parts.join('-')}.csv`;
}

// ─── Streaming CSV Transform ─────────────────────────────────────────

/**
 * Create a streaming CSV transform that:
 * 1. Sanitizes all cell values to prevent formula injection
 * 2. Applies RFC 4180-compliant CSV encoding
 * 3. Outputs UTF-8 encoded CSV data
 *
 * Usage:
 *   const csvStream = createCSVStream(['col1', 'col2']);
 *   const readable = Readable.from(rows);
 *   readable.pipe(csvStream).pipe(res);
 */
export function createCSVStream(headers: string[]): Transform {
  const csvFormatter = format({
    headers,
    writeBOM: true, // UTF-8 BOM for Excel compatibility
    quoteColumns: true, // Quote all columns for safety
    quoteHeaders: true,
  });

  // Create a transform that sanitizes rows before formatting
  const sanitizeTransform = new Transform({
    objectMode: true,
    transform(row: Record<string, unknown>, _encoding, callback) {
      try {
        const sanitized = sanitizeCSVRow(row);
        callback(null, sanitized);
      } catch (err) {
        callback(err as Error);
      }
    },
  });

  // Chain: input rows → sanitize → format → CSV output
  return sanitizeTransform.pipe(csvFormatter);
}

// ─── Summary Export Helpers ─────────────────────────────────────────

export interface KPISummaryRow {
  kpiName: string;
  kpiValue: string | number;
  facilityId?: string;
  facilityName?: string;
  dateFrom?: string;
  dateTo?: string;
  exportedAt: string;
}

/**
 * Create a single-row CSV summary for KPI snapshot exports.
 * This is useful for "Export Summary" features that capture all KPI values at once.
 */
export function createKPISummaryRow(
  kpiValues: Record<string, string | number>,
  context: KPIExportContext
): KPISummaryRow[] {
  const exportedAt = new Date().toISOString();

  return Object.entries(kpiValues).map(([kpiName, kpiValue]) => ({
    kpiName,
    kpiValue,
    facilityId: context.facilityId,
    facilityName: context.facilityName,
    dateFrom: context.dateFrom,
    dateTo: context.dateTo,
    exportedAt,
  }));
}
