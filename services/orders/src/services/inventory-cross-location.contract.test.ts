/**
 * Contract tests for cross-location inventory matrix and summary APIs.
 *
 * Verifies:
 *   - Matrix response shape and pagination metadata
 *   - Computed fields: available = qtyOnHand - qtyReserved
 *   - belowReorder / nearReorder flag logic (mutually exclusive)
 *   - Summary KPI aggregation logic
 *   - Filter behavior for partIds / facilityIds
 *   - Edge case: empty results when no inventory exists
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks (available inside vi.mock factories) ─────────────────

const { selectMock, schemaMock } = vi.hoisted(() => {
  const selectMock = vi.fn();
  const schemaMock = {
    inventoryLedger: {
      tenantId: { column: 'tenant_id' },
      facilityId: { column: 'facility_id' },
      partId: { column: 'part_id' },
      qtyOnHand: { column: 'qty_on_hand' },
      qtyReserved: { column: 'qty_reserved' },
      qtyInTransit: { column: 'qty_in_transit' },
      reorderPoint: { column: 'reorder_point' },
    },
    facilities: {
      id: { column: 'id' },
      name: { column: 'name' },
      code: { column: 'code' },
      isActive: { column: 'is_active' },
    },
    parts: {
      id: { column: 'id' },
      tenantId: { column: 'tenant_id' },
      partNumber: { column: 'part_number' },
      name: { column: 'name' },
      unitCost: { column: 'unit_cost' },
      isActive: { column: 'is_active' },
    },
  };
  return { selectMock, schemaMock };
});

vi.mock('@arda/db', () => ({
  db: { select: selectMock },
  schema: schemaMock,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((..._a: unknown[]) => ({ op: 'eq', args: _a })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', conditions: args })),
  sql: (...args: unknown[]) => ({ op: 'sql', args }),
  inArray: vi.fn((..._a: unknown[]) => ({ op: 'inArray', args: _a })),
}));

import {
  getCrossLocationMatrix,
  getCrossLocationSummary,
  type MatrixCell,
  type CrossLocationMatrixResult,
  type CrossLocationSummary,
} from './inventory-cross-location.service.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const TENANT = 'tenant-001';
const FACILITY_A = 'fac-aaa';
const FACILITY_B = 'fac-bbb';
const PART_1 = 'part-111';
const PART_2 = 'part-222';

/** Build a raw row as it would come back from the DB select. */
function makeRow(overrides: Partial<{
  facilityId: string;
  facilityName: string;
  facilityCode: string;
  partId: string;
  partNumber: string;
  partName: string;
  qtyOnHand: number;
  qtyReserved: number;
  qtyInTransit: number;
  reorderPoint: number;
}> = {}) {
  return {
    facilityId: FACILITY_A,
    facilityName: 'Plant Alpha',
    facilityCode: 'PLT-A',
    partId: PART_1,
    partNumber: 'PN-001',
    partName: 'Widget',
    qtyOnHand: 100,
    qtyReserved: 20,
    qtyInTransit: 5,
    reorderPoint: 50,
    ...overrides,
  };
}

// ─── Matrix mock wiring ──────────────────────────────────────────────────

/**
 * Configures the three chained DB calls for getCrossLocationMatrix:
 *   1. Paginated parts:  select -> from -> where -> orderBy -> limit -> offset
 *   2. Matrix rows:      select -> from -> innerJoin -> innerJoin -> where -> orderBy
 *   3. Count:            select -> from -> where
 */
function setupMatrixMocks(opts: {
  partIds?: string[];
  matrixRows?: ReturnType<typeof makeRow>[];
  totalParts?: number;
}) {
  const { partIds = [PART_1], matrixRows = [makeRow()], totalParts = 1 } = opts;

  // Call 1: paginated parts
  const c1Offset = vi.fn().mockResolvedValue(partIds.map((id) => ({ id })));
  const c1Limit = vi.fn(() => ({ offset: c1Offset }));
  const c1OrderBy = vi.fn(() => ({ limit: c1Limit }));
  const c1Where = vi.fn(() => ({ orderBy: c1OrderBy }));
  const c1From = vi.fn(() => ({ where: c1Where }));

  // Call 2: matrix rows
  const c2OrderBy = vi.fn().mockResolvedValue(matrixRows);
  const c2Where = vi.fn(() => ({ orderBy: c2OrderBy }));
  const c2Join2 = vi.fn(() => ({ where: c2Where }));
  const c2Join1 = vi.fn(() => ({ innerJoin: c2Join2 }));
  const c2From = vi.fn(() => ({ innerJoin: c2Join1 }));

  // Call 3: count
  const c3Where = vi.fn().mockResolvedValue([{ count: totalParts }]);
  const c3From = vi.fn(() => ({ where: c3Where }));

  selectMock
    .mockImplementationOnce(() => ({ from: c1From }))
    .mockImplementationOnce(() => ({ from: c2From }))
    .mockImplementationOnce(() => ({ from: c3From }));
}

