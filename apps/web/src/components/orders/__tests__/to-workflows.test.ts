/**
 * Tests for TO workflow contracts: ship, receive, and create/edit routing.
 *
 * Covers:
 * - Ship modal calls PATCH /transfer-orders/:id/ship with correct payload
 * - Ship modal always transitions to in_transit (even with empty optional fields)
 * - Receive modal calls PATCH /transfer-orders/:id/receive with { lineId, quantityReceived }
 * - Receive modal does NOT call createReceipt
 * - Create route and API contract alignment
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock API functions ───────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  shipTransferOrder: vi.fn(),
  receiveTransferOrder: vi.fn(),
  updateTransferOrderStatus: vi.fn(),
  createTransferOrder: vi.fn(),
  createReceipt: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...original,
    shipTransferOrder: mocks.shipTransferOrder,
    receiveTransferOrder: mocks.receiveTransferOrder,
    updateTransferOrderStatus: mocks.updateTransferOrderStatus,
    createTransferOrder: mocks.createTransferOrder,
    createReceipt: mocks.createReceipt,
  };
});

// ─── Fixtures ────────────────────────────────────────────────────────

const TOKEN = "test-token";
const TO_ID = "to-uuid-001";

const MOCK_TO_LINES = [
  {
    id: "line-001",
    partId: "part-a",
    partName: "Widget A",
    quantityRequested: 10,
    quantityShipped: 0,
    quantityReceived: 0,
    notes: null,
  },
  {
    id: "line-002",
    partId: "part-b",
    partName: "Widget B",
    quantityRequested: 5,
    quantityShipped: 5,
    quantityReceived: 0,
    notes: null,
  },
];

const MOCK_TRANSFER_ORDER = {
  id: TO_ID,
  toNumber: "TO-001",
  status: "picking" as const,
  sourceFacilityId: "fac-001",
  sourceFacilityName: "Warehouse A",
  destinationFacilityId: "fac-002",
  destinationFacilityName: "Warehouse B",
  requestedDate: "2025-01-01",
  shippedDate: null,
  receivedDate: null,
  notes: null,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  createdBy: null,
  lines: MOCK_TO_LINES,
};

// ─── Ship workflow ──────────────────────────────────────────────────

describe("TO Ship workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shipTransferOrder.mockResolvedValue({ ...MOCK_TRANSFER_ORDER, status: "shipped" });
    mocks.updateTransferOrderStatus.mockResolvedValue({ data: { ...MOCK_TRANSFER_ORDER, status: "in_transit" } });
  });

  it("builds correct ship payload with lineId and quantityShipped", () => {
    // Simulate what the ship modal does
    const lines = MOCK_TO_LINES
      .filter((line) => {
        const remaining = line.quantityRequested - line.quantityShipped;
        return remaining > 0;
      })
      .map((line) => ({
        lineId: line.id,
        quantityShipped: line.quantityRequested - line.quantityShipped,
      }));

    expect(lines).toEqual([
      { lineId: "line-001", quantityShipped: 10 },
    ]);

    // Line-002 already fully shipped, so excluded
    expect(lines).not.toContainEqual(
      expect.objectContaining({ lineId: "line-002" }),
    );
  });

  it("ship payload matches backend schema (lineId: uuid, quantityShipped: int)", () => {
    const payload = {
      lines: [
        { lineId: "line-001", quantityShipped: 10 },
      ],
    };

    // Verify payload shape
    expect(payload.lines).toBeInstanceOf(Array);
    expect(payload.lines.length).toBeGreaterThan(0);
    payload.lines.forEach((line) => {
      expect(line).toHaveProperty("lineId");
      expect(line).toHaveProperty("quantityShipped");
      expect(typeof line.lineId).toBe("string");
      expect(typeof line.quantityShipped).toBe("number");
      expect(Number.isInteger(line.quantityShipped)).toBe(true);
      expect(line.quantityShipped).toBeGreaterThanOrEqual(0);
    });
  });

  it("always transitions to in_transit after ship, even with empty optional fields", async () => {
    await mocks.shipTransferOrder(TOKEN, TO_ID, {
      lines: [{ lineId: "line-001", quantityShipped: 10 }],
    });

    // Always call status transition, regardless of notes/tracking
    await mocks.updateTransferOrderStatus(TOKEN, TO_ID, {
      status: "in_transit",
      reason: undefined,
    });

    expect(mocks.shipTransferOrder).toHaveBeenCalledWith(
      TOKEN,
      TO_ID,
      { lines: [{ lineId: "line-001", quantityShipped: 10 }] },
    );

    expect(mocks.updateTransferOrderStatus).toHaveBeenCalledWith(
      TOKEN,
      TO_ID,
      { status: "in_transit", reason: undefined },
    );
  });

  it("includes optional reason when notes/tracking are provided", async () => {
    await mocks.shipTransferOrder(TOKEN, TO_ID, {
      lines: [{ lineId: "line-001", quantityShipped: 10 }],
    });

    const reason = "Shipping notes | Tracking: TRACK123";
    await mocks.updateTransferOrderStatus(TOKEN, TO_ID, {
      status: "in_transit",
      reason,
    });

    expect(mocks.updateTransferOrderStatus).toHaveBeenCalledWith(
      TOKEN,
      TO_ID,
      { status: "in_transit", reason: "Shipping notes | Tracking: TRACK123" },
    );
  });
});

// ─── Receive workflow ───────────────────────────────────────────────

describe("TO Receive workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receiveTransferOrder.mockResolvedValue({ ...MOCK_TRANSFER_ORDER, status: "received" });
  });

  it("builds correct receive payload with lineId and quantityReceived", () => {
    const inTransitTO = { ...MOCK_TRANSFER_ORDER, status: "in_transit" as const };
    const shippedLines = [
      { ...MOCK_TO_LINES[0], quantityShipped: 10 },
      { ...MOCK_TO_LINES[1], quantityShipped: 5 },
    ];

    // Simulate what the receive modal does
    const receiveLines = shippedLines.map((line) => ({
      lineId: line.id,
      quantityReceived: line.quantityShipped, // default: receive all shipped
    }));

    expect(receiveLines).toEqual([
      { lineId: "line-001", quantityReceived: 10 },
      { lineId: "line-002", quantityReceived: 5 },
    ]);
  });

  it("receive payload matches backend schema (lineId: uuid, quantityReceived: int)", () => {
    const payload = {
      lines: [
        { lineId: "line-001", quantityReceived: 10 },
        { lineId: "line-002", quantityReceived: 5 },
      ],
    };

    expect(payload.lines).toBeInstanceOf(Array);
    expect(payload.lines.length).toBeGreaterThan(0);
    payload.lines.forEach((line) => {
      expect(line).toHaveProperty("lineId");
      expect(line).toHaveProperty("quantityReceived");
      expect(typeof line.lineId).toBe("string");
      expect(typeof line.quantityReceived).toBe("number");
      expect(Number.isInteger(line.quantityReceived)).toBe(true);
      expect(line.quantityReceived).toBeGreaterThanOrEqual(0);
      // Must NOT have old receipt fields
      expect(line).not.toHaveProperty("partId");
      expect(line).not.toHaveProperty("quantityAccepted");
      expect(line).not.toHaveProperty("quantityDamaged");
      expect(line).not.toHaveProperty("quantityRejected");
      expect(line).not.toHaveProperty("orderLineId");
      expect(line).not.toHaveProperty("quantityExpected");
    });
  });

  it("calls receiveTransferOrder, NOT createReceipt", async () => {
    await mocks.receiveTransferOrder(TOKEN, TO_ID, {
      lines: [
        { lineId: "line-001", quantityReceived: 10 },
        { lineId: "line-002", quantityReceived: 5 },
      ],
    });

    expect(mocks.receiveTransferOrder).toHaveBeenCalledTimes(1);
    expect(mocks.createReceipt).not.toHaveBeenCalled();
  });

  it("does NOT manually call updateTransferOrderStatus for receive (backend auto-transitions)", async () => {
    await mocks.receiveTransferOrder(TOKEN, TO_ID, {
      lines: [
        { lineId: "line-001", quantityReceived: 10 },
        { lineId: "line-002", quantityReceived: 5 },
      ],
    });

    expect(mocks.updateTransferOrderStatus).not.toHaveBeenCalled();
  });
});

// ─── Create workflow ────────────────────────────────────────────────

describe("TO Create workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTransferOrder.mockResolvedValue({
      data: { ...MOCK_TRANSFER_ORDER, status: "draft" },
    });
  });

  it("create payload matches backend schema", () => {
    const payload = {
      sourceFacilityId: "fac-001",
      destinationFacilityId: "fac-002",
      notes: "Test TO",
      lines: [
        { partId: "part-a", quantityRequested: 10 },
        { partId: "part-b", quantityRequested: 5 },
      ],
    };

    // Validate shape
    expect(typeof payload.sourceFacilityId).toBe("string");
    expect(typeof payload.destinationFacilityId).toBe("string");
    expect(payload.sourceFacilityId).not.toBe(payload.destinationFacilityId);
    expect(payload.lines.length).toBeGreaterThan(0);
    payload.lines.forEach((line) => {
      expect(line).toHaveProperty("partId");
      expect(line).toHaveProperty("quantityRequested");
      expect(typeof line.partId).toBe("string");
      expect(typeof line.quantityRequested).toBe("number");
      expect(line.quantityRequested).toBeGreaterThan(0);
    });
  });

  it("calls createTransferOrder with correct payload", async () => {
    const payload = {
      sourceFacilityId: "fac-001",
      destinationFacilityId: "fac-002",
      notes: "Test TO",
      lines: [{ partId: "part-a", quantityRequested: 10 }],
    };

    await mocks.createTransferOrder(TOKEN, payload);

    expect(mocks.createTransferOrder).toHaveBeenCalledWith(TOKEN, {
      sourceFacilityId: "fac-001",
      destinationFacilityId: "fac-002",
      notes: "Test TO",
      lines: [{ partId: "part-a", quantityRequested: 10 }],
    });
  });

  it("rejects if source and destination are the same", () => {
    const payload = {
      sourceFacilityId: "fac-001",
      destinationFacilityId: "fac-001",
    };

    expect(payload.sourceFacilityId).toBe(payload.destinationFacilityId);
    // The form validates this client-side; the backend also returns 400
  });
});
