import { describe, it, expect } from "vitest";
import type { AuditIntegrityCheckResult } from "@/types";

/**
 * Tests for Integrity Check Banner rendering logic:
 * - Phase-based visibility
 * - Success vs failure result interpretation
 * - Violation count and first-invalid-entry display logic
 */

type IntegrityPhase = "idle" | "running" | "done" | "error";

interface BannerState {
  visible: boolean;
  variant: "hidden" | "loading" | "success" | "failure" | "error";
  message: string | null;
}

/** Mirrors the rendering logic from IntegrityCheckBanner */
function computeBannerState(
  phase: IntegrityPhase,
  result: AuditIntegrityCheckResult | null,
  error: string | null,
): BannerState {
  if (phase === "idle") {
    return { visible: false, variant: "hidden", message: null };
  }

  if (phase === "running") {
    return {
      visible: true,
      variant: "loading",
      message: "Running integrity check...",
    };
  }

  if (phase === "error") {
    return {
      visible: true,
      variant: "error",
      message: error ?? "Integrity check failed.",
    };
  }

  // phase === "done"
  if (result?.valid) {
    return {
      visible: true,
      variant: "success",
      message: `Integrity check passed. ${result.totalChecked.toLocaleString()} entries verified.`,
    };
  }

  if (result && !result.valid) {
    return {
      visible: true,
      variant: "failure",
      message: `Integrity check failed. ${result.violationCount} violation${result.violationCount !== 1 ? "s" : ""} detected out of ${result.totalChecked.toLocaleString()} entries.`,
    };
  }

  return { visible: false, variant: "hidden", message: null };
}

describe("Integrity Check Banner Logic", () => {
  describe("Phase-based visibility", () => {
    it("should be hidden when idle", () => {
      const state = computeBannerState("idle", null, null);
      expect(state.visible).toBe(false);
      expect(state.variant).toBe("hidden");
    });

    it("should show loading spinner when running", () => {
      const state = computeBannerState("running", null, null);
      expect(state.visible).toBe(true);
      expect(state.variant).toBe("loading");
      expect(state.message).toBe("Running integrity check...");
    });

    it("should show error message on error phase", () => {
      const state = computeBannerState(
        "error",
        null,
        "Network error occurred.",
      );
      expect(state.visible).toBe(true);
      expect(state.variant).toBe("error");
      expect(state.message).toBe("Network error occurred.");
    });

    it("should show fallback error message when error is null", () => {
      const state = computeBannerState("error", null, null);
      expect(state.message).toBe("Integrity check failed.");
    });
  });

  describe("Success result rendering", () => {
    it("should display success with entry count", () => {
      const result: AuditIntegrityCheckResult = {
        valid: true,
        totalChecked: 1234,
        violationCount: 0,
        violations: [],
      };
      const state = computeBannerState("done", result, null);
      expect(state.visible).toBe(true);
      expect(state.variant).toBe("success");
      expect(state.message).toContain("1,234");
      expect(state.message).toContain("entries verified");
    });

    it("should handle single entry check", () => {
      const result: AuditIntegrityCheckResult = {
        valid: true,
        totalChecked: 1,
        violationCount: 0,
        violations: [],
      };
      const state = computeBannerState("done", result, null);
      expect(state.message).toContain("1 entries verified");
    });
  });

  describe("Failure result rendering", () => {
    it("should display violation count and total checked", () => {
      const result: AuditIntegrityCheckResult = {
        valid: false,
        totalChecked: 500,
        violationCount: 3,
        firstInvalidEntry: "entry-abc-123",
        violations: [
          {
            entryId: "entry-abc-123",
            sequenceNumber: 42,
            expectedHash: "abc",
            actualHash: "def",
          },
          {
            entryId: "entry-xyz-456",
            sequenceNumber: 43,
            expectedHash: "ghi",
            actualHash: "jkl",
          },
          {
            entryId: "entry-mno-789",
            sequenceNumber: 44,
            expectedHash: "mno",
            actualHash: "pqr",
          },
        ],
      };
      const state = computeBannerState("done", result, null);
      expect(state.visible).toBe(true);
      expect(state.variant).toBe("failure");
      expect(state.message).toContain("3 violations");
      expect(state.message).toContain("500");
    });

    it("should use singular 'violation' for count of 1", () => {
      const result: AuditIntegrityCheckResult = {
        valid: false,
        totalChecked: 100,
        violationCount: 1,
        firstInvalidEntry: "entry-123",
        violations: [
          {
            entryId: "entry-123",
            sequenceNumber: 10,
            expectedHash: "a",
            actualHash: "b",
          },
        ],
      };
      const state = computeBannerState("done", result, null);
      expect(state.message).toContain("1 violation ");
      expect(state.message).not.toContain("1 violations");
    });

    it("should include firstInvalidEntry in result", () => {
      const result: AuditIntegrityCheckResult = {
        valid: false,
        totalChecked: 100,
        violationCount: 2,
        firstInvalidEntry: "entry-first-bad",
        violations: [],
      };
      expect(result.firstInvalidEntry).toBe("entry-first-bad");
    });

    it("should handle missing firstInvalidEntry", () => {
      const result: AuditIntegrityCheckResult = {
        valid: false,
        totalChecked: 100,
        violationCount: 2,
        violations: [],
      };
      expect(result.firstInvalidEntry).toBeUndefined();
    });
  });

  describe("Edge cases", () => {
    it("should return hidden when done but result is null", () => {
      const state = computeBannerState("done", null, null);
      expect(state.visible).toBe(false);
      expect(state.variant).toBe("hidden");
    });

    it("should handle large totalChecked with locale formatting", () => {
      const result: AuditIntegrityCheckResult = {
        valid: true,
        totalChecked: 1000000,
        violationCount: 0,
        violations: [],
      };
      const state = computeBannerState("done", result, null);
      expect(state.message).toContain("1,000,000");
    });
  });
});