// ─── Tests: Matrix ───────────────────────────────────────────────────────

describe('getCrossLocationMatrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Response shape ──────────────────────────────────────────────────

  it('returns correct response shape with data array and pagination', async () => {
    setupMatrixMocks({ partIds: [PART_1], matrixRows: [makeRow()], totalParts: 1 });

    const result: CrossLocationMatrixResult = await getCrossLocationMatrix({
      tenantId: TENANT,
    });

    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('pagination');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 50,
      total: 1,
      totalPages: 1,
    });
  });

  it('each MatrixCell contains all required fields', async () => {
    setupMatrixMocks({});

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    const cell: MatrixCell = result.data[0];

    const requiredKeys: (keyof MatrixCell)[] = [
      'facilityId', 'facilityName', 'facilityCode',
      'partId', 'partNumber', 'partName',
      'qtyOnHand', 'qtyReserved', 'qtyInTransit',
      'available', 'reorderPoint', 'belowReorder', 'nearReorder',
    ];
    for (const key of requiredKeys) {
      expect(cell).toHaveProperty(key);
    }
  });

  // ── Computed: available ─────────────────────────────────────────────

  it('computes available = qtyOnHand - qtyReserved', async () => {
    const row = makeRow({ qtyOnHand: 200, qtyReserved: 75 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].available).toBe(125);
  });

  it('available can be negative when qtyReserved > qtyOnHand', async () => {
    const row = makeRow({ qtyOnHand: 10, qtyReserved: 25 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].available).toBe(-15);
  });

  // ── Computed: belowReorder ──────────────────────────────────────────

  it('belowReorder is true when available < reorderPoint', async () => {
    const row = makeRow({ qtyOnHand: 50, qtyReserved: 10, reorderPoint: 50 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].belowReorder).toBe(true);
  });

  it('belowReorder is true when available exactly equals reorderPoint', async () => {
    // available = 60 - 10 = 50, reorderPoint = 50 → belowReorder (<=)
    const row = makeRow({ qtyOnHand: 60, qtyReserved: 10, reorderPoint: 50 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].belowReorder).toBe(true);
  });

  it('belowReorder is false when available > reorderPoint', async () => {
    // available = 100 - 10 = 90, reorderPoint = 50 → NOT belowReorder
    const row = makeRow({ qtyOnHand: 100, qtyReserved: 10, reorderPoint: 50 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].belowReorder).toBe(false);
  });

  // ── Computed: nearReorder (exclusive of belowReorder) ───────────────

  it('nearReorder is true when within 20% buffer above reorderPoint', async () => {
    // available = 65 - 10 = 55, reorderPoint = 50 → 50 < 55 <= 60 → nearReorder
    const row = makeRow({ qtyOnHand: 65, qtyReserved: 10, reorderPoint: 50 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].belowReorder).toBe(false);
    expect(result.data[0].nearReorder).toBe(true);
  });

  it('nearReorder is false when belowReorder is true (mutually exclusive)', async () => {
    // available = 40 - 10 = 30, reorderPoint = 50 → belowReorder=true, nearReorder=false
    const row = makeRow({ qtyOnHand: 40, qtyReserved: 10, reorderPoint: 50 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].belowReorder).toBe(true);
    expect(result.data[0].nearReorder).toBe(false);
  });

  it('nearReorder is false when available is well above buffer', async () => {
    // available = 100 - 10 = 90, reorderPoint = 50, buffer = 60 → neither
    const row = makeRow({ qtyOnHand: 100, qtyReserved: 10, reorderPoint: 50 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].belowReorder).toBe(false);
    expect(result.data[0].nearReorder).toBe(false);
  });

  it('nearReorder boundary: exactly at reorderPoint * 1.2', async () => {
    // available = 70 - 10 = 60, reorderPoint = 50 → 50 < 60 <= 60 → nearReorder
    const row = makeRow({ qtyOnHand: 70, qtyReserved: 10, reorderPoint: 50 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].belowReorder).toBe(false);
    expect(result.data[0].nearReorder).toBe(true);
  });

  it('nearReorder is false just above 1.2x threshold', async () => {
    // available = 71 - 10 = 61, reorderPoint = 50, buffer = 60 → above → false
    const row = makeRow({ qtyOnHand: 71, qtyReserved: 10, reorderPoint: 50 });
    setupMatrixMocks({ matrixRows: [row] });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });
    expect(result.data[0].belowReorder).toBe(false);
    expect(result.data[0].nearReorder).toBe(false);
  });

  // ── Pagination ──────────────────────────────────────────────────────

  it('respects custom page and pageSize', async () => {
    setupMatrixMocks({ partIds: [PART_1, PART_2], matrixRows: [], totalParts: 100 });

    const result = await getCrossLocationMatrix({
      tenantId: TENANT,
      page: 3,
      pageSize: 10,
    });

    expect(result.pagination.page).toBe(3);
    expect(result.pagination.pageSize).toBe(10);
    expect(result.pagination.total).toBe(100);
    expect(result.pagination.totalPages).toBe(10);
  });

  it('clamps pageSize to 500 maximum', async () => {
    setupMatrixMocks({ partIds: [PART_1], matrixRows: [makeRow()], totalParts: 1 });

    const result = await getCrossLocationMatrix({
      tenantId: TENANT,
      pageSize: 999,
    });

    expect(result.pagination.pageSize).toBe(500);
  });

  // ── Empty results ───────────────────────────────────────────────────

  it('returns empty data with zeroed pagination when no parts exist', async () => {
    // Paginated parts returns empty
    const c1Offset = vi.fn().mockResolvedValue([]);
    const c1Limit = vi.fn(() => ({ offset: c1Offset }));
    const c1OrderBy = vi.fn(() => ({ limit: c1Limit }));
    const c1Where = vi.fn(() => ({ orderBy: c1OrderBy }));
    const c1From = vi.fn(() => ({ where: c1Where }));

    selectMock.mockImplementationOnce(() => ({ from: c1From }));

    const result = await getCrossLocationMatrix({ tenantId: TENANT });

    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 0,
    });
  });

  // ── Filters ─────────────────────────────────────────────────────────

  it('calls db.select three times for a standard matrix request', async () => {
    setupMatrixMocks({ partIds: [PART_1] });

    await getCrossLocationMatrix({ tenantId: TENANT });

    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it('accepts partIds and facilityIds filters without error', async () => {
    setupMatrixMocks({ matrixRows: [makeRow()] });

    const result = await getCrossLocationMatrix({
      tenantId: TENANT,
      partIds: [PART_1, PART_2],
      facilityIds: [FACILITY_A, FACILITY_B],
    });

    expect(result.data).toHaveLength(1);
  });

  // ── Multiple rows ───────────────────────────────────────────────────

  it('returns multiple cells for multiple facilities and parts', async () => {
    const rows = [
      makeRow({ facilityId: FACILITY_A, facilityCode: 'PLT-A', partId: PART_1 }),
      makeRow({ facilityId: FACILITY_A, facilityCode: 'PLT-A', partId: PART_2 }),
      makeRow({ facilityId: FACILITY_B, facilityCode: 'PLT-B', partId: PART_1 }),
      makeRow({ facilityId: FACILITY_B, facilityCode: 'PLT-B', partId: PART_2 }),
    ];
    setupMatrixMocks({ partIds: [PART_1, PART_2], matrixRows: rows, totalParts: 2 });

    const result = await getCrossLocationMatrix({ tenantId: TENANT });

    expect(result.data).toHaveLength(4);
    expect(result.pagination.total).toBe(2); // total parts, not cells
  });
});

