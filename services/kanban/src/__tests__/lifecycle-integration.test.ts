import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════
// LIFECYCLE INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════
//
// Tests the enhanced lifecycle transition orchestrator including:
//   - Full lifecycle cycle validation (happy path through all stages)
//   - RBAC enforcement (role-based access per transition rule)
//   - Idempotency (duplicate key deduplication)
//   - Domain event emission (lifecycle.transition, queue_entry, etc.)
//   - Rejection audit trail (proper error codes on failures)
//   - Transition matrix completeness
//
// ═══════════════════════════════════════════════════════════════════════

// ─── Mock Infrastructure ────────────────────────────────────────────

const {
  mockPublish,
  mockFindFirst,
  mockFindMany,
  mockInsert,
  mockUpdate,
  mockTransaction,
  mockKanbanLoopsFindFirst,
  mockKanbanLoopsFindMany,
  mockTransitionFindFirst,
  mockSelect,
  mockFrom,
  mockSelectWhere,
  mockSelectOrderBy,
  mockSelectLimit,
} = vi.hoisted(() => {
  const selectQuery = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };

  selectQuery.from.mockReturnValue(selectQuery);
  selectQuery.where.mockReturnValue(selectQuery);
  selectQuery.orderBy.mockReturnValue(selectQuery);
  selectQuery.limit.mockResolvedValue([]);

  return {
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockKanbanLoopsFindFirst: vi.fn(),
  mockKanbanLoopsFindMany: vi.fn(),
  mockTransitionFindFirst: vi.fn(),
  mockSelect: vi.fn(() => selectQuery),
  mockFrom: vi.fn().mockReturnThis(),
  mockSelectWhere: selectQuery.where,
  mockSelectOrderBy: selectQuery.orderBy,
  mockSelectLimit: selectQuery.limit,
  };
});

vi.mock('@arda/db', () => ({
  db: {
    query: {
      kanbanCards: { findFirst: mockFindFirst, findMany: mockFindMany },
      kanbanLoops: { findFirst: mockKanbanLoopsFindFirst, findMany: mockKanbanLoopsFindMany },
      cardStageTransitions: { findFirst: mockTransitionFindFirst, findMany: mockFindMany },
    },
    transaction: mockTransaction,
    insert: mockInsert,
    update: mockUpdate,
    select: mockSelect,
    from: mockFrom,
  },
  schema: {
    kanbanCards: { id: 'id', tenantId: 'tenant_id', completedCycles: 'completed_cycles' },
    kanbanLoops: {},
    cardStageTransitions: {},
    kanbanParameterHistory: {},
  },
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'mock', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({ publish: mockPublish })),
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../middleware/error-handler.js', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    code?: string;
    constructor(statusCode: number, message: string, code?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
      this.name = 'AppError';
    }
  },
}));

// ─── Import the module under test ───────────────────────────────────

import {
  VALID_TRANSITIONS,
  TRANSITION_MATRIX,
  TRANSITION_RULES,
  isValidTransition,
  isRoleAllowed,
  isLoopTypeAllowed,
  isMethodAllowed,
  transitionCard,
  triggerCardByScan,
  getCardHistory,
} from '../services/card-lifecycle.service.js';

import { AppError } from '../middleware/error-handler.js';

beforeEach(() => {
  mockSelectLimit.mockReset();
  mockSelectLimit.mockResolvedValue([]);
});

// ─── Test Fixtures ──────────────────────────────────────────────────

function makeCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-001',
    tenantId: 'tenant-001',
    loopId: 'loop-001',
    cardNumber: 1,
    currentStage: 'created',
    currentStageEnteredAt: new Date('2025-01-01T00:00:00Z'),
    isActive: true,
    completedCycles: 0,
    linkedPurchaseOrderId: null,
    linkedWorkOrderId: null,
    linkedTransferOrderId: null,
    loop: {
      id: 'loop-001',
      tenantId: 'tenant-001',
      partId: 'part-001',
      facilityId: 'facility-001',
      loopType: 'procurement',
      cardMode: 'single',
      orderQuantity: 100,
      numberOfCards: 1,
      primarySupplierId: 'supplier-001',
      sourceFacilityId: null,
      isActive: true,
    },
    ...overrides,
  };
}

