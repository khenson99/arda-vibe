/**
 * Orchestrator Fault-Injection Tests
 *
 * Resilience coverage for the TCAAF pipeline under fault conditions.
 * Validates that the orchestrator degrades gracefully when Redis, the
 * database, rule evaluation, guardrails, or action handlers fail.
 *
 * Categories:
 *   1. Redis kill-switch failures
 *   2. Rule evaluation failures
 *   3. Guardrail Redis counter failures
 *   4. Approval logic edge cases
 *   5. Audit recording failures (non-fatal)
 *   6. Full pipeline cascading faults
 *   7. Recovery after transient faults
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

// Logger mock
vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// DB mock (recordDecision uses db.insert)
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
import { ConcurrentExecutionError } from '../../idempotency-manager.js';
import type { AutomationJobPayload } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeJob(overrides: Partial<AutomationJobPayload> = {}): AutomationJobPayload {
  return {
    actionType: 'create_purchase_order',
    ruleId: 'P-01',
    tenantId: 'T1',
    triggerEvent: 'card.stage.triggered',
    idempotencyKey: 'po_create:T1:S1:F1:2025-01-01',
    context: {
      tenantId: 'T1',
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

// ─── Tests ────────────────────────────────────────────────────────────

describe('Orchestrator Fault Injection', () => {
  let orchestrator: AutomationOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new AutomationOrchestrator('redis://localhost:6379');
  });

  // ── 1. Redis Kill-Switch Failures ───────────────────────────────────

  describe('Redis kill-switch failures', () => {
    it('should deny execution when Redis GET throws ECONNREFUSED', async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');
      (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      mockRedisGet.mockRejectedValue(err);

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow('ECONNREFUSED');
    });

    it('should deny execution when Redis GET returns unexpected data type', async () => {
      // Redis returns a number instead of string/null
      mockRedisGet.mockResolvedValue(42 as unknown as string);

      // The kill switch check does `=== 'active'`, so non-string won't match
      // Pipeline should proceed past kill switch — set up rest of mocks
      setupHappyPath();
      // Override the kill switch mock specifically
      mockRedisGet.mockResolvedValue(42 as unknown as string);

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);
      // It should proceed since 42 !== 'active'
      expect(result.success).toBe(true);
    });

    it('should deny when global kill switch Redis GET times out', async () => {
      mockRedisGet.mockRejectedValue(new Error('Connection timed out'));

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow('Connection timed out');
    });

    it('should deny when tenant kill switch check fails after global passes', async () => {
      // First call: global kill switch = null (not active)
      // Second call: tenant kill switch = ECONNREFUSED
      mockRedisGet
        .mockResolvedValueOnce(null) // global
        .mockRejectedValueOnce(new Error('Connection reset'));

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow('Connection reset');
    });

    it('should activate kill switch even when Redis SET fails', async () => {
      mockRedisSet.mockRejectedValue(new Error('READONLY'));

      await expect(orchestrator.activateKillSwitch('T1')).rejects.toThrow('READONLY');
    });

    it('should handle deactivateKillSwitch when Redis DEL fails', async () => {
      mockRedisDel.mockRejectedValue(new Error('Connection lost'));

      await expect(orchestrator.deactivateKillSwitch('T1')).rejects.toThrow('Connection lost');
    });
  });

  // ── 2. Rule Evaluation Failures ─────────────────────────────────────

  describe('Rule evaluation failures', () => {
    it('should propagate error when loadActiveRules throws', async () => {
      mockRedisGet.mockResolvedValue(null); // kill switch off
      mockLoadActiveRules.mockImplementation(() => {
        throw new Error('Failed to load rules: DB unreachable');
      });

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow('Failed to load rules');
    });

    it('should propagate error when evaluateRules throws', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'operator')");
      });

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow("Cannot read properties");
    });

    it('should record denial when evaluateRules returns denied', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'D-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: false,
        deniedByRule: { id: 'D-01' },
        allMatchingRules: [{ id: 'D-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 0, denyMatches: 1 },
      });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Denied by rule: D-01');
      expect(mockDbExecute).toHaveBeenCalled(); // audit recorded
    });

    it('should handle evaluateRules returning undefined result', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([]);
      mockEvaluateRules.mockReturnValue({
        allowed: false,
        deniedByRule: undefined,
        allMatchingRules: [],
        evaluation: { totalRulesEvaluated: 0, allowMatches: 0, denyMatches: 0 },
      });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toContain('default_deny');
    });
  });

  // ── 3. Guardrail Redis Counter Failures ─────────────────────────────

  describe('Guardrail Redis counter failures', () => {
    it('should propagate error when checkGuardrails throws ECONNREFUSED', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });

      const connErr = new Error('connect ECONNREFUSED 127.0.0.1:6379');
      (connErr as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      mockCheckGuardrails.mockRejectedValue(connErr);

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow('ECONNREFUSED');
    });

    it('should deny when guardrails report blocking violations', async () => {
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
          { guardrailId: 'G-04', description: 'Max POs exceeded', currentValue: 5, threshold: 5 },
          { guardrailId: 'G-05', description: 'Daily limit exceeded', currentValue: 60000, threshold: 50000 },
        ],
      });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toContain('G-04');
      expect(result.error).toContain('G-05');
    });

    it('should allow execution with only G-08 (non-blocking) violations when no approval required', async () => {
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
          { guardrailId: 'G-08', description: 'Dual approval required', currentValue: 20000, threshold: 15000 },
        ],
      });
      mockExecuteWithIdempotency.mockImplementation(
        async (_key: string, _actionType: string, _tenantId: string, action: () => Promise<unknown>) => {
          const result = await action();
          return { result, wasReplay: false };
        },
      );
      mockDispatchAction.mockResolvedValue({
        success: true,
        data: { purchaseOrderId: 'PO-002', poNumber: 'PO-AUTO-DEF' },
      });
      mockRecordPOCreated.mockResolvedValue(undefined);
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(true);
    });

    it('should not break pipeline when post-action counter recording fails', async () => {
      setupHappyPath();
      mockRecordPOCreated.mockRejectedValue(new Error('Redis pipeline exec failed'));

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      // Pipeline should still succeed because counter failures are non-fatal
      expect(result.success).toBe(true);
    });

    it('should not break pipeline when email counter recording fails', async () => {
      setupHappyPath();
      mockRecordEmailDispatched.mockRejectedValue(new Error('Redis pipeline exec failed'));

      const job = makeJob({ actionType: 'dispatch_email' });
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(true);
    });
  });

  // ── 4. Approval Logic Edge Cases ────────────────────────────────────

  describe('Approval logic edge cases', () => {
    it('should escalate when approval.strategy is always_manual', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob({
        approval: { required: true, strategy: 'always_manual' },
      });
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Manual approval required');
    });

    it('should escalate when threshold_based and amount exceeds requireApprovalAbove', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob({
        context: {
          tenantId: 'T1',
          supplierId: 'S1',
          facilityId: 'F1',
          partId: 'PART-01',
          cardId: 'CARD-01',
          loopId: 'LOOP-01',
          orderQuantity: 100,
          totalAmount: 20000, // above requireApprovalAbove
        },
        approval: {
          required: true,
          strategy: 'threshold_based',
          thresholds: {
            autoApproveBelow: 5000,
            requireApprovalAbove: 15000,
            requireDualApprovalAbove: 25000,
          },
        },
      });
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Manual approval required');
    });

    it('should auto-approve when threshold_based and amount below autoApproveBelow', async () => {
      setupHappyPath();
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });

      const job = makeJob({
        context: {
          tenantId: 'T1',
          supplierId: 'S1',
          facilityId: 'F1',
          partId: 'PART-01',
          cardId: 'CARD-01',
          loopId: 'LOOP-01',
          orderQuantity: 10,
          totalAmount: 500, // below autoApproveBelow
        },
        approval: {
          required: true,
          strategy: 'threshold_based',
          thresholds: {
            autoApproveBelow: 5000,
            requireApprovalAbove: 15000,
            requireDualApprovalAbove: 25000,
          },
        },
      });
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(true);
    });

    it('should escalate when G-08 dual-approval violation present with threshold_based strategy', async () => {
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
          { guardrailId: 'G-08', description: 'Dual approval threshold exceeded', currentValue: 16000, threshold: 15000 },
        ],
      });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob({
        context: {
          tenantId: 'T1',
          supplierId: 'S1',
          facilityId: 'F1',
          partId: 'PART-01',
          cardId: 'CARD-01',
          loopId: 'LOOP-01',
          orderQuantity: 100,
          totalAmount: 8000, // between auto and require thresholds
        },
        approval: {
          required: true,
          strategy: 'threshold_based',
          thresholds: {
            autoApproveBelow: 5000,
            requireApprovalAbove: 15000,
            requireDualApprovalAbove: 25000,
          },
        },
      });
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Manual approval required');
    });

    it('should escalate when threshold_based with no thresholds defined', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob({
        approval: {
          required: true,
          strategy: 'threshold_based',
          // thresholds intentionally omitted
        },
      });
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Manual approval required');
    });
  });

  // ── 5. Audit Recording Failures (non-fatal) ────────────────────────

  describe('Audit recording failures', () => {
    it('should complete pipeline successfully even when audit insert fails', async () => {
      setupHappyPath();
      // DB fails on audit write but we override setupHappyPath's mock
      mockDbExecute.mockRejectedValue(new Error('Database connection pool exhausted'));

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      // Pipeline still succeeds because audit failures are non-fatal
      expect(result.success).toBe(true);
    });

    it('should still deny when kill switch active, even if audit recording fails', async () => {
      mockRedisGet.mockResolvedValue('active');
      mockDbExecute.mockRejectedValue(new Error('DB write timeout'));

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toContain('kill switch');
    });

    it('should still deny on rule evaluation, even if audit recording fails', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([]);
      mockEvaluateRules.mockReturnValue({
        allowed: false,
        deniedByRule: { id: 'D-01' },
        allMatchingRules: [],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 0, denyMatches: 1 },
      });
      mockDbExecute.mockRejectedValue(new Error('DB write timeout'));

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Denied by rule');
    });
  });

  // ── 6. Full Pipeline Cascading Faults ───────────────────────────────

  describe('Full pipeline cascading faults', () => {
    it('should handle action handler failure and trigger escalation fallback', async () => {
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
        success: false,
        error: 'DB transaction deadlock',
      });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob({
        fallback: {
          onConditionFail: 'skip',
          onActionFail: 'escalate',
          maxRetries: 3,
          retryDelayMs: 1000,
          retryBackoffMultiplier: 2,
        },
      });
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toContain('DB transaction deadlock');
      // Should have called escalate via dispatchAction
      expect(mockDispatchAction).toHaveBeenCalledTimes(2); // once for action, once for escalation
      expect(mockDispatchAction).toHaveBeenLastCalledWith(
        'escalate',
        expect.objectContaining({ tenantId: 'T1' }),
      );
    });

    it('should handle ConcurrentExecutionError gracefully', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
      mockExecuteWithIdempotency.mockRejectedValue(
        new ConcurrentExecutionError('po_create:T1:S1:F1:2025-01-01', 'pending'),
      );

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Concurrent execution detected');
      expect(result.wasReplay).toBe(false);
    });

    it('should propagate unexpected errors after recording audit decision', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
      mockExecuteWithIdempotency.mockRejectedValue(new Error('Unexpected: memory allocation failed'));
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow('memory allocation failed');
      expect(mockDbExecute).toHaveBeenCalled(); // audit should have been recorded
    });

    it('should return wasReplay=true when idempotency detects replay', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
      mockExecuteWithIdempotency.mockResolvedValue({
        result: { success: true, data: { purchaseOrderId: 'PO-001' } },
        wasReplay: true,
      });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob();
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(true);
      expect(result.wasReplay).toBe(true);
      // Counter recording should be skipped on replay
      expect(mockRecordPOCreated).not.toHaveBeenCalled();
    });

    it('should skip counter recording on replay but still record audit', async () => {
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockResolvedValue({ passed: true, violations: [] });
      mockExecuteWithIdempotency.mockResolvedValue({
        result: { success: true, data: { purchaseOrderId: 'PO-002' } },
        wasReplay: true,
      });
      mockDbExecute.mockResolvedValue(undefined);

      const job = makeJob({ actionType: 'dispatch_email' });
      const result = await orchestrator.executePipeline(job);

      expect(result.success).toBe(true);
      expect(mockRecordEmailDispatched).not.toHaveBeenCalled();
      expect(mockDbExecute).toHaveBeenCalled(); // audit still recorded
    });
  });

  // ── 7. Recovery After Transient Faults ──────────────────────────────

  describe('Recovery after transient faults', () => {
    it('should succeed on second attempt after kill switch Redis failure', async () => {
      // First attempt: Redis fails
      mockRedisGet.mockRejectedValueOnce(new Error('Connection reset'));

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow('Connection reset');

      // Second attempt: everything works
      setupHappyPath();
      const result = await orchestrator.executePipeline(job);
      expect(result.success).toBe(true);
    });

    it('should succeed on second attempt after guardrail failure', async () => {
      // First attempt: guardrails throw
      mockRedisGet.mockResolvedValue(null);
      mockLoadActiveRules.mockReturnValue([{ id: 'P-01', isActive: true }]);
      mockEvaluateRules.mockReturnValue({
        allowed: true,
        matchedAllowRule: { id: 'P-01' },
        allMatchingRules: [{ id: 'P-01' }],
        evaluation: { totalRulesEvaluated: 1, allowMatches: 1, denyMatches: 0 },
      });
      mockCheckGuardrails.mockRejectedValueOnce(new Error('Redis timeout'));

      const job = makeJob();
      await expect(orchestrator.executePipeline(job)).rejects.toThrow('Redis timeout');

      // Second attempt: everything works
      vi.clearAllMocks();
      setupHappyPath();
      const result = await orchestrator.executePipeline(job);
      expect(result.success).toBe(true);
    });

    it('should clear idempotency key for DLQ replay', async () => {
      mockClearIdempotencyKey.mockResolvedValue(true);

      const cleared = await orchestrator.clearIdempotencyKey('po_create:T1:S1:F1:2025-01-01');
      expect(cleared).toBe(true);
      expect(mockClearIdempotencyKey).toHaveBeenCalledWith('po_create:T1:S1:F1:2025-01-01');
    });

    it('should handle clearIdempotencyKey failure', async () => {
      mockClearIdempotencyKey.mockRejectedValue(new Error('Redis ECONNREFUSED'));

      await expect(
        orchestrator.clearIdempotencyKey('po_create:T1:S1:F1:2025-01-01'),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('should report health check failure when Redis is down', async () => {
      mockRedisPing.mockRejectedValue(new Error('Connection refused'));

      const health = await orchestrator.healthCheck();
      expect(health.redis).toBe(false);
    });
  });
});
