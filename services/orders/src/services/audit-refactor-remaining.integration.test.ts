/**
 * Integration tests for remaining service-level audit refactor (Ticket #253, iteration 5)
 *
 * Validates that capacity-scheduler, completion-posting, routing-engine,
 * production-exception, material-consumption, and inventory-ledger services
 * use writeAuditEntry() with correct action names, entity types, and metadata.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntryInput } from '@arda/db';

// ─── Mocks (hoisted) ────────────────────────────────────────────────

const { writeAuditEntryMock, auditCalls } = vi.hoisted(() => {
  const auditCalls: AuditEntryInput[] = [];
  const writeAuditEntryMock = vi.fn(async (_dbOrTx: unknown, entry: AuditEntryInput) => {
    auditCalls.push(entry);
    return { id: `audit-${auditCalls.length}`, hashChain: 'test-hash', sequenceNumber: auditCalls.length };
  });
  return { writeAuditEntryMock, auditCalls };
});

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => {
    const t = { __table: name } as any;
    t.tenantId = { column: 'tenant_id' };
    t.id = { column: 'id' };
    t.status = { column: 'status' };
    t.woNumber = { column: 'wo_number' };
    t.quantityToProduce = { column: 'quantity_to_produce' };
    t.quantityProduced = { column: 'quantity_produced' };
    t.quantityScrapped = { column: 'quantity_scrapped' };
    t.workOrderId = { column: 'work_order_id' };
    t.workCenterId = { column: 'work_center_id' };
    t.facilityId = { column: 'facility_id' };
    t.partId = { column: 'part_id' };
    t.isActive = { column: 'is_active' };
    t.isExpedited = { column: 'is_expedited' };
    t.priority = { column: 'priority' };
    t.parentWorkOrderId = { column: 'parent_work_order_id' };
    t.routingTemplateId = { column: 'routing_template_id' };
    t.holdReason = { column: 'hold_reason' };
    t.holdNotes = { column: 'hold_notes' };
    t.kanbanCardId = { column: 'kanban_card_id' };
    t.loopId = { column: 'loop_id' };
    t.currentStage = { column: 'current_stage' };
    t.stepNumber = { column: 'step_number' };
    t.operationName = { column: 'operation_name' };
    t.parentPartId = { column: 'parent_part_id' };
    t.childPartId = { column: 'child_part_id' };
    t.quantityPer = { column: 'quantity_per' };
    t.partNumber = { column: 'part_number' };
    t.qtyOnHand = { column: 'qty_on_hand' };
    t.qtyReserved = { column: 'qty_reserved' };
    t.qtyInTransit = { column: 'qty_in_transit' };
    return t;
  };

  return {
    workOrders: table('work_orders'),
    workOrderRoutings: table('work_order_routings'),
    workCenters: table('work_centers'),
    workCenterCapacityWindows: table('work_center_capacity_windows'),
    productionOperationLogs: table('production_operation_logs'),
    productionQueueEntries: table('production_queue_entries'),
    kanbanCards: table('kanban_cards'),
    kanbanLoops: table('kanban_loops'),
    cardStageTransitions: table('card_stage_transitions'),
    routingTemplates: table('routing_templates'),
    routingTemplateSteps: table('routing_template_steps'),
    bomItems: table('bom_items'),
    parts: table('parts'),
    inventoryLedger: table('inventory_ledger'),
    facilities: table('facilities'),
  };
});

const { dbMock } = vi.hoisted(() => {
  function queryResult<T>(result: T) {
    return {
      execute: async () => result,
      then: (
        resolve: (value: T) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
      returning: async () => result,
    };
  }

  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => builder;
    builder.orderBy = () => builder;
    builder.innerJoin = () => builder;
    builder.for = () => builder;
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  function makeUpdateBuilder() {
    const query: any = {};
    query.set = () => query;
    query.where = () => query;
    query.execute = async () => undefined;
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(undefined).then(resolve, reject);
    query.returning = async () => [];
    return query;
  }

  let selectResultsQueue: unknown[] = [];

  function makeTx() {
    const tx: any = {};
    tx.select = vi.fn((..._args: unknown[]) => makeSelectBuilder(selectResultsQueue.shift() ?? []));
    tx.update = vi.fn(() => makeUpdateBuilder());
    tx.execute = vi.fn(async () => undefined);
    tx.insert = vi.fn((_table: unknown) => ({
      values: (values: unknown) => makeInsertChain(values),
    }));
    tx.delete = vi.fn(() => ({
      where: () => ({ execute: async () => undefined }),
    }));
    return tx;
  }

  function makeInsertChain(values: unknown) {
    const rows = Array.isArray(values) ? values : [values];
    const defaultReturning = rows.map((v: any, i: number) => ({ ...v, id: `inserted-${i}` }));
    return {
      ...queryResult(rows),
      returning: (..._args: unknown[]) => ({
        execute: async () => defaultReturning,
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown
        ) => Promise.resolve(defaultReturning).then(resolve, reject),
      }),
      onConflictDoUpdate: () => ({
        returning: async () =>
          rows.map((v: any, i: number) => ({ ...v, id: `upserted-${i}` })),
      }),
    };
  }

  const dbMock = {
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
    select: vi.fn((..._args: unknown[]) => makeSelectBuilder(selectResultsQueue.shift() ?? [])),
    update: vi.fn(() => makeUpdateBuilder()),
    insert: vi.fn(() => ({
      values: (values: unknown) => makeInsertChain(values),
    })),
    execute: vi.fn(async () => undefined),
    _setSelectResults: (results: unknown[]) => {
      selectResultsQueue = [...results];
    },
  };

  return { dbMock };
});

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

// ─── Module Mocks ────────────────────────────────────────────────────

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
  lt: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: writeAuditEntryMock,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@arda/shared-types', () => ({
  ROUTING_STEP_VALID_TRANSITIONS: {
    pending: ['in_progress', 'skipped'],
    in_progress: ['complete', 'skipped'],
    complete: [],
    skipped: [],
  },
}));

// ─── Import after mocks ─────────────────────────────────────────────

import { createCapacityWindow, allocateCapacity, releaseCapacity } from './capacity-scheduler.service.js';
import { reportQuantity } from './completion-posting.service.js';
import { checkScrapThreshold, handleMaterialShortageHold, checkShortCompletion } from './production-exception.service.js';
import { recordMaterialConsumption } from './material-consumption.service.js';
import { adjustQuantity } from './inventory-ledger.service.js';

// ─── Tests ───────────────────────────────────────────────────────────

describe('Remaining Service Audit Refactor — writeAuditEntry', () => {
  beforeEach(() => {
    auditCalls.length = 0;
    writeAuditEntryMock.mockClear();
    publishMock.mockClear();
    dbMock._setSelectResults([]);
  });

  describe('capacity-scheduler', () => {
    it('createCapacityWindow emits capacity_window.created audit', async () => {
      // Mock: work center exists
      dbMock._setSelectResults([[{ id: 'wc-1' }]]);

      // Mock: insert returns an id via .returning().execute()
      dbMock.insert.mockReturnValueOnce({
        values: () => ({
          returning: () => ({
            execute: async () => [{ id: 'cw-1' }],
            then: (r: any, j?: any) => Promise.resolve([{ id: 'cw-1' }]).then(r, j),
          }),
          execute: async () => undefined,
        }),
      } as any);

      await createCapacityWindow({
        tenantId: 'tenant-1',
        workCenterId: 'wc-1',
        dayOfWeek: 1,
        startHour: 8,
        endHour: 17,
        availableMinutes: 480,
        effectiveDate: new Date(),
        userId: 'user-1',
      });

      const audit = auditCalls.find((c) => c.action === 'capacity_window.created');
      expect(audit).toBeDefined();
      expect(audit?.entityType).toBe('work_center_capacity_window');
      expect(audit?.entityId).toBe('cw-1');
      expect(audit?.newState).toMatchObject({ workCenterId: 'wc-1', dayOfWeek: 1 });
    });

    it('allocateCapacity emits capacity_window.allocated audit', async () => {
      dbMock._setSelectResults([[{
        id: 'cw-1',
        workCenterId: 'wc-1',
        tenantId: 'tenant-1',
        availableMinutes: 480,
        allocatedMinutes: 0,
      }]]);

      await allocateCapacity({
        tenantId: 'tenant-1',
        workCenterId: 'wc-1',
        windowId: 'cw-1',
        minutes: 60,
      });

      const audit = auditCalls.find((c) => c.action === 'capacity_window.allocated');
      expect(audit).toBeDefined();
      expect(audit?.previousState).toMatchObject({ allocatedMinutes: 0 });
      expect(audit?.newState).toMatchObject({ allocatedMinutes: 60, minutesAdded: 60 });
    });

    it('releaseCapacity emits capacity_window.released audit', async () => {
      dbMock._setSelectResults([[{
        id: 'cw-1',
        workCenterId: 'wc-1',
        tenantId: 'tenant-1',
        availableMinutes: 480,
        allocatedMinutes: 120,
      }]]);

      await releaseCapacity({
        tenantId: 'tenant-1',
        workCenterId: 'wc-1',
        windowId: 'cw-1',
        minutes: 60,
      });

      const audit = auditCalls.find((c) => c.action === 'capacity_window.released');
      expect(audit).toBeDefined();
      expect(audit?.previousState).toMatchObject({ allocatedMinutes: 120 });
      expect(audit?.newState).toMatchObject({ allocatedMinutes: 60, minutesReleased: 60 });
    });
  });

  describe('completion-posting', () => {
    it('reportQuantity emits wo.quantity_reported audit', async () => {
      dbMock._setSelectResults([[{
        id: 'wo-1',
        tenantId: 'tenant-1',
        status: 'in_progress',
        quantityToProduce: 100,
        quantityProduced: 50,
        quantityScrapped: 2,
      }]]);

      await reportQuantity({
        tenantId: 'tenant-1',
        workOrderId: 'wo-1',
        quantityGood: 10,
        quantityScrapped: 1,
        userId: 'user-1',
      });

      const audit = auditCalls.find((c) => c.action === 'wo.quantity_reported');
      expect(audit).toBeDefined();
      expect(audit?.entityType).toBe('work_order');
      expect(audit?.previousState).toMatchObject({ quantityProduced: 50, quantityScrapped: 2 });
      expect(audit?.newState).toMatchObject({ quantityProduced: 60, quantityScrapped: 3 });
    });
  });

  describe('production-exception', () => {
    it('checkScrapThreshold emits work_order.rework audit when threshold exceeded', async () => {
      dbMock._setSelectResults([[{
        id: 'wo-1',
        tenantId: 'tenant-1',
        woNumber: 'WO-001',
        quantityToProduce: 100,
        quantityProduced: 80,
        quantityScrapped: 20,
        status: 'in_progress',
        kanbanCardId: null,
        partId: 'part-1',
        facilityId: 'fac-1',
        isExpedited: false,
        isRework: false,
        parentWorkOrderId: null,
        routingTemplateId: null,
        priority: 50,
      }]]);

      // Mock insert for rework WO (.returning().execute() chain)
      dbMock.insert.mockReturnValueOnce({
        values: () => ({
          returning: () => ({
            execute: async () => [{ id: 'wo-rework-1' }],
            then: (r: any, j?: any) => Promise.resolve([{ id: 'wo-rework-1' }]).then(r, j),
          }),
          execute: async () => undefined,
        }),
      } as any);
      // Mock insert for queue entry
      dbMock.insert.mockReturnValueOnce({
        values: () => ({
          execute: async () => undefined,
          then: (r: any, j?: any) => Promise.resolve(undefined).then(r, j),
        }),
      } as any);
      // Mock insert for production operation log
      dbMock.insert.mockReturnValueOnce({
        values: () => ({
          execute: async () => undefined,
          then: (r: any, j?: any) => Promise.resolve(undefined).then(r, j),
        }),
      } as any);

      const result = await checkScrapThreshold('tenant-1', 'wo-1', 10);
      expect(result.exceededThreshold).toBe(true);

      const audit = auditCalls.find((c) => c.action === 'work_order.rework');
      expect(audit).toBeDefined();
      expect(audit?.entityType).toBe('work_order');
      expect(audit?.metadata).toMatchObject({
        source: 'production_exception',
        systemActor: 'production_exception',
      });
    });

    it('handleMaterialShortageHold emits audit with systemActor when no userId', async () => {
      dbMock._setSelectResults([
        // WO select
        [{
          id: 'wo-1',
          tenantId: 'tenant-1',
          woNumber: 'WO-001',
          holdReason: 'material_shortage',
          holdNotes: null,
          kanbanCardId: 'card-1',
        }],
        // Card select
        [{ id: 'card-1', loopId: 'loop-1', currentStage: 'ordered' }],
      ]);

      // Mock insert for production operation log
      dbMock.insert.mockReturnValueOnce({
        values: () => ({ execute: async () => undefined }),
      } as any);

      await handleMaterialShortageHold('tenant-1', 'wo-1');

      const audit = auditCalls.find((c) => c.action === 'production_exception.material_shortage_requeue');
      expect(audit).toBeDefined();
      expect(audit?.userId).toBeNull();
      expect(audit?.metadata).toMatchObject({
        systemActor: 'production_exception',
      });
    });
  });

  describe('material-consumption', () => {
    it('recordMaterialConsumption emits material_consumption.recorded audit', async () => {
      dbMock._setSelectResults([
        // WO select
        [{ id: 'wo-1', partId: 'part-1' }],
        // BOM select (inner join result)
        [
          { childPartId: 'mat-1', childPartNumber: 'MAT-001', quantityPer: 2.5 },
        ],
      ]);

      // Mock insert for production operation log
      dbMock.insert.mockReturnValueOnce({
        values: () => ({ execute: async () => undefined }),
      } as any);

      await recordMaterialConsumption({
        tenantId: 'tenant-1',
        workOrderId: 'wo-1',
        stepId: 'step-1',
        quantityProduced: 10,
        userId: 'user-1',
      });

      const audit = auditCalls.find((c) => c.action === 'material_consumption.recorded');
      expect(audit).toBeDefined();
      expect(audit?.entityType).toBe('work_order');
      expect(audit?.newState).toMatchObject({
        stepId: 'step-1',
        quantityProduced: 10,
        linesConsumed: 1,
      });
    });
  });

  describe('inventory-ledger', () => {
    it('adjustQuantity emits inventory.adjusted audit', async () => {
      // Mock transaction: select row for update → update → writeAuditEntry
      dbMock.transaction.mockImplementationOnce(async (callback: any) => {
        const tx: any = {};
        tx.select = vi.fn(() => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: () =>
                  Promise.resolve([{
                    id: 'inv-1',
                    tenantId: 'tenant-1',
                    facilityId: 'fac-1',
                    partId: 'part-1',
                    qtyOnHand: 100,
                    qtyReserved: 10,
                    qtyInTransit: 5,
                  }]),
              }),
            }),
          }),
        }));
        tx.update = vi.fn(() => ({
          set: () => ({
            where: () => ({
              execute: async () => undefined,
              then: (r: any) => Promise.resolve(undefined).then(r),
            }),
          }),
        }));
        return callback(tx);
      });

      await adjustQuantity({
        tenantId: 'tenant-1',
        facilityId: 'fac-1',
        partId: 'part-1',
        field: 'qtyOnHand',
        adjustmentType: 'increment',
        quantity: 50,
        source: 'cycle_count',
        userId: 'user-1',
      });

      const audit = auditCalls.find((c) => c.action === 'inventory.adjusted');
      expect(audit).toBeDefined();
      expect(audit?.entityType).toBe('inventory_ledger');
      expect(audit?.previousState).toMatchObject({ qtyOnHand: 100 });
      expect(audit?.newState).toMatchObject({ qtyOnHand: 150 });
      expect(audit?.metadata).toMatchObject({
        facilityId: 'fac-1',
        partId: 'part-1',
        adjustmentType: 'increment',
        quantity: 50,
        source: 'cycle_count',
      });
    });
  });
});