function makeTransition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trans-001',
    tenantId: 'tenant-001',
    cardId: 'card-001',
    loopId: 'loop-001',
    cycleNumber: 1,
    fromStage: 'created',
    toStage: 'triggered',
    transitionedAt: new Date(),
    transitionedByUserId: 'user-001',
    method: 'manual',
    notes: null,
    metadata: {},
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION MATRIX TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('Transition Matrix', () => {
  it('has TRANSITION_MATRIX as alias for VALID_TRANSITIONS', () => {
    expect(TRANSITION_MATRIX).toBe(VALID_TRANSITIONS);
  });

  it('defines the complete kanban flow', () => {
    expect(VALID_TRANSITIONS.created).toEqual(['triggered']);
    expect(VALID_TRANSITIONS.triggered).toEqual(['ordered']);
    expect(VALID_TRANSITIONS.ordered).toEqual(['in_transit', 'received']);
    expect(VALID_TRANSITIONS.in_transit).toEqual(['received']);
    expect(VALID_TRANSITIONS.received).toEqual(['restocked']);
    expect(VALID_TRANSITIONS.restocked).toEqual(['triggered']);
  });

  it('covers all 6 stages', () => {
    const stages = ['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked'];
    for (const stage of stages) {
      expect(VALID_TRANSITIONS).toHaveProperty(stage);
      expect(Array.isArray(VALID_TRANSITIONS[stage])).toBe(true);
      expect(VALID_TRANSITIONS[stage].length).toBeGreaterThan(0);
    }
  });

  describe('isValidTransition', () => {
    it('allows created → triggered', () => {
      expect(isValidTransition('created', 'triggered')).toBe(true);
    });

    it('allows restocked → triggered (cycle restart)', () => {
      expect(isValidTransition('restocked', 'triggered')).toBe(true);
    });

    it('allows ordered → received (skip in_transit for local)', () => {
      expect(isValidTransition('ordered', 'received')).toBe(true);
    });

    it('rejects non-adjacent transitions', () => {
      expect(isValidTransition('created', 'ordered')).toBe(false);
      expect(isValidTransition('triggered', 'received')).toBe(false);
      expect(isValidTransition('created', 'restocked')).toBe(false);
    });

    it('rejects backward transitions', () => {
      expect(isValidTransition('triggered', 'created')).toBe(false);
      expect(isValidTransition('received', 'ordered')).toBe(false);
    });

    it('rejects unknown stages', () => {
      expect(isValidTransition('unknown', 'triggered')).toBe(false);
      expect(isValidTransition('created', 'unknown')).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION RULES TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('Transition Rules', () => {
  it('has rules for every valid transition', () => {
    for (const [from, toList] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of toList) {
        const rule = TRANSITION_RULES.find((r) => r.from === from && r.to === to);
        expect(rule, `Missing rule for ${from} → ${to}`).toBeDefined();
      }
    }
  });

  it('every rule has at least one allowed role', () => {
    for (const rule of TRANSITION_RULES) {
      expect(rule.allowedRoles.length, `Rule ${rule.from}→${rule.to} has no roles`).toBeGreaterThan(0);
    }
  });

  it('every rule has at least one allowed loop type', () => {
    for (const rule of TRANSITION_RULES) {
      expect(rule.allowedLoopTypes.length, `Rule ${rule.from}→${rule.to} has no loop types`).toBeGreaterThan(0);
    }
  });

  it('every rule has at least one allowed method', () => {
    for (const rule of TRANSITION_RULES) {
      expect(rule.allowedMethods.length, `Rule ${rule.from}→${rule.to} has no methods`).toBeGreaterThan(0);
    }
  });

  describe('isRoleAllowed', () => {
    it('tenant_admin can perform any transition', () => {
      for (const rule of TRANSITION_RULES) {
        expect(isRoleAllowed(rule.from, rule.to, 'tenant_admin')).toBe(true);
      }
    });

    it('inventory_manager can trigger cards', () => {
      expect(isRoleAllowed('created', 'triggered', 'inventory_manager')).toBe(true);
    });

    it('salesperson cannot trigger cards', () => {
      expect(isRoleAllowed('created', 'triggered', 'salesperson')).toBe(false);
    });

    it('receiving_manager can receive goods', () => {
      expect(isRoleAllowed('in_transit', 'received', 'receiving_manager')).toBe(true);
    });

    it('ecommerce_director cannot transition cards', () => {
      expect(isRoleAllowed('created', 'triggered', 'ecommerce_director')).toBe(false);
    });
  });

  describe('isLoopTypeAllowed', () => {
    it('procurement loops can go ordered → in_transit', () => {
      expect(isLoopTypeAllowed('ordered', 'in_transit', 'procurement')).toBe(true);
    });

    it('production loops cannot go ordered → in_transit', () => {
      expect(isLoopTypeAllowed('ordered', 'in_transit', 'production')).toBe(false);
    });

    it('production loops can go ordered → received directly', () => {
      expect(isLoopTypeAllowed('ordered', 'received', 'production')).toBe(true);
    });

    it('all loop types can trigger', () => {
      expect(isLoopTypeAllowed('created', 'triggered', 'procurement')).toBe(true);
      expect(isLoopTypeAllowed('created', 'triggered', 'production')).toBe(true);
      expect(isLoopTypeAllowed('created', 'triggered', 'transfer')).toBe(true);
    });
  });

  describe('isMethodAllowed', () => {
    it('qr_scan is allowed for trigger', () => {
      expect(isMethodAllowed('created', 'triggered', 'qr_scan')).toBe(true);
    });

    it('qr_scan is not allowed for triggered → ordered', () => {
      expect(isMethodAllowed('triggered', 'ordered', 'qr_scan')).toBe(false);
    });

    it('manual is allowed for all transitions', () => {
      for (const rule of TRANSITION_RULES) {
        expect(isMethodAllowed(rule.from, rule.to, 'manual')).toBe(true);
      }
    });

    it('system is allowed for all transitions', () => {
      for (const rule of TRANSITION_RULES) {
        expect(isMethodAllowed(rule.from, rule.to, 'system')).toBe(true);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION CARD ORCHESTRATOR TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('transitionCard Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: transaction executes the callback immediately
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeTransition()]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeCard({ currentStage: 'triggered' })]),
            }),
          }),
        }),
      };
      return cb(tx);
    });
  });

  it('completes a valid transition (created → triggered)', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard());

    const result = await transitionCard({
      cardId: 'card-001',
      tenantId: 'tenant-001',
      toStage: 'triggered',
      userId: 'user-001',
      userRole: 'inventory_manager',
      method: 'manual',
    });

    expect(result).toHaveProperty('card');
    expect(result).toHaveProperty('transition');
    expect(result).toHaveProperty('eventId');
  });

  it('rejects transition when card not found', async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    await expect(
      transitionCard({
        cardId: 'nonexistent',
        tenantId: 'tenant-001',
        toStage: 'triggered',
        method: 'manual',
      })
    ).rejects.toThrow('Kanban card not found');
  });

  it('rejects transition on deactivated card', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard({ isActive: false }));

    await expect(
      transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'triggered',
        method: 'manual',
      })
    ).rejects.toThrow('Card is deactivated');
  });

  it('rejects invalid stage transition', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'created' }));

    await expect(
      transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'ordered', // invalid: created → ordered not allowed
        method: 'manual',
      })
    ).rejects.toThrow('Invalid transition');
  });

  it('rejects unauthorized role', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard());

    await expect(
      transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'triggered',
        userRole: 'salesperson', // not allowed for created → triggered
        method: 'manual',
      })
    ).rejects.toThrow("Role 'salesperson' cannot perform transition");
  });

  it('rejects incompatible loop type', async () => {
    // production loops cannot go ordered → in_transit
    mockFindFirst.mockResolvedValueOnce(
      makeCard({
        currentStage: 'ordered',
        loop: { ...makeCard().loop, loopType: 'production' },
      })
    );

    await expect(
      transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'in_transit',
        method: 'manual',
      })
    ).rejects.toThrow("not allowed for 'production' loops");
  });

  it('rejects invalid method', async () => {
    // qr_scan not allowed for triggered → ordered
    mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'triggered' }));

    await expect(
      transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'ordered',
        method: 'qr_scan', // not allowed
        linkedOrderId: 'a0000000-0000-0000-0000-000000000001',
        linkedOrderType: 'purchase_order',
      })
    ).rejects.toThrow("Method 'qr_scan' is not allowed");
  });

  it('rejects transition requiring linked order when none provided', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'triggered' }));

    await expect(
      transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'ordered',
        method: 'manual',
        // no linkedOrderId
      })
    ).rejects.toThrow('requires linkedOrderId and linkedOrderType');
  });

  it('allows tenant_admin to bypass role checks', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard());

    const result = await transitionCard({
      cardId: 'card-001',
      tenantId: 'tenant-001',
      toStage: 'triggered',
      userRole: 'tenant_admin',
      method: 'manual',
    });

    expect(result).toHaveProperty('card');
  });

  it('publishes lifecycle.transition event', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard());

    await transitionCard({
      cardId: 'card-001',
      tenantId: 'tenant-001',
      toStage: 'triggered',
      userId: 'user-001',
      method: 'manual',
    });

    // First call should be lifecycle.transition
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lifecycle.transition',
        tenantId: 'tenant-001',
        cardId: 'card-001',
        fromStage: 'created',
        toStage: 'triggered',
      })
    );
  });

  it('publishes lifecycle.queue_entry event when triggering', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard());

    await transitionCard({
      cardId: 'card-001',
      tenantId: 'tenant-001',
      toStage: 'triggered',
      method: 'manual',
    });

    // Second call should be lifecycle.queue_entry
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lifecycle.queue_entry',
        loopType: 'procurement',
        partId: 'part-001',
      })
    );
  });

  it('publishes lifecycle.order_linked event when ordering', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'triggered' }));

    await transitionCard({
      cardId: 'card-001',
      tenantId: 'tenant-001',
      toStage: 'ordered',
      method: 'manual',
      linkedOrderId: 'po-001',
      linkedOrderType: 'purchase_order',
    });

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lifecycle.order_linked',
        orderId: 'po-001',
        orderType: 'purchase_order',
      })
    );
  });

  it('gracefully handles event publish failure', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard());
    mockPublish.mockRejectedValueOnce(new Error('Redis down'));

    // Should not throw even if event publishing fails
    const result = await transitionCard({
      cardId: 'card-001',
      tenantId: 'tenant-001',
      toStage: 'triggered',
      method: 'manual',
    });

    expect(result).toHaveProperty('card');
  });

  describe('Idempotency', () => {
    it('returns persisted result for duplicate idempotency key', async () => {
      mockFindFirst.mockResolvedValue(makeCard());
      const persistedTransition = makeTransition({
        id: 'trans-persisted',
        metadata: { idempotencyKey: 'test-key-123' },
      });
      mockSelectLimit
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([persistedTransition]);

      // First call
      const result1 = await transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'triggered',
        method: 'manual',
        idempotencyKey: 'test-key-123',
      });

      // Second call with same key should return persisted transition and skip tx write.
      const result2 = await transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'triggered',
        method: 'manual',
        idempotencyKey: 'test-key-123',
      });

      expect(result1.transition.id).toBe('trans-001');
      expect(result2.transition.id).toBe('trans-persisted');
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockFindFirst).toHaveBeenCalledTimes(2);
    });

    it('processes normally without idempotency key', async () => {
      mockFindFirst.mockResolvedValueOnce(makeCard());

      const result = await transitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'triggered',
        method: 'manual',
        // no idempotencyKey
      });

      expect(mockFindFirst).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty('card');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TRIGGER CARD BY SCAN TESTS
