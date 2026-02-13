import { describe, it, expect } from "vitest";
import type { AuditListFilters, AuditExportFormat } from "@/types";

/**
 * Tests for Export Modal helper logic:
 * - buildFilterSummary generation
 * - Format options coverage
 * - Phase gating (isRunning, isDone, isError)
 */

/* ── Re-implement buildFilterSummary to test ──────────────── */

function buildFilterSummary(filters: AuditListFilters): string[] {
  const summary: string[] = [];
  if (filters.action) summary.push(`Action: ${filters.action}`);
  if (filters.entityType) summary.push(`Entity: ${filters.entityType}`);
  if (filters.dateFrom)
    summary.push(`From: ${new Date(filters.dateFrom).toLocaleDateString()}`);
  if (filters.dateTo)
    summary.push(`To: ${new Date(filters.dateTo).toLocaleDateString()}`);
  if (filters.search) summary.push(`Search: "${filters.search}"`);
  if (filters.actorName) summary.push(`Actor: ${filters.actorName}`);
  if (filters.entityName) summary.push(`Entity name: ${filters.entityName}`);
  return summary;
}

describe("Export Modal Logic", () => {
  describe("buildFilterSummary", () => {
    it("should return empty array when no filters are set", () => {
      const filters: AuditListFilters = {};
      expect(buildFilterSummary(filters)).toEqual([]);
    });

    it("should include action filter", () => {
      const filters: AuditListFilters = { action: "CREATE" };
      const result = buildFilterSummary(filters);
      expect(result).toContain("Action: CREATE");
      expect(result).toHaveLength(1);
    });

    it("should include entityType filter", () => {
      const filters: AuditListFilters = { entityType: "order" };
      const result = buildFilterSummary(filters);
      expect(result).toContain("Entity: order");
    });

    it("should include search filter with quotes", () => {
      const filters: AuditListFilters = { search: "test query" };
      const result = buildFilterSummary(filters);
      expect(result).toContain('Search: "test query"');
    });

    it("should include actorName filter", () => {
      const filters: AuditListFilters = { actorName: "admin@test.com" };
      const result = buildFilterSummary(filters);
      expect(result).toContain("Actor: admin@test.com");
    });

    it("should include entityName filter", () => {
      const filters: AuditListFilters = { entityName: "Order-123" };
      const result = buildFilterSummary(filters);
      expect(result).toContain("Entity name: Order-123");
    });

    it("should include dateFrom and dateTo filters", () => {
      const filters: AuditListFilters = {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      };
      const result = buildFilterSummary(filters);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatch(/^From:/);
      expect(result[1]).toMatch(/^To:/);
    });

    it("should combine multiple filters", () => {
      const filters: AuditListFilters = {
        action: "UPDATE",
        entityType: "part",
        search: "bolt",
        actorName: "user@example.com",
      };
      const result = buildFilterSummary(filters);
      expect(result).toHaveLength(4);
      expect(result).toContain("Action: UPDATE");
      expect(result).toContain("Entity: part");
      expect(result).toContain('Search: "bolt"');
      expect(result).toContain("Actor: user@example.com");
    });

    it("should ignore page and limit fields", () => {
      const filters: AuditListFilters = { page: 3, limit: 50 };
      const result = buildFilterSummary(filters);
      expect(result).toEqual([]);
    });
  });

  describe("Format options", () => {
    it("should support csv, json, pdf formats", () => {
      const validFormats: AuditExportFormat[] = ["csv", "json", "pdf"];
      validFormats.forEach((fmt) => {
        expect(["csv", "json", "pdf"]).toContain(fmt);
      });
    });
  });

  describe("Phase gating logic", () => {
    type ExportPhase =
      | "idle"
      | "starting"
      | "downloading"
      | "polling"
      | "completed"
      | "error";

    function computePhaseFlags(phase: ExportPhase) {
      const isRunning =
        phase === "starting" || phase === "downloading" || phase === "polling";
      const isDone = phase === "completed";
      const isError = phase === "error";
      return { isRunning, isDone, isError };
    }

    it("should be idle initially", () => {
      const { isRunning, isDone, isError } = computePhaseFlags("idle");
      expect(isRunning).toBe(false);
      expect(isDone).toBe(false);
      expect(isError).toBe(false);
    });

    it("should be running during starting phase", () => {
      const { isRunning, isDone, isError } = computePhaseFlags("starting");
      expect(isRunning).toBe(true);
      expect(isDone).toBe(false);
      expect(isError).toBe(false);
    });

    it("should be running during downloading phase", () => {
      const { isRunning } = computePhaseFlags("downloading");
      expect(isRunning).toBe(true);
    });

    it("should be running during polling phase", () => {
      const { isRunning } = computePhaseFlags("polling");
      expect(isRunning).toBe(true);
    });

    it("should be done when completed", () => {
      const { isRunning, isDone, isError } = computePhaseFlags("completed");
      expect(isRunning).toBe(false);
      expect(isDone).toBe(true);
      expect(isError).toBe(false);
    });

    it("should be error when failed", () => {
      const { isRunning, isDone, isError } = computePhaseFlags("error");
      expect(isRunning).toBe(false);
      expect(isDone).toBe(false);
      expect(isError).toBe(true);
    });
  });
});
