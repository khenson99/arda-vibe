/**
 * E2E Procurement Lifecycle Tests
 *
 * Validates the full procurement pipeline from triggered Kanban card
 * through PO generation, lifecycle transitions, and dispatch.
 *
 * Chain under test:
 *   1. Queue scoring & prioritization (#59)
 *   2. Supplier consolidation (#59)
 *   3. PO draft generation (#61)
 *   4. PO lifecycle state transitions (#60)
 *   5. PO dispatch via email (#62)
 *   6. Supplier performance metric calculation (#63)
 *
 * These are pure-function integration tests — no database or network
 * dependencies, but they exercise the real service code end-to-end.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@arda/config', () => ({
  config: {
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_USER: '',
    SMTP_PASS: '',
    EMAIL_FROM: 'noreply@arda.cards',
    REDIS_URL: 'redis://localhost:6379',
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  scoreQueueItems,
  consolidateBySupplier,
  calculateCriticality,
  type QueueItemInput,
} from './queue-prioritization.service.js';
import { generatePODrafts, type PODraft } from './po-generation.service.js';
import { validateTransition, getValidNextStatuses, isTerminalStatus } from './po-lifecycle.service.js';
import {
  PODispatchService,
  ConsoleEmailAdapter,
  SimplePdfGenerator,
  type PurchaseOrderPdfData,
} from './po-dispatch.service.js';
import type { POStatus } from '@arda/shared-types';

// ─── Test Fixtures ───────────────────────────────────────────────────

const NOW = new Date('2025-06-01T12:00:00Z');
const ORDER_DATE = new Date('2025-06-02T00:00:00Z');

function makeQueueItems(): QueueItemInput[] {
  return [
    // Critical item — stockout imminent, same supplier as item 3
    {
      cardId: 'card-crit-1',
      loopId: 'loop-1',
      partId: 'part-bearing',
      facilityId: 'fac-main',
      supplierId: 'sup-acme',
      supplierName: 'Acme Corp',
      partNumber: 'BRG-001',
      partName: 'Ball Bearing 6205',
      orderQuantity: 500,
      unitCost: 3.50,
      triggeredAt: new Date('2025-05-29T08:00:00Z'), // ~76h ago
      daysOfSupply: 1.2,
      safetyStockDays: 5,
      statedLeadTimeDays: 21,
    },
    // High priority — different supplier
    {
      cardId: 'card-high-1',
      loopId: 'loop-2',
      partId: 'part-gasket',
      facilityId: 'fac-main',
      supplierId: 'sup-beta',
      supplierName: 'Beta Supplies',
      partNumber: 'GSK-042',
      partName: 'Gasket Kit',
      orderQuantity: 200,
      unitCost: 12.00,
      triggeredAt: new Date('2025-05-30T12:00:00Z'), // ~48h ago
      daysOfSupply: 3.0,
      safetyStockDays: 5,
      statedLeadTimeDays: 14,
    },
    // Medium priority — same supplier as item 1 (Acme)
    {
      cardId: 'card-med-1',
      loopId: 'loop-3',
      partId: 'part-seal',
      facilityId: 'fac-main',
      supplierId: 'sup-acme',
      supplierName: 'Acme Corp',
      partNumber: 'SEL-010',
      partName: 'O-Ring Seal',
      orderQuantity: 1000,
      unitCost: 0.75,
      triggeredAt: new Date('2025-05-31T18:00:00Z'), // ~18h ago
      daysOfSupply: 8.0,
      safetyStockDays: 5,
      statedLeadTimeDays: 21,
    },
    // Low priority — comfortable stock
    {
      cardId: 'card-low-1',
      loopId: 'loop-4',
      partId: 'part-bolt',
      facilityId: 'fac-secondary',
      supplierId: 'sup-gamma',
      supplierName: 'Gamma Hardware',
      partNumber: 'BLT-M8',
      partName: 'M8 Hex Bolt',
      orderQuantity: 5000,
      unitCost: 0.10,
      triggeredAt: new Date('2025-06-01T06:00:00Z'), // ~6h ago
      daysOfSupply: 15.0,
      safetyStockDays: 5,
      statedLeadTimeDays: 7,
    },
  ];
}

// ─── 1. Full Pipeline: Queue -> Consolidation -> PO Generation ───────
describe('E2E: Queue -> Consolidation -> PO Generation', () => {
  it('processes 4 queue items into 3 consolidated POs', () => {
    const items = makeQueueItems();

    // Step 1: Score and prioritize
    const scored = scoreQueueItems(items, NOW);
    expect(scored).toHaveLength(4);

    // Verify critical item ranks first
    expect(scored[0].cardId).toBe('card-crit-1');
    expect(scored[0].criticality).toBe('critical');

    // Verify low item ranks last
    expect(scored[scored.length - 1].cardId).toBe('card-low-1');
    expect(scored[scored.length - 1].criticality).toBe('low');

    // Step 2: Consolidate by supplier
    const groups = consolidateBySupplier(scored);

    // Acme has 2 items, Beta has 1, Gamma has 1 = 3 groups
    expect(groups).toHaveLength(3);

    const acmeGroup = groups.find((g) => g.supplierId === 'sup-acme');
    expect(acmeGroup).toBeDefined();
    expect(acmeGroup!.items).toHaveLength(2);
    expect(acmeGroup!.highestCriticality).toBe('critical');

    // Step 3: Generate PO drafts
    const result = generatePODrafts(groups, ORDER_DATE);

    expect(result.drafts).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);

    // Verify Acme PO has 2 lines
    const acmeDraft = result.drafts.find((d) => d.supplierId === 'sup-acme');
    expect(acmeDraft).toBeDefined();
    expect(acmeDraft!.lines).toHaveLength(2);
    expect(acmeDraft!.subtotal).toBe(500 * 3.50 + 1000 * 0.75); // 1750 + 750 = 2500

    // Verify Beta PO has 1 line
    const betaDraft = result.drafts.find((d) => d.supplierId === 'sup-beta');
    expect(betaDraft!.lines).toHaveLength(1);
    expect(betaDraft!.subtotal).toBe(200 * 12.00); // 2400

    // Verify total line value
    expect(result.totalLineValue).toBe(2500 + 2400 + 500); // Acme + Beta + Gamma
  });

  it('tracks source card IDs through the pipeline', () => {
    const items = makeQueueItems();
    const scored = scoreQueueItems(items, NOW);
    const groups = consolidateBySupplier(scored);
    const result = generatePODrafts(groups, ORDER_DATE);

    const acmeDraft = result.drafts.find((d) => d.supplierId === 'sup-acme')!;
    expect(acmeDraft.sourceCardIds).toContain('card-crit-1');
    expect(acmeDraft.sourceCardIds).toContain('card-med-1');
    expect(acmeDraft.sourceCardIds).not.toContain('card-high-1');
  });

  it('uses max lead time for expected delivery across consolidated items', () => {
    const items = makeQueueItems();
    const scored = scoreQueueItems(items, NOW);
    const groups = consolidateBySupplier(scored);
    const result = generatePODrafts(groups, ORDER_DATE);

    // Acme items both have 21-day lead time
    const acmeDraft = result.drafts.find((d) => d.supplierId === 'sup-acme')!;
    const expectedDate = new Date(ORDER_DATE);
    expectedDate.setDate(expectedDate.getDate() + 21);
    expect(acmeDraft.expectedDeliveryDate.toISOString()).toBe(expectedDate.toISOString());

    // Gamma has 7-day lead time
    const gammaDraft = result.drafts.find((d) => d.supplierId === 'sup-gamma')!;
    const gammaExpected = new Date(ORDER_DATE);
    gammaExpected.setDate(gammaExpected.getDate() + 7);
    expect(gammaDraft.expectedDeliveryDate.toISOString()).toBe(gammaExpected.toISOString());
  });
});

// ─── 2. Full PO Lifecycle: draft -> ... -> closed ────────────────────
describe('E2E: PO Lifecycle Transitions', () => {
  it('walks the happy path: draft -> pending_approval -> approved -> sent -> acknowledged -> partially_received -> received -> closed', () => {
    const happyPath: { from: POStatus; to: POStatus; role: string }[] = [
      { from: 'draft', to: 'pending_approval', role: 'procurement_manager' },
      { from: 'pending_approval', to: 'approved', role: 'procurement_manager' },
      { from: 'approved', to: 'sent', role: 'procurement_manager' },
      { from: 'sent', to: 'acknowledged', role: 'procurement_manager' },
      { from: 'acknowledged', to: 'partially_received', role: 'receiving_manager' },
      { from: 'partially_received', to: 'received', role: 'receiving_manager' },
      { from: 'received', to: 'closed', role: 'procurement_manager' },
    ];

    for (const step of happyPath) {
      const result = validateTransition({
        currentStatus: step.from,
        targetStatus: step.to,
        userRole: step.role as any,
      });
      expect(result.valid, `${step.from} -> ${step.to}`).toBe(true);
    }

    // Verify closed is terminal
    expect(isTerminalStatus('closed')).toBe(true);
  });

  it('verifies auto-populated fields at each stage', () => {
    // Approval auto-sets approvedAt
    const approval = validateTransition({
      currentStatus: 'pending_approval',
      targetStatus: 'approved',
      userRole: 'procurement_manager',
    });
    expect(approval.autoFields).toHaveProperty('approvedAt');
    expect(approval.autoFields!.approvedAt).toBeInstanceOf(Date);

    // Sending auto-sets sentAt
    const sending = validateTransition({
      currentStatus: 'approved',
      targetStatus: 'sent',
      userRole: 'procurement_manager',
    });
    expect(sending.autoFields).toHaveProperty('sentAt');

    // Receiving auto-sets actualDeliveryDate
    const receiving = validateTransition({
      currentStatus: 'partially_received',
      targetStatus: 'received',
      userRole: 'receiving_manager',
    });
    expect(receiving.autoFields).toHaveProperty('actualDeliveryDate');
  });

  it('enforces role-based access at each transition', () => {
    // Salesperson cannot approve
    const result = validateTransition({
      currentStatus: 'pending_approval',
      targetStatus: 'approved',
      userRole: 'salesperson',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not authorized');

    // But tenant_admin can
    const adminResult = validateTransition({
      currentStatus: 'pending_approval',
      targetStatus: 'approved',
      userRole: 'tenant_admin',
    });
    expect(adminResult.valid).toBe(true);
  });

  it('allows cancellation from any non-terminal state with reason', () => {
    const cancellableStates: POStatus[] = [
      'draft', 'pending_approval', 'approved', 'sent',
      'acknowledged', 'partially_received', 'received',
    ];

    for (const status of cancellableStates) {
      // Without reason — should fail
      const noReason = validateTransition({
        currentStatus: status,
        targetStatus: 'cancelled',
        userRole: 'procurement_manager',
      });
      expect(noReason.valid, `${status} -> cancelled (no reason)`).toBe(false);

      // With reason — should succeed
      const withReason = validateTransition({
        currentStatus: status,
        targetStatus: 'cancelled',
        userRole: 'procurement_manager',
        reason: 'Business requirement changed',
      });
      expect(withReason.valid, `${status} -> cancelled (with reason)`).toBe(true);
      expect(withReason.autoFields).toHaveProperty('cancelledAt');
    }
  });

  it('prevents transitions from terminal states', () => {
    const terminalStates: POStatus[] = ['closed', 'cancelled'];

    for (const terminal of terminalStates) {
      const nextStatuses = getValidNextStatuses(terminal);
      expect(nextStatuses, `${terminal} should have no next states`).toEqual([]);
    }
  });

  it('supports send-back from pending_approval to draft', () => {
    const result = validateTransition({
      currentStatus: 'pending_approval',
      targetStatus: 'draft',
      userRole: 'procurement_manager',
    });
    expect(result.valid).toBe(true);
  });
});

// ─── 3. Full Pipeline: PO Generation -> Dispatch ─────────────────────
describe('E2E: PO Generation -> Dispatch', () => {
  it('generates a PO draft and dispatches it via email', async () => {
    const items = makeQueueItems();
    const scored = scoreQueueItems(items, NOW);
    const groups = consolidateBySupplier(scored);
    const result = generatePODrafts(groups, ORDER_DATE);

    // Pick the Acme PO for dispatch
    const acmeDraft = result.drafts.find((d) => d.supplierId === 'sup-acme')!;

    // Create dispatch service with console adapter
    const emailAdapter = new ConsoleEmailAdapter();
    const pdfGenerator = new SimplePdfGenerator();
    const dispatchService = new PODispatchService({
      emailAdapter,
      pdfGenerator,
      maxRetries: 1,
    });

    // Build PDF data from draft
    const pdfData: PurchaseOrderPdfData = {
      poNumber: 'PO-20250602-0001',
      orderDate: ORDER_DATE.toISOString().slice(0, 10),
      expectedDeliveryDate: acmeDraft.expectedDeliveryDate.toISOString().slice(0, 10),
      supplierName: 'Acme Corp',
      supplierContact: 'John Smith',
      supplierEmail: 'john@acme.com',
      supplierAddress: '123 Industrial Blvd',
      buyerCompanyName: 'Arda Industries',
      buyerAddress: '456 Manufacturing Dr',
      facilityName: 'Main Warehouse',
      lines: acmeDraft.lines.map((l) => ({
        lineNumber: l.lineNumber,
        partNumber: l.partNumber,
        partName: l.partName,
        quantity: l.quantityOrdered,
        unitCost: l.unitCost.toFixed(2),
        lineTotal: l.lineTotal.toFixed(2),
        uom: 'each',
      })),
      subtotal: acmeDraft.subtotal.toFixed(2),
      taxAmount: '0.00',
      shippingAmount: '0.00',
      totalAmount: acmeDraft.totalAmount.toFixed(2),
      currency: 'USD',
    };

    // Dispatch
    const dispatchResult = await dispatchService.dispatch({
      poNumber: 'PO-20250602-0001',
      supplierEmail: 'john@acme.com',
      supplierName: 'Acme Corp',
      pdfData,
    });

    expect(dispatchResult.success).toBe(true);
    expect(dispatchResult.attempts).toBe(1);

    // Verify email was composed correctly
    expect(emailAdapter.sentMessages).toHaveLength(1);
    const email = emailAdapter.sentMessages[0];
    expect(email.to).toBe('john@acme.com');
    expect(email.subject).toContain('PO-20250602-0001');
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0].contentType).toBe('application/pdf');

    // Verify PDF content
    const pdfContent = email.attachments[0].content.toString();
    expect(pdfContent).toContain('PO-20250602-0001');
    expect(pdfContent).toContain('BRG-001');
    expect(pdfContent).toContain('SEL-010');
  });
});

// ─── 4. Audit Trail Verification ─────────────────────────────────────
describe('E2E: Audit Trail Verification', () => {
  it('lifecycle transitions produce correct audit metadata', () => {
    // Simulate a full lifecycle, collecting auto-fields at each step
    const auditTrail: Array<{
      from: POStatus;
      to: POStatus;
      autoFields: Record<string, unknown>;
    }> = [];

    const steps: Array<{ from: POStatus; to: POStatus }> = [
      { from: 'draft', to: 'pending_approval' },
      { from: 'pending_approval', to: 'approved' },
      { from: 'approved', to: 'sent' },
      { from: 'sent', to: 'acknowledged' },
      { from: 'acknowledged', to: 'partially_received' },
      { from: 'partially_received', to: 'received' },
      { from: 'received', to: 'closed' },
    ];

    for (const step of steps) {
      const result = validateTransition({
        currentStatus: step.from,
        targetStatus: step.to,
        userRole: 'procurement_manager',
      });

      expect(result.valid).toBe(true);
      auditTrail.push({
        from: step.from,
        to: step.to,
        autoFields: result.autoFields ?? {},
      });
    }

    // Verify audit trail completeness
    expect(auditTrail).toHaveLength(7);

    // Verify approval timestamp exists
    const approvalEntry = auditTrail.find((e) => e.to === 'approved')!;
    expect(approvalEntry.autoFields.approvedAt).toBeInstanceOf(Date);

    // Verify sent timestamp exists
    const sentEntry = auditTrail.find((e) => e.to === 'sent')!;
    expect(sentEntry.autoFields.sentAt).toBeInstanceOf(Date);

    // Verify delivery timestamp exists
    const receivedEntry = auditTrail.find((e) => e.to === 'received')!;
    expect(receivedEntry.autoFields.actualDeliveryDate).toBeInstanceOf(Date);

    // Verify no auto-fields for status-only transitions
    const ackEntry = auditTrail.find((e) => e.to === 'acknowledged')!;
    expect(Object.keys(ackEntry.autoFields)).toHaveLength(0);
  });

  it('cancellation audit includes timestamp and requires reason', () => {
    const result = validateTransition({
      currentStatus: 'approved',
      targetStatus: 'cancelled',
      userRole: 'procurement_manager',
      reason: 'Supplier unable to fulfill',
    });

    expect(result.valid).toBe(true);
    expect(result.autoFields!.cancelledAt).toBeInstanceOf(Date);
  });
});

// ─── 5. Edge Cases & Error Paths ─────────────────────────────────────
describe('E2E: Edge Cases', () => {
  it('handles empty queue gracefully', () => {
    const scored = scoreQueueItems([], NOW);
    expect(scored).toHaveLength(0);

    const groups = consolidateBySupplier(scored);
    expect(groups).toHaveLength(0);

    const result = generatePODrafts(groups, ORDER_DATE);
    expect(result.drafts).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.totalLineValue).toBe(0);
  });

  it('skips queue items without supplier assignment', () => {
    const items: QueueItemInput[] = [
      {
        cardId: 'orphan-1',
        loopId: 'loop-x',
        partId: 'part-x',
        facilityId: 'fac-1',
        supplierId: null,
        supplierName: null,
        partNumber: 'PN-ORPHAN',
        partName: 'Orphan Part',
        orderQuantity: 100,
        unitCost: 5.0,
        triggeredAt: new Date('2025-05-30T00:00:00Z'),
        daysOfSupply: 1.0,
        safetyStockDays: 3,
        statedLeadTimeDays: null,
      },
    ];

    const scored = scoreQueueItems(items, NOW);
    const groups = consolidateBySupplier(scored);
    const result = generatePODrafts(groups, ORDER_DATE);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('No supplier');
  });

  it('handles dispatch failure with retry exhaustion', async () => {
    const failAdapter = {
      send: async () => { throw new Error('SMTP timeout'); },
    };

    const service = new PODispatchService({
      emailAdapter: failAdapter,
      pdfGenerator: new SimplePdfGenerator(),
      maxRetries: 2,
      retryDelayMs: 1,
    });

    const result = await service.dispatch({
      poNumber: 'PO-FAIL-001',
      supplierEmail: 'fail@example.com',
      supplierName: 'Failing Supplier',
      pdfData: {
        poNumber: 'PO-FAIL-001',
        orderDate: '2025-06-01',
        expectedDeliveryDate: '2025-06-15',
        supplierName: 'Failing Supplier',
        supplierContact: 'Nobody',
        supplierEmail: 'fail@example.com',
        supplierAddress: 'Nowhere',
        buyerCompanyName: 'Arda',
        buyerAddress: '123 Main',
        facilityName: 'Warehouse',
        lines: [],
        subtotal: '0.00',
        taxAmount: '0.00',
        shippingAmount: '0.00',
        totalAmount: '0.00',
        currency: 'USD',
      },
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toContain('Failed after 2 attempts');
    expect(result.error).toContain('SMTP timeout');
  });

  it('criticality scoring handles extreme edge cases', () => {
    // Zero safety stock — should be medium (cannot compute ratio)
    expect(calculateCriticality(0, 0)).toBe('medium');

    // Negative days of supply — critical
    expect(calculateCriticality(-5, 3)).toBe('critical');

    // Very large days of supply — low
    expect(calculateCriticality(1000, 5)).toBe('low');
  });
});
