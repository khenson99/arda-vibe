/**
 * Tests for PO form validation schema (po-form-schema.ts)
 *
 * Covers:
 * - Valid payloads pass validation
 * - Required top-level fields produce correct error keys
 * - Line-level errors use `line-{idx}-{field}` format
 * - Edge cases (empty lines array, zero/negative values, etc.)
 */

import { describe, it, expect } from "vitest";
import { validatePOForm, poFormSchema, poLineSchema } from "../po-form-schema";

// ─── Fixtures ──────────────────────────────────────────────────────────

const VALID_LINE = {
  partId: "part-001",
  partName: "Widget A",
  partNumber: "WDG-001",
  lineNumber: 1,
  quantityOrdered: 10,
  unitCost: 5.5,
  notes: null,
  kanbanCardId: null,
};

const VALID_PAYLOAD = {
  supplierId: "sup-001",
  facilityId: "fac-001",
  orderDate: "2025-06-01",
  expectedDeliveryDate: "2025-07-01",
  currency: "USD",
  notes: "Test order",
  internalNotes: "Internal memo",
  paymentTerms: "Net 30",
  shippingTerms: "FOB",
  lines: [VALID_LINE],
};

// ─── Top-Level Schema Validation ───────────────────────────────────────

describe("validatePOForm", () => {
  describe("valid payloads", () => {
    it("accepts a fully populated payload", () => {
      const result = validatePOForm(VALID_PAYLOAD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.supplierId).toBe("sup-001");
        expect(result.data.lines).toHaveLength(1);
      }
    });

    it("accepts a minimal payload (only required fields)", () => {
      const minimal = {
        supplierId: "sup-001",
        facilityId: "fac-001",
        expectedDeliveryDate: "2025-07-01",
        lines: [
          {
            partId: "part-001",
            lineNumber: 1,
            quantityOrdered: 1,
            unitCost: 0,
          },
        ],
      };
      const result = validatePOForm(minimal);
      expect(result.success).toBe(true);
    });

    it("accepts null/undefined optional fields", () => {
      const payload = {
        ...VALID_PAYLOAD,
        notes: null,
        internalNotes: null,
        paymentTerms: null,
        shippingTerms: null,
        orderDate: undefined,
        currency: undefined,
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(true);
    });
  });

  // ─── Required Field Errors ───────────────────────────────────────────

  describe("required field errors", () => {
    it("rejects missing supplierId", () => {
      const result = validatePOForm({ ...VALID_PAYLOAD, supplierId: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.supplierId).toBeDefined();
      }
    });

    it("rejects missing facilityId", () => {
      const result = validatePOForm({ ...VALID_PAYLOAD, facilityId: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.facilityId).toBeDefined();
      }
    });

    it("rejects missing expectedDeliveryDate", () => {
      const result = validatePOForm({
        ...VALID_PAYLOAD,
        expectedDeliveryDate: "",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.expectedDeliveryDate).toBeDefined();
      }
    });

    it("rejects empty lines array", () => {
      const result = validatePOForm({ ...VALID_PAYLOAD, lines: [] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.lines).toBeDefined();
        expect(result.errors.lines).toContain("At least one line item");
      }
    });
  });

  // ─── Line-Level Error Key Format ─────────────────────────────────────

  describe("line-level error keys", () => {
    it("uses line-{idx}-partId format for missing partId", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [{ ...VALID_LINE, partId: "" }],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors["line-0-partId"]).toBeDefined();
      }
    });

    it("uses line-{idx}-quantity format for invalid quantity", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [{ ...VALID_LINE, quantityOrdered: 0 }],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors["line-0-quantity"]).toBeDefined();
      }
    });

    it("uses line-{idx}-unitCost format for negative unit cost", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [{ ...VALID_LINE, unitCost: -1 }],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors["line-0-unitCost"]).toBeDefined();
      }
    });

    it("indexes errors to the correct line position", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [
          VALID_LINE,
          { ...VALID_LINE, lineNumber: 2, partId: "" }, // second line invalid
        ],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Error should be on line index 1, not 0
        expect(result.errors["line-1-partId"]).toBeDefined();
        expect(result.errors["line-0-partId"]).toBeUndefined();
      }
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("allows zero unit cost (free items)", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [{ ...VALID_LINE, unitCost: 0 }],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(true);
    });

    it("rejects fractional quantities (must be integer)", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [{ ...VALID_LINE, quantityOrdered: 1.5 }],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors["line-0-quantity"]).toBeDefined();
      }
    });

    it("rejects negative lineNumber", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [{ ...VALID_LINE, lineNumber: 0 }],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(false);
    });

    it("accepts multiple valid lines", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [
          VALID_LINE,
          { ...VALID_LINE, partId: "part-002", lineNumber: 2 },
          { ...VALID_LINE, partId: "part-003", lineNumber: 3 },
        ],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lines).toHaveLength(3);
      }
    });

    it("collects multiple errors across different lines", () => {
      const payload = {
        ...VALID_PAYLOAD,
        lines: [
          { ...VALID_LINE, quantityOrdered: 0 }, // line 0: bad quantity
          { ...VALID_LINE, lineNumber: 2, unitCost: -5 }, // line 1: bad cost
        ],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors["line-0-quantity"]).toBeDefined();
        expect(result.errors["line-1-unitCost"]).toBeDefined();
      }
    });

    it("collects both top-level and line-level errors", () => {
      const payload = {
        ...VALID_PAYLOAD,
        supplierId: "",
        lines: [{ ...VALID_LINE, partId: "" }],
      };
      const result = validatePOForm(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.supplierId).toBeDefined();
        expect(result.errors["line-0-partId"]).toBeDefined();
      }
    });
  });
});

// ─── Raw Schema Tests ──────────────────────────────────────────────────

describe("poLineSchema", () => {
  it("parses a valid line", () => {
    const result = poLineSchema.safeParse(VALID_LINE);
    expect(result.success).toBe(true);
  });

  it("rejects missing partId", () => {
    const result = poLineSchema.safeParse({ ...VALID_LINE, partId: "" });
    expect(result.success).toBe(false);
  });
});

describe("poFormSchema", () => {
  it("parses a valid form payload", () => {
    const result = poFormSchema.safeParse(VALID_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it("rejects completely empty object", () => {
    const result = poFormSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
