/**
 * Unit tests for restock ETA engine (Ticket #195)
 *
 * Tests:
 * - computeWeightedMovingAverage: edge cases, single value, multiple values
 * - calculateRestockEta: all stage branches (triggered, ordered, in_transit)
 * - calculateRestockEta: no active replenishment case
 * - calculateRestockEta: no loop (supplier part fallback, default fallback)
 * - calculateBatchRestockEta: batch processing
 * - calculateSalesOrderLineEtas: per-line shortfall + ETA
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ─────────────────────────────────────────────────
const dbMocks = vi.hoisted(() => {
  const findFirstMock = vi.fn(async () => null as Record<string, unknown> | null);

  /** Creates a chainable select mock that resolves to `data` when awaited */
  function makeChain(data: Record<string, unknown>[]) {
    const self = {
      from: vi.fn(() => self),
      innerJoin: vi.fn(() => self),
      where: vi.fn(() => self),
      orderBy: vi.fn(() => self),
      limit: vi.fn(() => self),
      // Makes the chain awaitable — resolves to data
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(data).then(resolve, reject),
    };
    return self;
  }

  let selectQueue: Record<string, unknown>[][] = [];
  let selectIdx = 0;

  const selectMock = vi.fn(() => {
    const data = selectQueue[selectIdx] ?? [];
    selectIdx++;
    return makeChain(data);
  });

  function setupSelects(queues: Record<string, unknown>[][]) {
    selectQueue = queues;
    selectIdx = 0;
  }

  function resetAll() {
    selectMock.mockClear();
    findFirstMock.mockReset().mockResolvedValue(null);
    selectQueue = [];
    selectIdx = 0;
  }

  return { selectMock, findFirstMock, setupSelects, resetAll, makeChain };
});

// Mock @arda/db
vi.mock('@arda/db', () => ({
  db: {
    select: dbMocks.selectMock,
    query: {
      salesOrders: { findFirst: dbMocks.findFirstMock },
    },
  },
  schema: {
    kanbanLoops: { id: 'id', tenantId: 'tenantId', partId: 'partId', facilityId: 'facilityId', isActive: 'isActive', statedLeadTimeDays: 'statedLeadTimeDays' },
    kanbanCards: { tenantId: 'tenantId', loopId: 'loopId', currentStage: 'currentStage', currentStageEnteredAt: 'currentStageEnteredAt', isActive: 'isActive' },
    leadTimeHistory: { tenantId: 'tenantId', partId: 'partId', destinationFacilityId: 'destinationFacilityId', receivedAt: 'receivedAt', leadTimeDays: 'leadTimeDays' },
    supplierParts: { partId: 'partId', isActive: 'isActive', isPrimary: 'isPrimary', leadTimeDays: 'leadTimeDays' },
    inventoryLedger: { tenantId: 'tenantId', facilityId: 'facilityId', partId: 'partId', qtyOnHand: 'qtyOnHand', qtyReserved: 'qtyReserved', qtyInTransit: 'qtyInTransit' },
    salesOrders: { id: 'id', tenantId: 'tenantId', facilityId: 'facilityId' },
    salesOrderLines: { salesOrderId: 'salesOrderId', tenantId: 'tenantId', lineNumber: 'lineNumber' },
  },
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1' })),
  writeAuditEntries: vi.fn(async () => []),
}));

