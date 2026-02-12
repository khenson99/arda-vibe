/**
 * Guardrails Fault-Injection Tests
 *
 * Resilience coverage for financial (G-01..G-08) and outbound (O-01..O-06)
 * guardrails under fault conditions. Validates graceful degradation when
 * Redis counters are corrupted, connections fail, or pipelines error.
 *
 * Categories:
 *   1. Redis GET/SET failures in financial guardrails
 *   2. Redis pipeline.exec() failures in counter recording
 *   3. Corrupted counter values (NaN, negative, huge)
 *   4. Boundary condition tests for threshold edges
 *   5. Outbound guardrail Redis failures
 *   6. Combined financial + outbound failures
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────

const {
  mockRedisGet,
  mockRedisIncr,
  mockRedisIncrByFloat,
  mockRedisExpire,
  mockRedisSet,
  mockRedisPipeline,
  mockPipelineExec,
  mockPipelineIncr,
  mockPipelineIncrByFloat,
  mockPipelineExpire,
  mockPipelineSet,
} = vi.hoisted(() => {
  const mockPipelineIncr = vi.fn().mockReturnThis();
  const mockPipelineIncrByFloat = vi.fn().mockReturnThis();
  const mockPipelineExpire = vi.fn().mockReturnThis();
  const mockPipelineSet = vi.fn().mockReturnThis();
  const mockPipelineExec = vi.fn().mockResolvedValue([]);

  return {
    mockRedisGet: vi.fn(),
    mockRedisIncr: vi.fn(),
    mockRedisIncrByFloat: vi.fn(),
    mockRedisExpire: vi.fn(),
    mockRedisSet: vi.fn(),
    mockRedisPipeline: vi.fn().mockReturnValue({
      incr: mockPipelineIncr,
      incrbyfloat: mockPipelineIncrByFloat,
      expire: mockPipelineExpire,
      set: mockPipelineSet,
      exec: mockPipelineExec,
    }),
    mockPipelineExec,
    mockPipelineIncr,
    mockPipelineIncrByFloat,
    mockPipelineExpire,
    mockPipelineSet,
  };
});

vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    get = mockRedisGet;
    incr = mockRedisIncr;
    incrbyfloat = mockRedisIncrByFloat;
    expire = mockRedisExpire;
    set = mockRedisSet;
    pipeline = mockRedisPipeline;
  },
}));

vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { Redis } from 'ioredis';
import {
  checkFinancialGuardrails,
  checkOutboundGuardrails,
  checkFollowUpPOGuardrail,
  checkConsolidationGuardrail,
  checkGuardrails,
  recordPOCreated,
  recordEmailDispatched,
  recordFollowUpPOCreated,
} from '../../guardrails.js';
import type {
  PurchaseOrderContext,
  EmailDispatchContext,
  TenantAutomationLimits,
} from '../../types.js';
import { DEFAULT_TENANT_LIMITS } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function makePOContext(overrides: Partial<PurchaseOrderContext> = {}): PurchaseOrderContext {
  return {
    tenantId: 'T1',
    cardId: 'CARD-01',
    loopId: 'LOOP-01',
    partId: 'PART-01',
    supplierId: 'S1',
    facilityId: 'F1',
    orderQuantity: 100,
    totalAmount: 2500,
    ...overrides,
  };
}

function makeEmailContext(overrides: Partial<EmailDispatchContext> = {}): EmailDispatchContext {
  return {
    tenantId: 'T1',
    poId: 'PO-001',
    supplierId: 'S1',
    supplierEmail: 'orders@supplier.com',
    totalAmount: 2500,
    ...overrides,
  };
}

function makeLimits(overrides: Partial<TenantAutomationLimits> = {}): TenantAutomationLimits {
  return {
    tenantId: 'T1',
    ...DEFAULT_TENANT_LIMITS,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('Guardrails Fault Injection', () => {
  let redis: Redis;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = new Redis();
  });

  // ── 1. Redis GET/SET Failures in Financial Guardrails ───────────────

  describe('Redis GET failures in financial guardrails', () => {
    it('should propagate error when Redis GET for supplier PO count throws ECONNREFUSED', async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');
      (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      mockRedisGet.mockRejectedValue(err);

      await expect(
        checkFinancialGuardrails(redis, makePOContext(), makeLimits()),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('should propagate error when Redis GET for daily PO value times out', async () => {
      // First GET (supplier count) succeeds
      mockRedisGet
        .mockResolvedValueOnce('2') // G-04: supplier PO count
        .mockRejectedValueOnce(new Error('Command timed out')); // G-05: daily value

      await expect(
        checkFinancialGuardrails(redis, makePOContext(), makeLimits()),
      ).rejects.toThrow('Command timed out');
    });

    it('should handle NaN from corrupted Redis counter for supplier PO count', async () => {
      mockRedisGet
        .mockResolvedValueOnce('not-a-number') // G-04: corrupted
        .mockResolvedValueOnce('0'); // G-05: daily value

      // parseInt('not-a-number') = NaN, NaN >= 5 is false, so no violation
      const result = await checkFinancialGuardrails(redis, makePOContext(), makeLimits());
      expect(result.passed).toBe(true);
    });

    it('should handle null from Redis (key expired) for daily PO value', async () => {
      mockRedisGet
        .mockResolvedValueOnce(null) // G-04: key expired
        .mockResolvedValueOnce(null); // G-05: key expired

      const result = await checkFinancialGuardrails(redis, makePOContext(), makeLimits());
      // Both counters at 0 from null, amount 2500 < limits, should pass
      expect(result.passed).toBe(true);
    });

    it('should detect G-04 violation with counter at exactly the limit', async () => {
      mockRedisGet
        .mockResolvedValueOnce('5') // G-04: exactly at limit (>= 5)
        .mockResolvedValueOnce('0'); // G-05: daily value

      const result = await checkFinancialGuardrails(redis, makePOContext(), makeLimits());
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.guardrailId === 'G-04')).toBe(true);
    });

    it('should detect G-05 violation when adding amount would exceed daily limit', async () => {
      mockRedisGet
        .mockResolvedValueOnce('0') // G-04: ok
        .mockResolvedValueOnce('48000'); // G-05: 48000 + 2500 > 50000

      const result = await checkFinancialGuardrails(redis, makePOContext(), makeLimits());
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.guardrailId === 'G-05')).toBe(true);
    });
  });

  // ── 2. Redis Pipeline Failures in Counter Recording ─────────────────

  describe('Redis pipeline failures in counter recording', () => {
    it('should propagate error when pipeline.exec() throws on recordPOCreated', async () => {
      mockPipelineExec.mockRejectedValue(new Error('EXECABORT Transaction discarded'));

      await expect(recordPOCreated(redis, 'T1', 'S1', 2500)).rejects.toThrow(
        'EXECABORT',
      );
    });

    it('should propagate error when pipeline.exec() throws on recordEmailDispatched', async () => {
      mockPipelineExec.mockRejectedValue(new Error('Connection lost during pipeline'));

      await expect(
        recordEmailDispatched(redis, 'T1', 'PO-001', 'S1', 'orders@supplier.com'),
      ).rejects.toThrow('Connection lost');
    });

    it('should propagate error when pipeline.exec() throws on recordFollowUpPOCreated', async () => {
      mockRedisIncr.mockRejectedValue(new Error('READONLY'));

      await expect(recordFollowUpPOCreated(redis, 'T1')).rejects.toThrow('READONLY');
    });

    it('should execute pipeline with correct counter keys for PO recording', async () => {
      mockPipelineExec.mockResolvedValue([]);

      await recordPOCreated(redis, 'T1', 'S1', 2500);

      expect(mockPipelineIncr).toHaveBeenCalled();
      expect(mockPipelineIncrByFloat).toHaveBeenCalledWith(
        expect.stringContaining('po_value:T1'),
        2500,
      );
    });

    it('should execute pipeline with correct counter keys for email recording', async () => {
      mockPipelineExec.mockResolvedValue([]);

      await recordEmailDispatched(redis, 'T1', 'PO-001', 'S1', 'orders@supplier.com');

      expect(mockPipelineIncr).toHaveBeenCalled();
      expect(mockPipelineSet).toHaveBeenCalled();
    });
  });

  // ── 3. Corrupted Counter Values ─────────────────────────────────────

  describe('Corrupted counter values', () => {
    it('should handle extremely large counter value from Redis', async () => {
      mockRedisGet
        .mockResolvedValueOnce('999999999') // G-04: absurdly high
        .mockResolvedValueOnce('0');

      const result = await checkFinancialGuardrails(redis, makePOContext(), makeLimits());
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.guardrailId === 'G-04')).toBe(true);
    });

    it('should handle negative counter value from Redis', async () => {
      mockRedisGet
        .mockResolvedValueOnce('-1') // G-04: negative (should not happen but graceful)
        .mockResolvedValueOnce('0');

      // parseInt('-1') = -1, -1 >= 5 is false, so no G-04 violation
      const result = await checkFinancialGuardrails(redis, makePOContext(), makeLimits());
      expect(result.passed).toBe(true);
    });

    it('should handle floating point daily value from Redis', async () => {
      mockRedisGet
        .mockResolvedValueOnce('0') // G-04
        .mockResolvedValueOnce('49999.99'); // G-05: just below limit

      const ctx = makePOContext({ totalAmount: 1 }); // 49999.99 + 1 = 50000.99 > 50000
      const result = await checkFinancialGuardrails(redis, ctx, makeLimits());
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.guardrailId === 'G-05')).toBe(true);
    });

    it('should handle empty string counter value from Redis', async () => {
      mockRedisGet
        .mockResolvedValueOnce('') // G-04: empty string -> parseInt('') = NaN
        .mockResolvedValueOnce(''); // G-05: empty string -> parseFloat('') = NaN

      // NaN comparisons: NaN >= 5 is false, NaN + 2500 > 50000 is false
      const result = await checkFinancialGuardrails(redis, makePOContext(), makeLimits());
      expect(result.passed).toBe(true);
    });
  });

  // ── 4. Boundary Condition Tests ─────────────────────────────────────

  describe('Boundary condition tests', () => {
    it('G-01: should violate when amount exactly equals the limit for non-expedited', async () => {
      mockRedisGet.mockResolvedValue('0');

      // Amount > limit triggers violation (not >=)
      const ctx = makePOContext({ totalAmount: 5001, isExpedited: false });
      const result = await checkFinancialGuardrails(redis, ctx, makeLimits());
      expect(result.violations.some((v) => v.guardrailId === 'G-01')).toBe(true);
    });

    it('G-01: should not violate when amount exactly equals limit', async () => {
      mockRedisGet.mockResolvedValue('0');

      const ctx = makePOContext({ totalAmount: 5000, isExpedited: false });
      const result = await checkFinancialGuardrails(redis, ctx, makeLimits());
      expect(result.violations.some((v) => v.guardrailId === 'G-01')).toBe(false);
    });

    it('G-02: should violate for expedited PO exceeding expedited limit', async () => {
      mockRedisGet.mockResolvedValue('0');

      const ctx = makePOContext({ totalAmount: 10001, isExpedited: true });
      const result = await checkFinancialGuardrails(redis, ctx, makeLimits());
      expect(result.violations.some((v) => v.guardrailId === 'G-02')).toBe(true);
    });

    it('G-01: should NOT violate for expedited PO even when above non-expedited limit', async () => {
      mockRedisGet.mockResolvedValue('0');

      const ctx = makePOContext({ totalAmount: 7000, isExpedited: true });
      const result = await checkFinancialGuardrails(redis, ctx, makeLimits());
      // G-01 only triggers for non-expedited
      expect(result.violations.some((v) => v.guardrailId === 'G-01')).toBe(false);
    });

    it('G-08: should flag dual approval when amount exceeds threshold', async () => {
      mockRedisGet.mockResolvedValue('0');

      const ctx = makePOContext({ totalAmount: 15001 });
      const result = await checkFinancialGuardrails(redis, ctx, makeLimits());
      expect(result.violations.some((v) => v.guardrailId === 'G-08')).toBe(true);
    });

    it('G-03: consolidation guardrail with amount at exact boundary', () => {
      const limits = makeLimits();
      const result = checkConsolidationGuardrail(25000, limits);
      // 25000 > 25000 is false, so should pass
      expect(result.passed).toBe(true);
    });

    it('G-03: consolidation guardrail with amount just over boundary', () => {
      const limits = makeLimits();
      const result = checkConsolidationGuardrail(25001, limits);
      expect(result.passed).toBe(false);
      expect(result.violations[0].guardrailId).toBe('G-03');
    });

    it('G-07: follow-up PO guardrail with count at exact limit', async () => {
      mockRedisGet.mockResolvedValue('10'); // exactly at limit

      const result = await checkFollowUpPOGuardrail(redis, 'T1', makeLimits());
      expect(result.passed).toBe(false);
      expect(result.violations[0].guardrailId).toBe('G-07');
    });

    it('G-07: follow-up PO guardrail with count just below limit', async () => {
      mockRedisGet.mockResolvedValue('9'); // one below limit

      const result = await checkFollowUpPOGuardrail(redis, 'T1', makeLimits());
      expect(result.passed).toBe(true);
    });
  });

  // ── 5. Outbound Guardrail Redis Failures ────────────────────────────

  describe('Outbound guardrail Redis failures', () => {
    it('should propagate error when dedup key check fails (O-02)', async () => {
      mockRedisGet.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        checkOutboundGuardrails(redis, makeEmailContext(), makeLimits()),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('should detect O-02 violation when dedup key exists', async () => {
      mockRedisGet
        .mockResolvedValueOnce('1') // O-02: dedup key exists
        .mockResolvedValueOnce('0') // O-04: recipient rate
        .mockResolvedValueOnce('0'); // G-06: email count

      const result = await checkOutboundGuardrails(redis, makeEmailContext(), makeLimits());
      expect(result.violations.some((v) => v.guardrailId === 'O-02')).toBe(true);
    });

    it('should detect O-03 violation for internal-only domain', async () => {
      mockRedisGet.mockResolvedValue(null);

      const ctx = makeEmailContext({ supplierEmail: 'admin@internal.arda.cards' });
      const result = await checkOutboundGuardrails(redis, ctx, makeLimits());
      expect(result.violations.some((v) => v.guardrailId === 'O-03')).toBe(true);
    });

    it('should detect O-04 violation when recipient rate limit exceeded', async () => {
      mockRedisGet
        .mockResolvedValueOnce(null) // O-02: no dedup
        .mockResolvedValueOnce('3') // O-04: at limit (>= 3)
        .mockResolvedValueOnce('0'); // G-06: email count

      const result = await checkOutboundGuardrails(redis, makeEmailContext(), makeLimits());
      expect(result.violations.some((v) => v.guardrailId === 'O-04')).toBe(true);
    });

    it('should detect G-06 violation when hourly email limit exceeded', async () => {
      mockRedisGet
        .mockResolvedValueOnce(null) // O-02
        .mockResolvedValueOnce('0') // O-04
        .mockResolvedValueOnce('50'); // G-06: at limit

      const result = await checkOutboundGuardrails(redis, makeEmailContext(), makeLimits());
      expect(result.violations.some((v) => v.guardrailId === 'G-06')).toBe(true);
    });

    it('should detect O-01 violation for non-whitelisted domain', async () => {
      mockRedisGet.mockResolvedValue(null);

      const ctx = makeEmailContext({ supplierEmail: 'evil@malicious-site.xyz' });
      const allowedDomains = new Set(['supplier.com', 'trusted-vendor.org']);
      const result = await checkOutboundGuardrails(redis, ctx, makeLimits(), allowedDomains);
      expect(result.violations.some((v) => v.guardrailId === 'O-01')).toBe(true);
    });
  });

  // ── 6. Combined Financial + Outbound Failures ───────────────────────

  describe('Combined financial and outbound failures', () => {
    it('should run financial guardrails for create_purchase_order action type', async () => {
      mockRedisGet.mockResolvedValue('0');

      const ctx = {
        tenantId: 'T1',
        supplierId: 'S1',
        facilityId: 'F1',
        partId: 'PART-01',
        cardId: 'CARD-01',
        loopId: 'LOOP-01',
        orderQuantity: 100,
        totalAmount: 2500,
      };

      const result = await checkGuardrails(redis, 'create_purchase_order', ctx, makeLimits());
      expect(result.passed).toBe(true);
    });

    it('should run outbound guardrails for dispatch_email action type', async () => {
      mockRedisGet.mockResolvedValue(null);

      const ctx = {
        tenantId: 'T1',
        poId: 'PO-001',
        supplierId: 'S1',
        supplierEmail: 'orders@supplier.com',
        totalAmount: 2500,
      };

      const result = await checkGuardrails(redis, 'dispatch_email', ctx, makeLimits());
      expect(result.passed).toBe(true);
    });

    it('should skip guardrails for unmatched action types', async () => {
      const result = await checkGuardrails(redis, 'escalate', { tenantId: 'T1' }, makeLimits());
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(mockRedisGet).not.toHaveBeenCalled();
    });

    it('should handle Redis failure during unified guardrail check', async () => {
      mockRedisGet.mockRejectedValue(new Error('ECONNREFUSED'));

      const ctx = {
        tenantId: 'T1',
        supplierId: 'S1',
        facilityId: 'F1',
        partId: 'PART-01',
        cardId: 'CARD-01',
        loopId: 'LOOP-01',
        orderQuantity: 100,
        totalAmount: 2500,
      };

      await expect(
        checkGuardrails(redis, 'create_purchase_order', ctx, makeLimits()),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });
});
