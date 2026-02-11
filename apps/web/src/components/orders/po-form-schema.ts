/**
 * POFormSchema — Zod validation for PO create/edit forms
 *
 * Provides schema-based validation for purchase order form payloads,
 * including line-level numeric constraints and required field checks.
 */

import { z } from "zod/v4";

// ─── Line Item Schema ─────────────────────────────────────────────────

export const poLineSchema = z.object({
  partId: z.string().min(1, "Part is required"),
  partName: z.string().optional(),
  partNumber: z.string().optional(),
  lineNumber: z.number().int().min(1, "Line number must be ≥ 1"),
  quantityOrdered: z.number().int().min(1, "Quantity must be at least 1"),
  unitCost: z.number().min(0, "Unit cost cannot be negative"),
  notes: z.string().nullable().optional(),
  kanbanCardId: z.string().nullable().optional(),
});

// ─── Form Input Schema ────────────────────────────────────────────────

export const poFormSchema = z.object({
  supplierId: z.string().min(1, "Supplier is required"),
  facilityId: z.string().min(1, "Facility is required"),
  orderDate: z.string().optional(),
  expectedDeliveryDate: z.string().min(1, "Expected delivery date is required"),
  currency: z.string().optional(),
  notes: z.string().nullable().optional(),
  internalNotes: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  shippingTerms: z.string().nullable().optional(),
  lines: z.array(poLineSchema).min(1, "At least one line item is required"),
});

export type POFormSchemaInput = z.infer<typeof poFormSchema>;

/**
 * Validate form data and return flattened error map keyed by field name.
 * Line-level errors use `line-{idx}-{field}` keys for compatibility
 * with the existing POLineEditor validationErrors prop.
 */
export function validatePOForm(
  data: unknown,
): { success: true; data: POFormSchemaInput } | { success: false; errors: Record<string, string> } {
  const result = poFormSchema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path;
    if (path[0] === "lines" && typeof path[1] === "number") {
      // Map line-level errors: lines.0.quantityOrdered → line-0-quantity
      const idx = path[1];
      const field = path[2] as string;
      const key = field === "quantityOrdered"
        ? `line-${idx}-quantity`
        : field === "unitCost"
          ? `line-${idx}-unitCost`
          : field === "partId"
            ? `line-${idx}-partId`
            : `line-${idx}-${field}`;
      errors[key] = issue.message;
    } else if (typeof path[0] === "string") {
      errors[path[0]] = issue.message;
    } else {
      // Top-level array error (e.g., "At least one line item is required")
      errors.lines = issue.message;
    }
  }

  return { success: false, errors };
}
