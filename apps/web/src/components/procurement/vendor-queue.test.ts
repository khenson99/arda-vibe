import { describe, expect, it } from "vitest";
import type { PartRecord, QueueCard } from "@/types";
import { buildVendorQueueGroups } from "./vendor-queue";

function makeCard(overrides: Partial<QueueCard>): QueueCard {
  return {
    id: "card-1",
    cardNumber: 1,
    currentStage: "triggered",
    currentStageEnteredAt: "2026-02-11T00:00:00.000Z",
    loopId: "loop-1",
    loopType: "procurement",
    partId: "part-1",
    facilityId: "fac-1",
    minQuantity: 1,
    orderQuantity: 5,
    numberOfCards: 3,
    ...overrides,
  };
}

function makePart(overrides: Partial<PartRecord>): PartRecord {
  return {
    id: "part-1",
    partNumber: "P-1",
    name: "Widget",
    type: "component",
    uom: "each",
    isSellable: false,
    isActive: true,
    updatedAt: "2026-02-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildVendorQueueGroups", () => {
  it("groups procurement cards by supplier with methods and draft badges", () => {
    const cards: QueueCard[] = [
      makeCard({
        id: "card-a",
        partId: "part-a",
        primarySupplierId: "sup-1",
        supplierName: "Acme",
        draftPurchaseOrderId: "po-draft-1",
      }),
      makeCard({
        id: "card-b",
        cardNumber: 2,
        partId: "part-b",
        primarySupplierId: "sup-1",
        supplierName: "Acme",
        facilityId: "fac-2",
      }),
    ];

    const parts: PartRecord[] = [
      makePart({ id: "part-a", orderMechanism: "po" }),
      makePart({ id: "part-b", orderMechanism: "online" }),
    ];

    const groups = buildVendorQueueGroups({ cards, parts });

    expect(groups).toHaveLength(1);
    expect(groups[0].supplierName).toBe("Acme");
    expect(groups[0].methods).toEqual(expect.arrayContaining(["purchase_order", "online"]));
    expect(groups[0].draftPurchaseOrderIds).toEqual(["po-draft-1"]);
    expect(Object.keys(groups[0].facilityCounts)).toHaveLength(2);
  });

  it("flags unknown methods", () => {
    const groups = buildVendorQueueGroups({
      cards: [
        makeCard({
          id: "card-x",
          partId: "part-x",
          primarySupplierId: "sup-2",
          supplierName: "Vendor X",
        }),
      ],
      parts: [makePart({ id: "part-x", orderMechanism: "fax" })],
    });

    expect(groups[0].hasUnknownMethods).toBe(true);
    expect(groups[0].lines[0].orderMethod).toBeNull();
  });

  it("defaults missing methods to purchase order", () => {
    const groups = buildVendorQueueGroups({
      cards: [
        makeCard({
          id: "card-purchase-order-default",
          partId: "part-default-method",
          primarySupplierId: "sup-default",
          supplierName: "Default Vendor",
        }),
      ],
      parts: [makePart({ id: "part-default-method", orderMechanism: null })],
    });

    expect(groups[0].hasUnknownMethods).toBe(false);
    expect(groups[0].lines[0].orderMethod).toBe("purchase_order");
  });
});