// Mock @arda/config
vi.mock('@arda/config', () => ({
  config: {},
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Import under test (after mocks) ───────────────────────────────
import {
  computeWeightedMovingAverage,
  calculateRestockEta,
  calculateBatchRestockEta,
  calculateSalesOrderLineEtas,
} from './restock-eta.service.js';

// ─── Helpers ────────────────────────────────────────────────────────
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const FACILITY_ID = '00000000-0000-0000-0000-000000000002';
const PART_ID = '00000000-0000-0000-0000-000000000003';

// ─── computeWeightedMovingAverage ───────────────────────────────────

describe('computeWeightedMovingAverage', () => {
  it('returns null for empty array', () => {
    expect(computeWeightedMovingAverage([])).toBeNull();
  });

  it('returns the single value for a one-element array', () => {
    expect(computeWeightedMovingAverage([5])).toBe(5);
  });

  it('computes WMA for two values (alpha=0.3)', () => {
    // [newest=10, oldest=5]: wma = 0.3*10 + 0.7*5 = 3 + 3.5 = 6.5
    const result = computeWeightedMovingAverage([10, 5]);
    expect(result).toBe(6.5);
  });

  it('computes WMA for three values (alpha=0.3)', () => {
    // [newest=12, mid=8, oldest=4]
    // Step 1: wma = 4
    // Step 2: wma = 0.3 * 8 + 0.7 * 4 = 2.4 + 2.8 = 5.2
    // Step 3: wma = 0.3 * 12 + 0.7 * 5.2 = 3.6 + 3.64 = 7.24
    const result = computeWeightedMovingAverage([12, 8, 4]);
    expect(result).toBe(7.24);
  });

  it('weights recent values more heavily', () => {
    const recentHigh = computeWeightedMovingAverage([20, 10, 10, 10, 10]);
    const recentLow = computeWeightedMovingAverage([10, 10, 10, 10, 20]);
    expect(recentHigh!).toBeGreaterThan(recentLow!);
  });

  it('supports custom alpha', () => {
    expect(computeWeightedMovingAverage([10, 5], 1.0)).toBe(10);
    expect(computeWeightedMovingAverage([10, 5], 0)).toBe(5);
  });
});

// ─── calculateRestockEta ────────────────────────────────────────────

describe('calculateRestockEta', () => {
  beforeEach(() => {
    dbMocks.resetAll();
  });

  // Note: calculateRestockEta calls 3 functions via Promise.all:
  //   estimateLeadTime (1–4 select calls depending on fallback)
  //   findActiveCard (1 select call)
  //   getInventoryPosition (1 select call)
  // Because these run in parallel, select call order depends on async scheduling.
  // The safest approach is to provide enough entries in the queue for worst-case
  // and verify the outcome rather than exact call order.

  it('uses lead-time history WMA when available', async () => {
    // estimateLeadTime: 1 select (history found)
    // findActiveCard: 1 select
    // getInventoryPosition: 1 select
    // Due to Promise.all, order may vary — provide enough data
    dbMocks.setupSelects([
      // estimateLeadTime → lead_time_history (has data → stops)
      [{ leadTimeDays: '10' }, { leadTimeDays: '8' }, { leadTimeDays: '12' }],
      // findActiveCard → kanbanCards (empty)
      [],
      // getInventoryPosition → inventoryLedger
      [{ qtyOnHand: 50, qtyReserved: 10, qtyInTransit: 5 }],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.leadTimeSource).toBe('history_wma');
    expect(result.baseLeadTimeDays).toBeGreaterThan(0);
    expect(result.activeCardStage).toBeNull();
    expect(result.qtyOnHand).toBe(50);
    expect(result.qtyReserved).toBe(10);
    expect(result.qtyInTransit).toBe(5);
    expect(result.netAvailable).toBe(40);
    expect(result.etaDays).not.toBeNull();
    expect(result.etaDate).not.toBeNull();
  });

  it('falls back to loop statedLeadTimeDays when no history', async () => {
    // estimateLeadTime: 2 selects (history empty → loop has data)
    // findActiveCard: 1 select
    // getInventoryPosition: 1 select
    dbMocks.setupSelects([
      // 1: lead_time_history → empty
      [],
      // 2: kanbanLoops → has stated lead time
      [{ statedLeadTimeDays: 7 }],
      // 3: findActiveCard → empty
      [],
      // 4: getInventoryPosition → empty
      [],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.leadTimeSource).toBe('loop_stated');
    expect(result.baseLeadTimeDays).toBe(7);
    expect(result.etaDays).toBe(7);
  });

  it('falls back to supplier part leadTimeDays when no loop', async () => {
    dbMocks.setupSelects([
      // 1: lead_time_history → empty
      [],
      // 2: kanbanLoops → empty
      [],
      // 3: supplierParts → has lead time
      [{ leadTimeDays: 21 }],
      // 4: findActiveCard → empty
      [],
      // 5: getInventoryPosition → empty
      [],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.leadTimeSource).toBe('supplier_part');
    expect(result.baseLeadTimeDays).toBe(21);
    expect(result.etaDays).toBe(21);
  });

  it('falls back to default 14 days when nothing else available', async () => {
    dbMocks.setupSelects([
      // 1: lead_time_history → empty
      [],
      // 2: kanbanLoops → empty
      [],
      // 3: supplierParts → empty
      [],
      // 4: findActiveCard → empty
      [],
      // 5: getInventoryPosition → empty
      [],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.leadTimeSource).toBe('default');
    expect(result.baseLeadTimeDays).toBe(14);
    expect(result.etaDays).toBe(14);
  });

  it('returns full lead time for triggered stage', async () => {
    const now = new Date();
    dbMocks.setupSelects([
      // 1: lead_time_history → 10 days
      [{ leadTimeDays: '10' }],
      // 2: findActiveCard → triggered stage
      [{ stage: 'triggered', stageEnteredAt: new Date(now.getTime() - 2 * 86400000) }],
      // 3: getInventoryPosition
      [{ qtyOnHand: 0, qtyReserved: 0, qtyInTransit: 0 }],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.activeCardStage).toBe('triggered');
    expect(result.etaDays).toBe(10);
  });

  it('subtracts elapsed days for ordered stage', async () => {
    const now = new Date();
    dbMocks.setupSelects([
      // 1: lead_time_history → 10 days
      [{ leadTimeDays: '10' }],
      // 2: findActiveCard → ordered, 3 days ago
      [{ stage: 'ordered', stageEnteredAt: new Date(now.getTime() - 3 * 86400000) }],
      // 3: getInventoryPosition
      [{ qtyOnHand: 0, qtyReserved: 0, qtyInTransit: 0 }],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.activeCardStage).toBe('ordered');
    expect(result.etaDays!).toBeGreaterThanOrEqual(6.8);
    expect(result.etaDays!).toBeLessThanOrEqual(7.2);
  });

  it('subtracts elapsed days for in_transit stage', async () => {
    const now = new Date();
    dbMocks.setupSelects([
      // 1: lead_time_history → 10 days
      [{ leadTimeDays: '10' }],
      // 2: findActiveCard → in_transit, 5 days ago
      [{ stage: 'in_transit', stageEnteredAt: new Date(now.getTime() - 5 * 86400000) }],
      // 3: getInventoryPosition
      [{ qtyOnHand: 0, qtyReserved: 0, qtyInTransit: 0 }],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.activeCardStage).toBe('in_transit');
    expect(result.etaDays!).toBeGreaterThanOrEqual(4.8);
    expect(result.etaDays!).toBeLessThanOrEqual(5.2);
  });

  it('clamps ETA to 0 when elapsed exceeds base lead time', async () => {
    const now = new Date();
    dbMocks.setupSelects([
      // 1: lead_time_history → 10 days
      [{ leadTimeDays: '10' }],
      // 2: findActiveCard → ordered, 15 days ago
      [{ stage: 'ordered', stageEnteredAt: new Date(now.getTime() - 15 * 86400000) }],
      // 3: getInventoryPosition
      [{ qtyOnHand: 0, qtyReserved: 0, qtyInTransit: 0 }],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.etaDays).toBe(0);
  });

  it('returns 0 inventory when no ledger row exists', async () => {
    dbMocks.setupSelects([
      // All selects return empty
      [], [], [], [], [],
    ]);

    const result = await calculateRestockEta(TENANT_ID, FACILITY_ID, PART_ID);

    expect(result.qtyOnHand).toBe(0);
    expect(result.qtyReserved).toBe(0);
    expect(result.qtyInTransit).toBe(0);
    expect(result.netAvailable).toBe(0);
  });
});

// ─── calculateBatchRestockEta ───────────────────────────────────────

describe('calculateBatchRestockEta', () => {
  beforeEach(() => {
    dbMocks.resetAll();
  });

  it('returns results for multiple items', async () => {
    // Each calculateRestockEta call uses up to 5 selects (worst case)
    // For 2 items: up to 10 select calls. Provide empties for all.
    const empties = Array.from({ length: 15 }, () => [] as Record<string, unknown>[]);
    dbMocks.setupSelects(empties);

    const items = [
      { partId: PART_ID, facilityId: FACILITY_ID },
      { partId: '00000000-0000-0000-0000-000000000099', facilityId: FACILITY_ID },
    ];

    const results = await calculateBatchRestockEta(TENANT_ID, items);

    expect(results).toHaveLength(2);
    expect(results[0].partId).toBe(PART_ID);
    expect(results[1].partId).toBe('00000000-0000-0000-0000-000000000099');
    expect(results[0].leadTimeSource).toBe('default');
    expect(results[1].leadTimeSource).toBe('default');
  });
});

// ─── calculateSalesOrderLineEtas ────────────────────────────────────

describe('calculateSalesOrderLineEtas', () => {
  beforeEach(() => {
    dbMocks.resetAll();
  });

  it('throws when order not found', async () => {
    dbMocks.findFirstMock.mockResolvedValue(null);

    await expect(
      calculateSalesOrderLineEtas(TENANT_ID, '00000000-0000-0000-0000-nonexistent1'),
    ).rejects.toThrow('Sales order not found');
  });

  it('computes ETAs for lines with shortfall', async () => {
    dbMocks.findFirstMock.mockResolvedValue({
      id: 'so-1',
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      status: 'confirmed',
    });

    // First select: salesOrderLines query
    // Then for each line with shortfall, calculateRestockEta makes up to 5 selects
    dbMocks.setupSelects([
      // 1: salesOrderLines
      [
        {
          id: 'line-1',
          salesOrderId: 'so-1',
          tenantId: TENANT_ID,
          partId: PART_ID,
          lineNumber: 1,
          quantityOrdered: 100,
          quantityAllocated: 30,
          quantityShipped: 0,
        },
        {
          id: 'line-2',
          salesOrderId: 'so-1',
          tenantId: TENANT_ID,
          partId: '00000000-0000-0000-0000-000000000099',
          lineNumber: 2,
          quantityOrdered: 50,
          quantityAllocated: 50,
          quantityShipped: 0,
        },
      ],
      // 2+: selects for line-1 ETA (falls through to default)
      [], [], [], [], [],
    ]);

    const result = await calculateSalesOrderLineEtas(TENANT_ID, 'so-1');

    expect(result.orderId).toBe('so-1');
    expect(result.facilityId).toBe(FACILITY_ID);
    expect(result.lines).toHaveLength(2);

    // Line 1: shortfall of 70, should have ETA
    expect(result.lines[0].shortfall).toBe(70);
    expect(result.lines[0].eta).not.toBeNull();
    expect(result.lines[0].eta!.leadTimeSource).toBe('default');

    // Line 2: fully allocated, no shortfall, ETA should be null
    expect(result.lines[1].shortfall).toBe(0);
    expect(result.lines[1].eta).toBeNull();
  });
});
