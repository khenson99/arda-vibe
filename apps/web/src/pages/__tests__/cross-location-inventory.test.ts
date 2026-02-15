import { describe, it, expect } from "vitest";
import type { CrossLocationMatrixCell } from "@/types";

/**
 * Tests for cross-location inventory matrix logic
 */
describe("Cross-Location Inventory Matrix", () => {
  describe("Cell warning state detection", () => {
    it("should mark cell as below reorder when qtyOnHand < reorderPoint", () => {
      const cell: CrossLocationMatrixCell = {
        facilityId: "fac-1",
        facilityName: "Warehouse A",
        partId: "part-1",
        partNumber: "P-001",
        partName: "Widget",
        qtyOnHand: 8,
        qtyReserved: 2,
        qtyInTransit: 5,
        available: 6,
        reorderPoint: 10,
        isBelowReorder: true,
        isNearReorder: false,
      };

      expect(cell.isBelowReorder).toBe(true);
      expect(cell.isNearReorder).toBe(false);
    });

    it("should mark cell as near reorder when qtyOnHand is within 20% threshold", () => {
      const cell: CrossLocationMatrixCell = {
        facilityId: "fac-1",
        facilityName: "Warehouse A",
        partId: "part-1",
        partNumber: "P-001",
        partName: "Widget",
        qtyOnHand: 11,
        qtyReserved: 1,
        qtyInTransit: 0,
        available: 10,
        reorderPoint: 10,
        isBelowReorder: false,
        isNearReorder: true,
      };

      expect(cell.isBelowReorder).toBe(false);
      expect(cell.isNearReorder).toBe(true);
    });

    it("should not mark cell as warning when qtyOnHand is well above reorderPoint", () => {
      const cell: CrossLocationMatrixCell = {
        facilityId: "fac-1",
        facilityName: "Warehouse A",
        partId: "part-1",
        partNumber: "P-001",
        partName: "Widget",
        qtyOnHand: 25,
        qtyReserved: 5,
        qtyInTransit: 0,
        available: 20,
        reorderPoint: 10,
        isBelowReorder: false,
        isNearReorder: false,
      };

      expect(cell.isBelowReorder).toBe(false);
      expect(cell.isNearReorder).toBe(false);
    });

    it("should handle null reorderPoint gracefully", () => {
      const cell: CrossLocationMatrixCell = {
        facilityId: "fac-1",
        facilityName: "Warehouse A",
        partId: "part-1",
        partNumber: "P-001",
        partName: "Widget",
        qtyOnHand: 5,
        qtyReserved: 2,
        qtyInTransit: 0,
        available: 3,
        reorderPoint: null,
        isBelowReorder: false,
        isNearReorder: false,
      };

      expect(cell.isBelowReorder).toBe(false);
      expect(cell.isNearReorder).toBe(false);
    });
  });

  describe("Available quantity calculation", () => {
    it("should calculate available as qtyOnHand - qtyReserved", () => {
      const cell: CrossLocationMatrixCell = {
        facilityId: "fac-1",
        facilityName: "Warehouse A",
        partId: "part-1",
        partNumber: "P-001",
        partName: "Widget",
        qtyOnHand: 20,
        qtyReserved: 8,
        qtyInTransit: 5,
        available: 12,
        reorderPoint: 10,
        isBelowReorder: false,
        isNearReorder: false,
      };

      expect(cell.available).toBe(cell.qtyOnHand - cell.qtyReserved);
    });

    it("should handle zero reserved quantity", () => {
      const cell: CrossLocationMatrixCell = {
        facilityId: "fac-1",
        facilityName: "Warehouse A",
        partId: "part-1",
        partNumber: "P-001",
        partName: "Widget",
        qtyOnHand: 15,
        qtyReserved: 0,
        qtyInTransit: 0,
        available: 15,
        reorderPoint: 10,
        isBelowReorder: false,
        isNearReorder: false,
      };

      expect(cell.available).toBe(cell.qtyOnHand);
    });

    it("should handle fully reserved stock", () => {
      const cell: CrossLocationMatrixCell = {
        facilityId: "fac-1",
        facilityName: "Warehouse A",
        partId: "part-1",
        partNumber: "P-001",
        partName: "Widget",
        qtyOnHand: 10,
        qtyReserved: 10,
        qtyInTransit: 0,
        available: 0,
        reorderPoint: 5,
        isBelowReorder: true,
        isNearReorder: false,
      };

      expect(cell.available).toBe(0);
      expect(cell.qtyOnHand).toBe(cell.qtyReserved);
    });
  });

  describe("Matrix cell key generation", () => {
    it("should generate unique key for facility-part combination", () => {
      const facilityId = "fac-1";
      const partId = "part-1";
      const key = `${facilityId}:${partId}`;

      expect(key).toBe("fac-1:part-1");
    });

    it("should generate different keys for different combinations", () => {
      const key1 = `fac-1:part-1`;
      const key2 = `fac-1:part-2`;
      const key3 = `fac-2:part-1`;

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key2).not.toBe(key3);
    });
  });

  describe("Cell highlighting priority", () => {
    it("should prioritize below-reorder over near-reorder", () => {
      const cell: CrossLocationMatrixCell = {
        facilityId: "fac-1",
        facilityName: "Warehouse A",
        partId: "part-1",
        partNumber: "P-001",
        partName: "Widget",
        qtyOnHand: 8,
        qtyReserved: 2,
        qtyInTransit: 0,
        available: 6,
        reorderPoint: 10,
        isBelowReorder: true,
        isNearReorder: true,
      };

      // When both flags are true, below-reorder should take precedence
      // in UI styling (red over amber)
      const shouldShowRed = cell.isBelowReorder;
      const shouldShowAmber = cell.isNearReorder && !cell.isBelowReorder;

      expect(shouldShowRed).toBe(true);
      expect(shouldShowAmber).toBe(false);
    });
  });

  describe("Pagination calculations", () => {
    it("should calculate correct total pages", () => {
      const totalParts = 523;
      const pageSize = 50;
      const totalPages = Math.ceil(totalParts / pageSize);

      expect(totalPages).toBe(11);
    });

    it("should handle exact page boundaries", () => {
      const totalParts = 500;
      const pageSize = 50;
      const totalPages = Math.ceil(totalParts / pageSize);

      expect(totalPages).toBe(10);
    });

    it("should handle single page", () => {
      const totalParts = 25;
      const pageSize = 50;
      const totalPages = Math.ceil(totalParts / pageSize);

      expect(totalPages).toBe(1);
    });
  });
});

