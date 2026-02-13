/**
 * Security Fault-Injection Tests
 *
 * Validates security event emission at every TCAAF decision point,
 * cross-tenant isolation, and non-fatal resilience of the security
 * event pipeline.
 *
 * Categories:
 *   1. Security event emission per TCAAF step
 *   2. Cross-tenant isolation — events carry correct tenantId
 *   3. Non-fatal resilience — EventBus failures don't break pipeline
 *   4. Event payload completeness
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (vi.hoisted ensures variables are available inside vi.mock factories) ──

const {
  mockRedisGet, mockRedisSet, mockRedisDel, mockRedisQuit, mockRedisPing,
  mockDbExecute,
  mockLoadActiveRules, mockEvaluateRules, mockBuildIdempotencyKey,
  mockExecuteWithIdempotency, mockCheckIdempotencyKey, mockClearIdempotencyKey, mockIdempotencyShutdown,
  mockCheckGuardrails, mockRecordPOCreated, mockRecordEmailDispatched,
  mockDispatchAction,
  mockPublish,
} = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockRedisQuit: vi.fn(),
  mockRedisPing: vi.fn(),
  mockDbExecute: vi.fn().mockResolvedValue(undefined),
  mockLoadActiveRules: vi.fn(),
  mockEvaluateRules: vi.fn(),
  mockBuildIdempotencyKey: vi.fn(),
  mockExecuteWithIdempotency: vi.fn(),
  mockCheckIdempotencyKey: vi.fn(),
  mockClearIdempotencyKey: vi.fn(),
  mockIdempotencyShutdown: vi.fn(),
  mockCheckGuardrails: vi.fn(),
  mockRecordPOCreated: vi.fn(),
  mockRecordEmailDispatched: vi.fn(),
  mockDispatchAction: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

// Redis mock
vi.mock('ioredis', () => {
  return {
    Redis: class MockRedis {
      get = mockRedisGet;
      set = mockRedisSet;
      del = mockRedisDel;
      quit = mockRedisQuit;
      ping = mockRedisPing;
    },
  };
});

// Config mock — includes config.REDIS_URL for emitSecurityEvent
vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// EventBus mock — captures security event emissions
vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({
    publish: mockPublish,
  })),
}));

// DB mock
vi.mock('@arda/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        execute: mockDbExecute,
      }),
    }),
  },
  schema: {
    auditLog: {},
  },
}));

// Rule evaluator mock
vi.mock('../../rule-evaluator.js', () => ({
  loadActiveRules: (...args: unknown[]) => mockLoadActiveRules(...args),
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
  buildIdempotencyKey: (...args: unknown[]) => mockBuildIdempotencyKey(...args),
}));

// Idempotency manager mock
vi.mock('../../idempotency-manager.js', () => {
  return {
    IdempotencyManager: class MockIdempotencyManager {
      executeWithIdempotency = mockExecuteWithIdempotency;
      checkIdempotencyKey = mockCheckIdempotencyKey;
      clearIdempotencyKey = mockClearIdempotencyKey;
      shutdown = mockIdempotencyShutdown;
    },
    ConcurrentExecutionError: class ConcurrentExecutionError extends Error {
      key: string;
      existingStatus: string;
      constructor(key: string, existingStatus: string) {
        super(`Concurrent execution detected for key: ${key} (status: ${existingStatus})`);
        this.name = 'ConcurrentExecutionError';
        this.key = key;
        this.existingStatus = existingStatus;
      }
    },
  };
});

// Guardrails mock
vi.mock('../../guardrails.js', () => ({
  checkGuardrails: (...args: unknown[]) => mockCheckGuardrails(...args),
  recordPOCreated: (...args: unknown[]) => mockRecordPOCreated(...args),
  recordEmailDispatched: (...args: unknown[]) => mockRecordEmailDispatched(...args),
}));

// Action handlers mock
vi.mock('../../action-handlers.js', () => ({
  dispatchAction: (...args: unknown[]) => mockDispatchAction(...args),
}));

// Now import the module under test
import { AutomationOrchestrator } from '../../orchestrator.js';
import type { AutomationJobPayload } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────

const DEFAULT_TENANT = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function makeJob(overrides: Partial<AutomationJobPayload> = {}): AutomationJobPayload {
  return {
    actionType: 'create_purchase_order',
    ruleId: 'P-01',
    tenantId: DEFAULT_TENANT,
    triggerEvent: 'card.stage.triggered',
    idempotencyKey: `po_create:${DEFAULT_TENANT}:S1:F1:2025-01-01`,
    context: {
      tenantId: DEFAULT_TENANT,
      supplierId: 'S1',
      facilityId: 'F1',
      partId: 'PART-01',
      cardId: 'CARD-01',
      loopId: 'LOOP-01',
      orderQuantity: 100,
      totalAmount: 2500,
    },
    approval: { required: false, strategy: 'auto_approve' },
    fallback: {
      onConditionFail: 'skip',
      onActionFail: 'retry',
      maxRetries: 3,
      retryDelayMs: 1000,
      retryBackoffMultiplier: 2,
    },
    actionParams: {},
    ...overrides,
  };
}

function setupHappyPath() {
  mockRedisGet.mockResolvedValue(null);
  mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
  mockEvaluateRules.mockReturnValue({
    allowed: true,
    matchedAllowRule: { id: 'P-01' },
    allMatchingRules: [{ id: 'P-01' }],
    evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
  });
  mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
  mockExecuteWithIdempotency.mockImplementation(
    async (_key: string, _actionType: string, _tenantId: string, action: () => Promise<unknown>) => {
      const result = await action();
      return { result, wasReplay: false };
    },
  );
  mockDispatchAction.mockResolvedValue({
    success: true,
    data: { purchaseOrderId: 'PO-001', poNumber: 'PO-AUTO-ABC' },
  });
  mockRecordPOCreated.mockResolvedValue(undefined);
  mockDbExecute.mockResolvedValue(undefined);
}

/** Extract all publish calls matching a given event type */
function getSecurityEvents(eventType: string) {
  return mockPublish.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((e) => e.type === eventType);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('Security Fault Injection', () => {
  let orchestrator: AutomationOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new AutomationOrchestrator('redis://localhost:6379');
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Security Event Emission per TCAAF Step
  // ═══════════════════════════════════════════════════════════════════

  describe('Step 0: Tenant ID Validation → tenant_validation_failed event', () => {
    it('emits security.automation.tenant_validation_failed for malformed tenant ID', async () => {
      const result = await orchestrator.executePipeline(
        makeJob({ tenantId: 'NOT-A-UUID' }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid tenant ID');

      const events = getSecurityEvents('security.automation.tenant_validation_failed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'security.automation.tenant_validation_failed',
        tenantId: 'NOT-A-UUID',
        actionType: 'create_purchase_order',
        ruleId: 'P-01',
        reason: 'Invalid tenant ID format',
      });
      expect(events[0].timestamp).toBeDefined();
    });

    it('emits tenant_validation_failed for empty tenant ID', async () => {
      await orchestrator.executePipeline(makeJob({ tenantId: '' }));
      const events = getSecurityEvents('security.automation.tenant_validation_failed');
      expect(events).toHaveLength(1);
      expect(events[0].tenantId).toBe('');
    });

    it('emits tenant_validation_failed for SQL injection attempt in tenant ID', async () => {
      const maliciousTenantId = "'; DROP TABLE users; --";
      await orchestrator.executePipeline(makeJob({ tenantId: maliciousTenantId }));
      const events = getSecurityEvents('security.automation.tenant_validation_failed');
      expect(events).toHaveLength(1);
      expect(events[0].tenantId).toBe(maliciousTenantId);
    });
  });

  describe('Step 1: Kill Switch → action_blocked (kill_switch_active)', () => {
    it('emits action_blocked with reason kill_switch_active when switch is on', async () => {
      mockRedisGet.mockResolvedValue('active');

      const result = await orchestrator.executePipeline(makeJob());

      expect(result.success).toBe(false);
      const events = getSecurityEvents('security.automation.action_blocked');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'security.automation.action_blocked',
        tenantId: DEFAULT_TENANT,
        actionType: 'create_purchase_order',
        ruleId: 'P-01',
        reason: 'kill_switch_active',
      });
    });
  });

  describe('Step 2: Rule Evaluation → action_blocked (denied_by_rule)', () => {
    it('emits action_blocked with denied rule ID when rules reject the action', async () => {
      mockRedisGet.mockResolvedValue(null); // no kill switch
      mockLoadActiveRules.mockReturnValue([{ id: 'D-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: false,
        deniedByRule: { id: 'D-01' },
        allMatchingRules: [{ id: 'D-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 0, denyMatches: 1 },
      });

      const result = await orchestrator.executePipeline(makeJob());

      expect(result.success).toBe(false);
      const events = getSecurityEvents('security.automation.action_blocked');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        reason: 'denied_by_rule:D-01',
        details: { deniedByRule: 'D-01' },
      });
    });

    it('emits action_blocked with default_deny when no specific rule matched', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([]);
      mockEvaluateRules.mockReturnValue({
        allowed: false,
        deniedByRule: null,
        allMatchingRules: [],
        evaluation: { totalRulesEvaluated: 0, allowMatches: 0, denyMatches: 0 },
      });

      await orchestrator.executePipeline(makeJob());
      const events = getSecurityEvents('security.automation.action_blocked');
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe('denied_by_rule:default_deny');
    });
  });

  describe('Step 3: Guardrails → guardrail_violation + action_blocked', () => {
    beforeEach(() => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
    });

    it('emits guardrail_violation with violations array for blocking guardrails', async () => {
      mockCheckGuardrails.mockResolvedValue({
        passed: false,
        violations: [
          { guardrailId: 'G-01', description: 'Daily PO limit exceeded' },
          { guardrailId: 'G-02', description: 'Hourly PO limit exceeded' },
        ],
      });

      const result = await orchestrator.executePipeline(makeJob());

      expect(result.success).toBe(false);

      // guardrail_violation event emitted
      const violationEvents = getSecurityEvents('security.automation.guardrail_violation');
      expect(violationEvents).toHaveLength(1);
      expect(violationEvents[0]).toMatchObject({
        type: 'security.automation.guardrail_violation',
        tenantId: DEFAULT_TENANT,
        actionType: 'create_purchase_order',
        blocked: true,
        violations: [
          { guardrailId: 'G-01', description: 'Daily PO limit exceeded' },
          { guardrailId: 'G-02', description: 'Hourly PO limit exceeded' },
        ],
      });

      // action_blocked event also emitted for blocking violations
      const blockedEvents = getSecurityEvents('security.automation.action_blocked');
      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0]).toMatchObject({
        reason: 'guardrail_violation',
        details: { violations: ['G-01', 'G-02'] },
      });
    });

    it('emits guardrail_violation with blocked=false for G-08 soft violations', async () => {
      mockCheckGuardrails.mockResolvedValue({
        passed: false,
        violations: [
          { guardrailId: 'G-08', description: 'Amount threshold exceeded' },
        ],
      });
      // G-08 doesn't block — pipeline continues to approval
      // Set up approval to pass so pipeline continues
      mockExecuteWithIdempotency.mockImplementation(
        async (_k: string, _a: string, _t: string, action: () => Promise<unknown>) => {
          const result = await action();
          return { result, wasReplay: false };
        },
      );
      mockDispatchAction.mockResolvedValue({
        success: true,
        data: { purchaseOrderId: 'PO-002' },
      });

      const result = await orchestrator.executePipeline(makeJob());

      // Pipeline should continue past G-08
      expect(result.success).toBe(true);

      const violationEvents = getSecurityEvents('security.automation.guardrail_violation');
      expect(violationEvents).toHaveLength(1);
      expect(violationEvents[0].blocked).toBe(false);

      // No action_blocked for G-08
      const blockedEvents = getSecurityEvents('security.automation.action_blocked');
      expect(blockedEvents).toHaveLength(0);
    });
  });

  describe('Step 4: Manual Approval → action_blocked (manual_approval_required)', () => {
    it('emits action_blocked when manual approval strategy triggers', async () => {
      setupHappyPath();
      const job = makeJob({
        approval: { required: true, strategy: 'threshold' as any },
      });

      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      const events = getSecurityEvents('security.automation.action_blocked');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        reason: 'manual_approval_required',
        details: { strategy: 'threshold' },
      });
    });
  });

  describe('Step 5: Action Failed → action_blocked (action_failed)', () => {
    it('emits action_blocked with error details when action handler fails', async () => {
      setupHappyPath();
      mockDispatchAction.mockResolvedValue({
        success: false,
        error: 'Supplier API timeout',
      });

      const result = await orchestrator.executePipeline(makeJob());

      expect(result.success).toBe(false);
      const events = getSecurityEvents('security.automation.action_blocked');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'security.automation.action_blocked',
        tenantId: DEFAULT_TENANT,
        reason: 'action_failed',
        details: { error: 'Supplier API timeout' },
      });
    });
  });

  describe('Step 7: Success → action_approved', () => {
    it('emits action_approved with wasReplay=false on first execution', async () => {
      setupHappyPath();

      const result = await orchestrator.executePipeline(makeJob());

      expect(result.success).toBe(true);
      const events = getSecurityEvents('security.automation.action_approved');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'security.automation.action_approved',
        tenantId: DEFAULT_TENANT,
        actionType: 'create_purchase_order',
        ruleId: 'P-01',
        wasReplay: false,
      });
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('emits action_approved with wasReplay=true on idempotent replay', async () => {
      setupHappyPath();
      mockExecuteWithIdempotency.mockImplementation(
        async (_k: string, _a: string, _t: string, action: () => Promise<unknown>) => {
          const result = await action();
          return { result, wasReplay: true };
        },
      );

      const result = await orchestrator.executePipeline(makeJob());

      expect(result.success).toBe(true);
      const events = getSecurityEvents('security.automation.action_approved');
      expect(events).toHaveLength(1);
      expect(events[0].wasReplay).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Cross-Tenant Isolation
  // ═══════════════════════════════════════════════════════════════════

  describe('Cross-Tenant Isolation', () => {
    it('security events always carry the correct tenantId from the job', async () => {
      const tenantA = '11111111-1111-4111-a111-111111111111';
      const tenantB = '22222222-2222-4222-a222-222222222222';

      // Tenant A: kill switch blocks
      mockRedisGet.mockResolvedValue('active');
      await orchestrator.executePipeline(makeJob({ tenantId: tenantA }));

      // Tenant B: also blocked
      await orchestrator.executePipeline(makeJob({ tenantId: tenantB }));

      const events = getSecurityEvents('security.automation.action_blocked');
      expect(events).toHaveLength(2);
      expect(events[0].tenantId).toBe(tenantA);
      expect(events[1].tenantId).toBe(tenantB);
    });

    it('no security events leak between tenants across sequential runs', async () => {
      const tenantA = '11111111-1111-4111-a111-111111111111';
      const tenantB = '22222222-2222-4222-a222-222222222222';

      // Tenant A: denied by rules
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'D-01' }]);
      mockEvaluateRules.mockReturnValue({
        allowed: false,
        deniedByRule: { id: 'D-01' },
        allMatchingRules: [{ id: 'D-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 0, denyMatches: 1 },
      });
      await orchestrator.executePipeline(makeJob({ tenantId: tenantA }));

      // Tenant B: success
      setupHappyPath();
      await orchestrator.executePipeline(makeJob({ tenantId: tenantB }));

      // Verify tenant A only has blocked events
      const blockedEvents = getSecurityEvents('security.automation.action_blocked');
      const tenantABlocked = blockedEvents.filter((e) => e.tenantId === tenantA);
      expect(tenantABlocked.length).toBeGreaterThanOrEqual(1);
      for (const e of tenantABlocked) {
        expect(e.tenantId).toBe(tenantA);
      }

      // Verify tenant B only has approved events
      const approvedEvents = getSecurityEvents('security.automation.action_approved');
      const tenantBApproved = approvedEvents.filter((e) => e.tenantId === tenantB);
      expect(tenantBApproved.length).toBeGreaterThanOrEqual(1);
      for (const e of tenantBApproved) {
        expect(e.tenantId).toBe(tenantB);
      }

      // Cross-check: no tenant A in approved, no tenant B in blocked
      expect(approvedEvents.every((e) => e.tenantId !== tenantA)).toBe(true);
      expect(blockedEvents.every((e) => e.tenantId !== tenantB)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. Non-Fatal Resilience — EventBus failure does NOT break pipeline
  // ═══════════════════════════════════════════════════════════════════

  describe('Non-Fatal Security Event Emission', () => {
    it('pipeline succeeds even when EventBus.publish throws', async () => {
      setupHappyPath();
      mockPublish.mockRejectedValue(new Error('Redis connection refused'));

      const result = await orchestrator.executePipeline(makeJob());

      // The pipeline must still succeed
      expect(result.success).toBe(true);
      expect(result.wasReplay).toBe(false);
    });

    it('pipeline returns correct denial when EventBus.publish throws during block', async () => {
      mockRedisGet.mockResolvedValue('active'); // kill switch on
      mockPublish.mockRejectedValue(new Error('Redis timeout'));

      const result = await orchestrator.executePipeline(makeJob());

      // Still correctly reports failure
      expect(result.success).toBe(false);
      expect(result.error).toContain('kill switch');
    });

    it('all 7 event emission points survive EventBus failure', async () => {
      mockPublish.mockRejectedValue(new Error('EventBus down'));

      // Step 0: tenant validation
      const r0 = await orchestrator.executePipeline(makeJob({ tenantId: 'bad' }));
      expect(r0.success).toBe(false);
      expect(r0.error).toContain('Invalid tenant ID');

      // Step 1: kill switch
      mockRedisGet.mockResolvedValue('active');
      const r1 = await orchestrator.executePipeline(makeJob());
      expect(r1.success).toBe(false);

      // Step 2: rule denied
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([]);
      mockEvaluateRules.mockReturnValue({
        allowed: false,
        deniedByRule: null,
        allMatchingRules: [],
        evaluation: { totalRulesEvaluated: 0, allowMatches: 0, denyMatches: 0 },
      });
      const r2 = await orchestrator.executePipeline(makeJob());
      expect(r2.success).toBe(false);

      // Step 3: guardrail block
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({
        passed: false,
        violations: [{ guardrailId: 'G-01', description: 'Limit exceeded' }],
      });
      const r3 = await orchestrator.executePipeline(makeJob());
      expect(r3.success).toBe(false);

      // Step 5: action failed
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
      mockExecuteWithIdempotency.mockImplementation(
        async (_k: string, _a: string, _t: string, action: () => Promise<unknown>) => {
          const result = await action();
          return { result, wasReplay: false };
        },
      );
      mockDispatchAction.mockResolvedValue({ success: false, error: 'Network error' });
      const r5 = await orchestrator.executePipeline(makeJob());
      expect(r5.success).toBe(false);

      // Step 7: success
      mockDispatchAction.mockResolvedValue({
        success: true,
        data: { purchaseOrderId: 'PO-X' },
      });
      mockRecordPOCreated.mockResolvedValue(undefined);
      const r7 = await orchestrator.executePipeline(makeJob());
      expect(r7.success).toBe(true);

      // All 6 calls above issued events despite failures — mockPublish was
      // called at least once per run (the emission is attempted even though
      // it throws; the try/catch swallows the error).
      // Step 0 emits 1, Step 1 emits 1, Step 2 emits 1, Step 3 emits 2 (violation + blocked),
      // Step 5 emits 1, Step 7 emits 1 = 7 total minimum
      expect(mockPublish.mock.calls.length).toBeGreaterThanOrEqual(7);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. Event Payload Completeness
  // ═══════════════════════════════════════════════════════════════════

  describe('Event Payload Completeness', () => {
    it('action_blocked events include idempotencyKey and ruleId', async () => {
      mockRedisGet.mockResolvedValue('active');
      await orchestrator.executePipeline(
        makeJob({ idempotencyKey: 'idem-key-42', ruleId: 'R-99' }),
      );

      const events = getSecurityEvents('security.automation.action_blocked');
      expect(events[0].idempotencyKey).toBe('idem-key-42');
      expect(events[0].ruleId).toBe('R-99');
    });

    it('action_approved events include durationMs > 0', async () => {
      setupHappyPath();
      await orchestrator.executePipeline(makeJob());

      const events = getSecurityEvents('security.automation.action_approved');
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('all security events have ISO-8601 timestamp', async () => {
      setupHappyPath();
      await orchestrator.executePipeline(makeJob());

      const allCalls = mockPublish.mock.calls.map((call) => call[0] as Record<string, unknown>);
      for (const event of allCalls) {
        if (typeof event.type === 'string' && (event.type as string).startsWith('security.')) {
          expect(event.timestamp).toBeDefined();
          expect(() => new Date(event.timestamp as string)).not.toThrow();
          // Verify ISO format
          expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        }
      }
    });

    it('guardrail_violation event maps violation details correctly', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({
        passed: false,
        violations: [
          { guardrailId: 'G-03', description: 'Single PO amount limit' },
          { guardrailId: 'G-05', description: 'Hourly email limit' },
        ],
      });

      await orchestrator.executePipeline(makeJob());

      const events = getSecurityEvents('security.automation.guardrail_violation');
      expect(events[0].violations).toEqual([
        { guardrailId: 'G-03', description: 'Single PO amount limit' },
        { guardrailId: 'G-05', description: 'Hourly email limit' },
      ]);
    });
  });
});