// ═══════════════════════════════════════════════════════════════════════

describe('triggerCardByScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockReset();
    mockSelectLimit.mockReset();
    mockSelectLimit.mockResolvedValue([]);
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeTransition({ toStage: 'triggered' })]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeCard({ currentStage: 'triggered' })]),
            }),
          }),
        }),
      };
      return cb(tx);
    });
  });

  it('successfully triggers a card in created stage', async () => {
    mockFindFirst
      .mockResolvedValueOnce(makeCard()) // for triggerCardByScan lookup
      .mockResolvedValueOnce(makeCard()); // for transitionCard internal lookup

    const result = await triggerCardByScan({
      cardId: 'card-001',
      scannedByUserId: 'user-001',
      tenantId: 'tenant-001',
    });

    expect(result.loopType).toBe('procurement');
    expect(result.partId).toBe('part-001');
    expect(result.message).toContain('Order Queue');
  });

  it('rejects scan on non-existent card', async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    await expect(
      triggerCardByScan({ cardId: 'nonexistent' })
    ).rejects.toThrow('Card not found');
  });

  it('rejects scan on deactivated card', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard({ isActive: false }));

    await expect(
      triggerCardByScan({ cardId: 'card-001' })
    ).rejects.toThrow('deactivated');
  });

  it('rejects scan on non-created card', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'triggered' }));

    await expect(
      triggerCardByScan({ cardId: 'card-001' })
    ).rejects.toThrow('Scan conflict: card is in "triggered" stage');
  });

  it('rejects idempotent replay after card already advanced', async () => {
    const triggeredCard = makeCard({ currentStage: 'triggered' });
    mockFindFirst.mockResolvedValueOnce(triggeredCard);
    mockSelectLimit.mockResolvedValueOnce([
      makeTransition({
        metadata: { idempotencyKey: 'scan-card-001-session-123' },
      }),
    ]);

    await expect(triggerCardByScan({
      cardId: 'card-001',
      idempotencyKey: 'scan-card-001-session-123',
    })).rejects.toThrow('Scan conflict: card is in "triggered" stage');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects scan with tenant mismatch', async () => {
    mockFindFirst.mockResolvedValueOnce(makeCard({ tenantId: 'other-tenant' }));

    await expect(
      triggerCardByScan({ cardId: 'card-001', tenantId: 'tenant-001' })
    ).rejects.toThrow('does not belong to your tenant');
  });

  it('returns correct queue type for production loops', async () => {
    const productionCard = makeCard({
      loop: { ...makeCard().loop, loopType: 'production' },
    });
    mockFindFirst
      .mockResolvedValueOnce(productionCard)
      .mockResolvedValueOnce(productionCard);

    const result = await triggerCardByScan({ cardId: 'card-001' });
    expect(result.message).toContain('Production Queue');
  });

  it('returns correct queue type for transfer loops', async () => {
    const transferCard = makeCard({
      loop: { ...makeCard().loop, loopType: 'transfer' },
    });
    mockFindFirst
      .mockResolvedValueOnce(transferCard)
      .mockResolvedValueOnce(transferCard);

    const result = await triggerCardByScan({ cardId: 'card-001' });
    expect(result.message).toContain('Transfer Queue');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CROSS-CUTTING CONCERNS
// ═══════════════════════════════════════════════════════════════════════

describe('Cross-Cutting Concerns', () => {
  it('transition rules cover every matrix entry', () => {
    let transitionsInMatrix = 0;
    for (const toList of Object.values(VALID_TRANSITIONS)) {
      transitionsInMatrix += toList.length;
    }

    // There should be at least one rule per matrix entry
    // (some matrix entries like ordered→received may have multiple rules for different loop types)
    expect(TRANSITION_RULES.length).toBeGreaterThanOrEqual(transitionsInMatrix);
  });

  it('all rules reference valid stages from the matrix', () => {
    const allStages = Object.keys(VALID_TRANSITIONS);
    for (const rule of TRANSITION_RULES) {
      expect(allStages).toContain(rule.from);
      expect(VALID_TRANSITIONS[rule.from]).toContain(rule.to);
    }
  });

  it('rules with requiresLinkedOrder also have linkedOrderTypes', () => {
    for (const rule of TRANSITION_RULES) {
      if (rule.requiresLinkedOrder) {
        expect(rule.linkedOrderTypes, `Rule ${rule.from}→${rule.to} requires linked order but has no types`).toBeDefined();
        expect(rule.linkedOrderTypes!.length).toBeGreaterThan(0);
      }
    }
  });

  it('every rule has a description', () => {
    for (const rule of TRANSITION_RULES) {
      expect(rule.description.length, `Rule ${rule.from}→${rule.to} has empty description`).toBeGreaterThan(0);
    }
  });
});