// ─── Tests: Summary ──────────────────────────────────────────────────────

describe('getCrossLocationSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Configures the single chained DB call for getCrossLocationSummary:
   *   select -> from -> innerJoin -> innerJoin -> where -> (resolves)
   */
  function setupSummaryMock(row: Partial<{
    totalInTransitValue: number | string;
    pendingTransferCount: number;
    facilitiesBelowReorderPoint: number;
    facilitiesNearReorderPoint: number;
  }> = {}) {
    const defaultRow = {
      totalInTransitValue: '12500.00',
      pendingTransferCount: 3,
      facilitiesBelowReorderPoint: 5,
      facilitiesNearReorderPoint: 2,
      ...row,
    };

    const cWhere = vi.fn().mockResolvedValue([defaultRow]);
    const cJoin2 = vi.fn(() => ({ where: cWhere }));
    const cJoin1 = vi.fn(() => ({ innerJoin: cJoin2 }));
    const cFrom = vi.fn(() => ({ innerJoin: cJoin1 }));

    selectMock.mockImplementationOnce(() => ({ from: cFrom }));
  }

  // ── Response shape ──────────────────────────────────────────────────

  it('returns correct response shape with all KPI fields', async () => {
    setupSummaryMock();

    const result: CrossLocationSummary = await getCrossLocationSummary({
      tenantId: TENANT,
    });

    const requiredKeys: (keyof CrossLocationSummary)[] = [
      'totalInTransitValue',
      'pendingTransferCount',
      'averageNetworkLeadTimeDays',
      'facilitiesBelowReorderPoint',
      'facilitiesNearReorderPoint',
    ];
    for (const key of requiredKeys) {
      expect(result).toHaveProperty(key);
    }
  });

  it('all KPI values are numbers', async () => {
    setupSummaryMock();

    const result = await getCrossLocationSummary({ tenantId: TENANT });

    expect(typeof result.totalInTransitValue).toBe('number');
    expect(typeof result.pendingTransferCount).toBe('number');
    expect(typeof result.averageNetworkLeadTimeDays).toBe('number');
    expect(typeof result.facilitiesBelowReorderPoint).toBe('number');
    expect(typeof result.facilitiesNearReorderPoint).toBe('number');
  });

  // ── Aggregation correctness ─────────────────────────────────────────

  it('parses totalInTransitValue from DB string to number', async () => {
    setupSummaryMock({ totalInTransitValue: '98765.4321' });

    const result = await getCrossLocationSummary({ tenantId: TENANT });

    expect(result.totalInTransitValue).toBeCloseTo(98765.4321);
  });

  it('returns 0 for totalInTransitValue when DB returns null-ish', async () => {
    setupSummaryMock({ totalInTransitValue: undefined as unknown as string });

    const result = await getCrossLocationSummary({ tenantId: TENANT });

    expect(result.totalInTransitValue).toBe(0);
  });

  it('returns mocked average lead time of 3.5 days', async () => {
    setupSummaryMock();

    const result = await getCrossLocationSummary({ tenantId: TENANT });

    expect(result.averageNetworkLeadTimeDays).toBe(3.5);
  });

  it('passes through pendingTransferCount from DB', async () => {
    setupSummaryMock({ pendingTransferCount: 42 });

    const result = await getCrossLocationSummary({ tenantId: TENANT });

    expect(result.pendingTransferCount).toBe(42);
  });

  it('passes through belowReorderPoint count from DB', async () => {
    setupSummaryMock({ facilitiesBelowReorderPoint: 7 });

    const result = await getCrossLocationSummary({ tenantId: TENANT });

    expect(result.facilitiesBelowReorderPoint).toBe(7);
  });

  it('passes through nearReorderPoint count from DB', async () => {
    setupSummaryMock({ facilitiesNearReorderPoint: 4 });

    const result = await getCrossLocationSummary({ tenantId: TENANT });

    expect(result.facilitiesNearReorderPoint).toBe(4);
  });

  // ── Zero / empty data ───────────────────────────────────────────────

  it('handles zero counts gracefully', async () => {
    setupSummaryMock({
      totalInTransitValue: '0',
      pendingTransferCount: 0,
      facilitiesBelowReorderPoint: 0,
      facilitiesNearReorderPoint: 0,
    });

    const result = await getCrossLocationSummary({ tenantId: TENANT });

    expect(result.totalInTransitValue).toBe(0);
    expect(result.pendingTransferCount).toBe(0);
    expect(result.facilitiesBelowReorderPoint).toBe(0);
    expect(result.facilitiesNearReorderPoint).toBe(0);
  });

  // ── Filter ──────────────────────────────────────────────────────────

  it('accepts facilityIds filter without error', async () => {
    setupSummaryMock();

    const result = await getCrossLocationSummary({
      tenantId: TENANT,
      facilityIds: [FACILITY_A],
    });

    expect(result).toHaveProperty('totalInTransitValue');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
