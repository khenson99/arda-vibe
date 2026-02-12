import { describe, expect, it } from "vitest";
import type { KanbanCardPrintDetail } from "@/lib/api-client";
import { mapCardPrintDetailToPrintData } from "@/lib/kanban-printing";

describe("mapCardPrintDetailToPrintData", () => {
  it("maps a fully populated card detail payload", () => {
    const detail: KanbanCardPrintDetail = {
      id: "3c82402b-5f53-4a6c-bbb7-76416519a02f",
      cardNumber: 2,
      currentStage: "triggered",
      partName: "Widget",
      loopType: "production",
      facilityName: "Plant A",
      minQuantity: 12,
      orderQuantity: 30,
      qrCode: "data:image/png;base64,abc123",
      scanUrl: "https://example.com/scan/3c82402b-5f53-4a6c-bbb7-76416519a02f",
      loop: {
        loopType: "production",
        numberOfCards: 4,
        partNumber: "PN-100",
        partDescription: "Widget Assembly",
        imageUrl: "https://example.com/widget.png",
        itemNotes: "Keep box upright",
        facilityName: "Plant A",
        storageLocationName: "A-12",
        primarySupplierName: "Acme",
        sourceFacilityName: "Warehouse B",
        orderQuantity: 30,
        minQuantity: 12,
        statedLeadTimeDays: 5,
        safetyStockDays: 2,
        notes: "Handle with care",
      },
    };

    const mapped = mapCardPrintDetailToPrintData(detail, {
      tenantName: "Arda Manufacturing",
      tenantLogoUrl: "https://cdn.example.com/logo.png",
    });

    expect(mapped.cardId).toBe(detail.id);
    expect(mapped.partNumber).toBe("PN-100");
    expect(mapped.sku).toBe("PN-100");
    expect(mapped.partDescription).toBe("Widget Assembly");
    expect(mapped.loopType).toBe("production");
    expect(mapped.currentStage).toBe("triggered");
    expect(mapped.totalCards).toBe(4);
    expect(mapped.storageLocation).toBe("A-12");
    expect(mapped.supplierName).toBe("Acme");
    expect(mapped.sourceFacilityName).toBe("Warehouse B");
    expect(mapped.qrCodeDataUrl).toBe("data:image/png;base64,abc123");
    expect(mapped.tenantName).toBe("Arda Manufacturing");
    expect(mapped.tenantLogoUrl).toBe("https://cdn.example.com/logo.png");
    expect(mapped.notesText).toBe("Keep box upright");
    expect(mapped.imageUrl).toBe("https://example.com/widget.png");
    expect(mapped.minimumText).toBe("12 each");
    expect(mapped.orderText).toBe("30 each");
    expect(mapped.locationText).toBe("A-12");
    expect(mapped.supplierText).toBe("Acme");
  });

  it("applies resilient fallbacks when optional fields are missing", () => {
    const detail = {
      id: "8f54af57-29f2-4f27-a94f-56c2d0cb8b5b",
      cardNumber: 0,
      currentStage: "invalid" as unknown as KanbanCardPrintDetail["currentStage"],
      loopType: "invalid" as unknown as KanbanCardPrintDetail["loopType"],
      loop: {
        numberOfCards: 0,
      },
    } as KanbanCardPrintDetail;

    const mapped = mapCardPrintDetailToPrintData(detail);

    expect(mapped.cardNumber).toBe(1);
    expect(mapped.totalCards).toBe(1);
    expect(mapped.partNumber).toBe("Card-1");
    expect(mapped.sku).toBe("Card-1");
    expect(mapped.partDescription).toBe("Card-1");
    expect(mapped.loopType).toBe("procurement");
    expect(mapped.currentStage).toBe("created");
    expect(mapped.facilityName).toBe("Unknown Facility");
    expect(mapped.minimumText).toBe("0 each");
    expect(mapped.orderText).toBe("0 each");
    expect(mapped.locationText).toBe("Location TBD");
    expect(mapped.supplierText).toBe("Unknown supplier");
    expect(mapped.qrCodeDataUrl.startsWith("data:image/")).toBe(true);
    expect(mapped.tenantName).toBe("Tenant");
  });
});