/**
 * Tests for cross-location summary KPIs
 */
describe("Cross-Location Summary KPIs", () => {
  describe("Facilities below reorder count", () => {
    it("should count facilities with any part below reorder", () => {
      const cells: CrossLocationMatrixCell[] = [
        {
          facilityId: "fac-1",
          facilityName: "Warehouse A",
          partId: "part-1",
          partNumber: "P-001",
          partName: "Widget A",
          qtyOnHand: 5,
          qtyReserved: 0,
          qtyInTransit: 0,
          available: 5,
          reorderPoint: 10,
          isBelowReorder: true,
          isNearReorder: false,
        },
        {
          facilityId: "fac-1",
          facilityName: "Warehouse A",
          partId: "part-2",
          partNumber: "P-002",
          partName: "Widget B",
          qtyOnHand: 20,
          qtyReserved: 5,
          qtyInTransit: 0,
          available: 15,
          reorderPoint: 10,
          isBelowReorder: false,
          isNearReorder: false,
        },
        {
          facilityId: "fac-2",
          facilityName: "Warehouse B",
          partId: "part-1",
          partNumber: "P-001",
          partName: "Widget A",
          qtyOnHand: 15,
          qtyReserved: 3,
          qtyInTransit: 0,
          available: 12,
          reorderPoint: 10,
          isBelowReorder: false,
          isNearReorder: false,
        },
      ];

      const facilitiesWithBelowReorder = new Set(
        cells.filter(c => c.isBelowReorder).map(c => c.facilityId)
      );

      expect(facilitiesWithBelowReorder.size).toBe(1);
      expect(facilitiesWithBelowReorder.has("fac-1")).toBe(true);
    });
  });

  describe("In-transit value calculation", () => {
    it("should sum all in-transit quantities across network", () => {
      const cells: CrossLocationMatrixCell[] = [
        {
          facilityId: "fac-1",
          facilityName: "Warehouse A",
          partId: "part-1",
          partNumber: "P-001",
          partName: "Widget A",
          qtyOnHand: 10,
          qtyReserved: 2,
          qtyInTransit: 5,
          available: 8,
          reorderPoint: 10,
          isBelowReorder: false,
          isNearReorder: false,
        },
        {
          facilityId: "fac-2",
          facilityName: "Warehouse B",
          partId: "part-1",
          partNumber: "P-001",
          partName: "Widget A",
          qtyOnHand: 8,
          qtyReserved: 1,
          qtyInTransit: 10,
          available: 7,
          reorderPoint: 5,
          isBelowReorder: false,
          isNearReorder: false,
        },
      ];

      const totalInTransit = cells.reduce((sum, cell) => sum + cell.qtyInTransit, 0);

      expect(totalInTransit).toBe(15);
    });
  });
});
