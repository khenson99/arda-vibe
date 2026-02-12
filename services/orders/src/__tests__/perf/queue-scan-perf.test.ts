/**
 * Performance Tests for Order Queue and Risk Scan Data Paths
 *
 * These tests validate p95 latency targets after the optimizations
 * introduced in Issue #91:
 *   - Queue list endpoint:       p95 < 200ms
 *   - Risk scan computation:     p95 < 300ms
 *   - Order conversion (PO/WO):  p95 < 150ms
 *
 * Prerequisites:
 *   - A seeded database with at least 500 kanban cards across 50 loops
 *   - Redis running for BullMQ queue operations
 *   - Set PERF_TEST=1 env var to enable these tests
 *
 * Run: PERF_TEST=1 npx vitest run src/__tests__/perf/queue-scan-perf.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { db, schema } from '@arda/db';
import { eq, and, sql } from 'drizzle-orm';
import { runQueueRiskScanForTenant } from '../../routes/order-queue.routes.js';

const { kanbanCards, kanbanLoops } = schema;

const ENABLED = process.env.PERF_TEST === '1';
const TENANT_ID = process.env.PERF_TENANT_ID ?? 'perf-test-tenant';
const ITERATIONS = 20;

function percentile(sortedValues: number[], p: number): number {
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)]!;
}

async function measure(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

describe.skipIf(!ENABLED)('Queue & Scan Performance', () => {
  let triggeredCardCount = 0;

  beforeAll(async () => {
    // Verify test data exists
    const [{ count }] = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(kanbanCards)
      .where(
        and(
          eq(kanbanCards.tenantId, TENANT_ID),
          eq(kanbanCards.currentStage, 'triggered'),
          eq(kanbanCards.isActive, true)
        )
      );
    triggeredCardCount = count;

    if (triggeredCardCount < 10) {
      console.warn(
        `[perf] Only ${triggeredCardCount} triggered cards found for tenant ${TENANT_ID}. ` +
          'Results may not be representative. Seed more data for reliable benchmarks.'
      );
    }
  });

  it('queue list query should complete within p95 < 200ms', async () => {
    const durations: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const ms = await measure(async () => {
        await db
          .select({
            id: kanbanCards.id,
            cardNumber: kanbanCards.cardNumber,
            currentStage: kanbanCards.currentStage,
            currentStageEnteredAt: kanbanCards.currentStageEnteredAt,
            loopId: kanbanCards.loopId,
            loopType: kanbanLoops.loopType,
          })
          .from(kanbanCards)
          .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
          .where(
            and(
              eq(kanbanCards.tenantId, TENANT_ID),
              eq(kanbanCards.currentStage, 'triggered'),
              eq(kanbanCards.isActive, true)
            )
          )
          .execute();
      });
      durations.push(ms);
    }

    durations.sort((a, b) => a - b);
    const p95 = percentile(durations, 95);
    const p50 = percentile(durations, 50);

    console.log(
      `[perf] Queue list: p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, ` +
        `cards=${triggeredCardCount}, iterations=${ITERATIONS}`
    );

    expect(p95).toBeLessThan(200);
  });

  it('risk scan should complete within p95 < 300ms', async () => {
    const durations: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const ms = await measure(async () => {
        await runQueueRiskScanForTenant({
          tenantId: TENANT_ID,
          lookbackDays: 30,
          minRiskLevel: 'medium',
          limit: 100,
          emitEvents: false,
        });
      });
      durations.push(ms);
    }

    durations.sort((a, b) => a - b);
    const p95 = percentile(durations, 95);
    const p50 = percentile(durations, 50);

    console.log(
      `[perf] Risk scan: p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, ` +
        `cards=${triggeredCardCount}, iterations=${ITERATIONS}`
    );

    expect(p95).toBeLessThan(300);
  });

  it('draft PO lookup should complete within p95 < 150ms', async () => {
    // Fetch card IDs to use for the draft PO lookup
    const cards = await db
      .select({ id: kanbanCards.id })
      .from(kanbanCards)
      .where(
        and(
          eq(kanbanCards.tenantId, TENANT_ID),
          eq(kanbanCards.currentStage, 'triggered'),
          eq(kanbanCards.isActive, true)
        )
      )
      .limit(100)
      .execute();

    const cardIds = cards.map((c) => c.id);
    if (cardIds.length === 0) {
      console.warn('[perf] No triggered cards found, skipping draft PO lookup test');
      return;
    }

    const durations: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const ms = await measure(async () => {
        await db.execute(
          sql`SELECT DISTINCT ON (pol.kanban_card_id)
                pol.kanban_card_id,
                pol.purchase_order_id
              FROM orders.purchase_order_lines pol
              INNER JOIN orders.purchase_orders po ON po.id = pol.purchase_order_id
              WHERE pol.tenant_id = ${TENANT_ID}
                AND po.tenant_id = ${TENANT_ID}
                AND pol.kanban_card_id = ANY(${cardIds})
                AND po.status = 'draft'
              ORDER BY pol.kanban_card_id, po.created_at DESC`
        );
      });
      durations.push(ms);
    }

    durations.sort((a, b) => a - b);
    const p95 = percentile(durations, 95);
    const p50 = percentile(durations, 50);

    console.log(
      `[perf] Draft PO lookup: p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, ` +
        `cardCount=${cardIds.length}, iterations=${ITERATIONS}`
    );

    expect(p95).toBeLessThan(150);
  });
});
