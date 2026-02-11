import { eq, and, sql, desc, asc } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import { getEventBus, type ScanConflictDetectedEvent } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import { ScanDedupeManager, ScanDuplicateError } from './scan-dedupe-manager.js';
import type {
  CardStage,
  UserRole,
  LoopType,
  ScanConflictResolution,
  ScanReplayItem,
  ScanReplayResult,
} from '@arda/shared-types';

const {
  kanbanCards,
  kanbanLoops,
  cardStageTransitions,
  kanbanParameterHistory,
} = schema;

const log = createLogger('card-lifecycle');

// ─── Scan Dedupe Singleton ──────────────────────────────────────────
let scanDedupeManager: ScanDedupeManager | null = null;

export function initScanDedupeManager(redisUrl: string): ScanDedupeManager {
  if (!scanDedupeManager) {
    scanDedupeManager = new ScanDedupeManager(redisUrl);
    log.info('ScanDedupeManager initialized');
  }
  return scanDedupeManager;
}

export function getScanDedupeManager(): ScanDedupeManager | null {
  return scanDedupeManager;
}

// ═══════════════════════════════════════════════════════════════════════
// LIFECYCLE ORCHESTRATOR — Enhanced Transition Engine
// ═══════════════════════════════════════════════════════════════════════
//
// This module implements a 9-step lifecycle transition pipeline:
//   1. Idempotency check (dedup by key)
//   2. Card fetch (with tenant isolation)
//   3. Stage validation (TRANSITION_MATRIX)
//   4. Role authorization (TRANSITION_RULES)
//   5. Loop-type compatibility check
//   6. Method validation
//   7. Precondition enforcement (linked orders, etc.)
//   8. Atomic DB transaction (card update + transition record + lifecycle event)
//   9. Domain event emission (fire-and-forget via Redis pub/sub)
//
// ═══════════════════════════════════════════════════════════════════════

// ─── Transition Matrix ───────────────────────────────────────────────
// Maps each stage to its allowed next stages. This is the source of truth
// for the Kanban flow: CREATED → TRIGGERED → ORDERED → IN_TRANSIT → RECEIVED → RESTOCKED → CREATED
export const VALID_TRANSITIONS: Record<string, string[]> = {
  created: ['triggered'],
  triggered: ['ordered'],
  ordered: ['in_transit', 'received'], // in_transit can be skipped for local procurement
  in_transit: ['received'],
  received: ['restocked'],
  restocked: ['created'], // loop restart (new cycle)
};

// Alias for enhanced API consumers
export const TRANSITION_MATRIX = VALID_TRANSITIONS;

// ─── Transition Rules ────────────────────────────────────────────────
// Each rule defines who can perform a transition, under what conditions,
// and with which methods. This is the authorization layer for the lifecycle.

export interface TransitionRule {
  from: CardStage;
  to: CardStage;
  allowedRoles: UserRole[];
  allowedLoopTypes: LoopType[];
  allowedMethods: ('qr_scan' | 'manual' | 'system')[];
  requiresLinkedOrder?: boolean;
  linkedOrderTypes?: ('purchase_order' | 'work_order' | 'transfer_order')[];
  description: string;
}

export const TRANSITION_RULES: TransitionRule[] = [
  {
    from: 'created',
    to: 'triggered',
    allowedRoles: ['tenant_admin', 'inventory_manager', 'procurement_manager', 'receiving_manager'],
    allowedLoopTypes: ['procurement', 'production', 'transfer'],
    allowedMethods: ['qr_scan', 'manual', 'system'],
    description: 'Scan or manually trigger replenishment signal',
  },
  {
    from: 'triggered',
    to: 'ordered',
    allowedRoles: ['tenant_admin', 'inventory_manager', 'procurement_manager'],
    allowedLoopTypes: ['procurement', 'production', 'transfer'],
    allowedMethods: ['manual', 'system'],
    requiresLinkedOrder: true,
    linkedOrderTypes: ['purchase_order', 'work_order', 'transfer_order'],
    description: 'Link to PO/WO/TO and advance to ordered',
  },
  {
    from: 'ordered',
    to: 'in_transit',
    allowedRoles: ['tenant_admin', 'inventory_manager', 'procurement_manager', 'receiving_manager'],
    allowedLoopTypes: ['procurement', 'transfer'],
    allowedMethods: ['manual', 'system'],
    description: 'Mark shipment as in transit (skip for production)',
  },
  {
    from: 'ordered',
    to: 'received',
    allowedRoles: ['tenant_admin', 'inventory_manager', 'receiving_manager'],
    allowedLoopTypes: ['production'],
    allowedMethods: ['manual', 'system', 'qr_scan'],
    description: 'Direct receive for production loops (skip in_transit)',
  },
  {
    from: 'in_transit',
    to: 'received',
    allowedRoles: ['tenant_admin', 'inventory_manager', 'receiving_manager'],
    allowedLoopTypes: ['procurement', 'transfer'],
    allowedMethods: ['manual', 'system', 'qr_scan'],
    description: 'Receive goods at destination facility',
  },
  {
    from: 'received',
    to: 'restocked',
    allowedRoles: ['tenant_admin', 'inventory_manager', 'receiving_manager'],
    allowedLoopTypes: ['procurement', 'production', 'transfer'],
    allowedMethods: ['manual', 'system', 'qr_scan'],
    description: 'Confirm restock at storage location',
  },
  {
    from: 'restocked',
    to: 'created',
    allowedRoles: ['tenant_admin', 'inventory_manager'],
    allowedLoopTypes: ['procurement', 'production', 'transfer'],
    allowedMethods: ['manual', 'system'],
    description: 'Reset card for new cycle',
  },
];

// ─── Rule Lookup Helpers ─────────────────────────────────────────────

export function isRoleAllowed(from: CardStage, to: CardStage, role: UserRole): boolean {
  if (role === 'tenant_admin') return true;
  const rule = TRANSITION_RULES.find((r) => r.from === from && r.to === to);
  return rule ? rule.allowedRoles.includes(role) : false;
}

export function isLoopTypeAllowed(from: CardStage, to: CardStage, loopType: LoopType): boolean {
  const rule = TRANSITION_RULES.find((r) => r.from === from && r.to === to);
  return rule ? rule.allowedLoopTypes.includes(loopType) : false;
}

export function isMethodAllowed(from: CardStage, to: CardStage, method: string): boolean {
  const rule = TRANSITION_RULES.find((r) => r.from === from && r.to === to);
  return rule ? rule.allowedMethods.includes(method as 'qr_scan' | 'manual' | 'system') : false;
}

/** Check if a stage transition is allowed by the Kanban flow rules. */
export function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Transition a Card to the Next Stage ──────────────────────────────
// Enhanced 9-step orchestrator with RBAC, idempotency, and lifecycle events.
export async function transitionCard(input: {
  cardId: string;
  tenantId: string;
  toStage: CardStage;
  userId?: string;
  userRole?: UserRole;
  method: 'qr_scan' | 'manual' | 'system';
  notes?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  linkedOrderId?: string;
  linkedOrderType?: 'purchase_order' | 'work_order' | 'transfer_order';
  quantity?: number;
}): Promise<{
  card: typeof kanbanCards.$inferSelect;
  transition: typeof cardStageTransitions.$inferSelect;
  eventId?: string;
}> {
  const {
    cardId, tenantId, toStage, userId, userRole, method,
    notes, metadata, idempotencyKey, linkedOrderId, linkedOrderType, quantity,
  } = input;

  // ── Step 2: Fetch Card with Tenant Isolation ──
  const card = await db.query.kanbanCards.findFirst({
    where: and(eq(kanbanCards.id, cardId), eq(kanbanCards.tenantId, tenantId)),
    with: { loop: true },
  });

  if (!card) {
    throw new AppError(404, 'Kanban card not found', 'CARD_NOT_FOUND');
  }

  if (!card.isActive) {
    throw new AppError(400, 'Card is deactivated', 'CARD_INACTIVE');
  }

  // ── Step 1: Persistent Idempotency Check ──
  // Idempotency must survive process restarts and horizontal scaling.
  if (idempotencyKey) {
    const [existingTransition] = await db
      .select()
      .from(cardStageTransitions)
      .where(
        and(
          eq(cardStageTransitions.tenantId, tenantId),
          eq(cardStageTransitions.cardId, cardId),
          sql`${cardStageTransitions.metadata} ->> 'idempotencyKey' = ${idempotencyKey}`
        )
      )
      .orderBy(desc(cardStageTransitions.transitionedAt))
      .limit(1);

    if (existingTransition) {
      return {
        card,
        transition: existingTransition,
      };
    }
  }

  const currentStage = card.currentStage as CardStage;
  const loopType = card.loop.loopType as LoopType;

  // ── Step 3: Stage Validation ──
  if (!isValidTransition(currentStage, toStage)) {
    const allowed = VALID_TRANSITIONS[currentStage];
    throw new AppError(
      400,
      `Invalid transition: ${currentStage} → ${toStage}. Allowed: ${allowed?.join(', ')}`,
      'INVALID_TRANSITION'
    );
  }

  // ── Step 4: Role Authorization ──
  if (userRole && !isRoleAllowed(currentStage, toStage, userRole)) {
    throw new AppError(
      403,
      `Role '${userRole}' cannot perform transition ${currentStage} → ${toStage}`,
      'ROLE_NOT_ALLOWED'
    );
  }

  // ── Step 5: Loop-Type Compatibility ──
  if (!isLoopTypeAllowed(currentStage, toStage, loopType)) {
    throw new AppError(
      400,
      `Transition ${currentStage} → ${toStage} is not allowed for '${loopType}' loops`,
      'LOOP_TYPE_INCOMPATIBLE'
    );
  }

  // ── Step 6: Method Validation ──
  if (!isMethodAllowed(currentStage, toStage, method)) {
    throw new AppError(
      400,
      `Method '${method}' is not allowed for transition ${currentStage} → ${toStage}`,
      'METHOD_NOT_ALLOWED'
    );
  }

  // ── Step 7: Precondition Enforcement ──
  const rule = TRANSITION_RULES.find((r) => r.from === currentStage && r.to === toStage);
  if (rule?.requiresLinkedOrder) {
    if (!linkedOrderId || !linkedOrderType) {
      throw new AppError(
        400,
        `Transition ${currentStage} → ${toStage} requires linkedOrderId and linkedOrderType`,
        'LINKED_ORDER_REQUIRED'
      );
    }
    if (rule.linkedOrderTypes && !rule.linkedOrderTypes.includes(linkedOrderType)) {
      throw new AppError(
        400,
        `Order type '${linkedOrderType}' is not valid for this transition. Expected: ${rule.linkedOrderTypes.join(', ')}`,
        'INVALID_ORDER_TYPE'
      );
    }
  }

  // Determine cycle number
  let cycleNumber = card.completedCycles + 1;
  const now = new Date();

  // Calculate stage duration from previous stage entry
  const stageDurationSeconds = card.currentStageEnteredAt
    ? Math.round((now.getTime() - new Date(card.currentStageEnteredAt).getTime()) / 1000)
    : null;

  // ── Step 8: Atomic DB Transaction ──
  const result = await db.transaction(async (tx) => {
    // Record the transition (immutable audit)
    const [transition] = await tx
      .insert(cardStageTransitions)
      .values({
        tenantId,
        cardId,
        loopId: card.loopId,
        cycleNumber,
        fromStage: currentStage,
        toStage,
        transitionedAt: now,
        transitionedByUserId: userId,
        method,
        notes,
        metadata: {
          ...(metadata ?? {}),
          ...(linkedOrderId ? { linkedOrderId, linkedOrderType } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(quantity ? { quantity } : {}),
          ...(stageDurationSeconds !== null ? { stageDurationSeconds } : {}),
        },
      })
      .returning();

    // Build the card update
    const updateData: Record<string, unknown> = {
      currentStage: toStage,
      currentStageEnteredAt: now,
      updatedAt: now,
    };

    // Link orders when transitioning to 'ordered'
    if (linkedOrderId && linkedOrderType) {
      if (linkedOrderType === 'purchase_order') updateData.linkedPurchaseOrderId = linkedOrderId;
      if (linkedOrderType === 'work_order') updateData.linkedWorkOrderId = linkedOrderId;
      if (linkedOrderType === 'transfer_order') updateData.linkedTransferOrderId = linkedOrderId;
    }

    // If completing a cycle (restocked → created), increment the cycle counter
    if (currentStage === 'restocked' && toStage === 'created') {
      updateData.completedCycles = sql`${kanbanCards.completedCycles} + 1`;
      updateData.linkedPurchaseOrderId = null;
      updateData.linkedWorkOrderId = null;
      updateData.linkedTransferOrderId = null;
    }

    const [updatedCard] = await tx
      .update(kanbanCards)
      .set(updateData)
      .where(eq(kanbanCards.id, cardId))
      .returning();

    return { card: updatedCard, transition };
  });

  // ── Step 9: Domain Event Emission (fire-and-forget) ──
  let eventId: string | undefined;
  try {
    const eventBus = getEventBus(config.REDIS_URL);

    // Primary transition event
    eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await eventBus.publish({
      type: 'lifecycle.transition',
      eventId,
      tenantId,
      cardId,
      loopId: card.loopId,
      fromStage: currentStage,
      toStage,
      method,
      userId,
      cycleNumber,
      stageDurationSeconds: stageDurationSeconds ?? undefined,
      idempotencyKey,
      timestamp: now.toISOString(),
    });

    // Queue entry event (when card is triggered, it enters the order queue)
    if (toStage === 'triggered') {
      await eventBus.publish({
        type: 'lifecycle.queue_entry',
        tenantId,
        cardId,
        loopId: card.loopId,
        loopType,
        partId: card.loop.partId,
        facilityId: card.loop.facilityId,
        quantity: quantity ?? card.loop.orderQuantity,
        timestamp: now.toISOString(),
      });
    }

    // Order linked event
    if (linkedOrderId && linkedOrderType && toStage === 'ordered') {
      await eventBus.publish({
        type: 'lifecycle.order_linked',
        tenantId,
        cardId,
        loopId: card.loopId,
        orderId: linkedOrderId,
        orderType: linkedOrderType,
        timestamp: now.toISOString(),
      });
    }

    // Cycle complete event
    if (currentStage === 'restocked' && toStage === 'created') {
      const [cycleStartTransition] = await db
        .select({ transitionedAt: cardStageTransitions.transitionedAt })
        .from(cardStageTransitions)
        .where(
          and(
            eq(cardStageTransitions.tenantId, tenantId),
            eq(cardStageTransitions.cardId, cardId),
            eq(cardStageTransitions.cycleNumber, cycleNumber)
          )
        )
        .orderBy(asc(cardStageTransitions.transitionedAt))
        .limit(1);

      const totalCycleDurationSeconds = cycleStartTransition
        ? Math.max(
            0,
            Math.round((now.getTime() - cycleStartTransition.transitionedAt.getTime()) / 1000)
          )
        : stageDurationSeconds ?? 0;

      await eventBus.publish({
        type: 'lifecycle.cycle_complete',
        tenantId,
        cardId,
        loopId: card.loopId,
        cycleNumber,
        totalCycleDurationSeconds,
        timestamp: now.toISOString(),
      });
    }
  } catch {
    // Non-critical: don't fail the transition if event publishing fails
    console.error(`[card-lifecycle] Failed to publish lifecycle event for card ${cardId}`);
  }

  const finalResult = { ...result, eventId };
  return finalResult;
}

// ─── Trigger a Card via QR Scan ───────────────────────────────────────
// This is the primary entry point when a user scans a QR code.
// It transitions the card from 'created' to 'triggered' and adds the
// part to the appropriate queue.
//
// Enhanced with:
//   - Redis-backed idempotency (ScanDedupeManager) for fast duplicate rejection
//   - Conflict detection with granular resolution codes
//   - Event emission for conflict visibility
export async function triggerCardByScan(input: {
  cardId: string;
  scannedByUserId?: string;
  tenantId?: string;
  location?: { lat?: number; lng?: number };
  idempotencyKey?: string;
  scannedAt?: string;
}): Promise<{
  card: typeof kanbanCards.$inferSelect;
  loopType: string;
  partId: string;
  message: string;
}> {
  const { cardId, scannedByUserId, tenantId, location, idempotencyKey, scannedAt } = input;

  // ── Dedupe Fast-Path ──
  // If the caller provides an idempotency key and the dedupe manager is active,
  // check Redis before hitting the database. This rejects duplicate scans in ~1ms.
  if (idempotencyKey && scanDedupeManager) {
    const dedupeResult = await scanDedupeManager.checkAndClaim(
      cardId,
      idempotencyKey,
      tenantId ?? 'unknown',
    );

    if (!dedupeResult.allowed) {
      throw new ScanDuplicateError(
        cardId,
        idempotencyKey,
        dedupeResult.existingStatus ?? 'unknown',
      );
    }
  }

  // Fetch the card (no tenant context — this is a public scan)
  const card = await db.query.kanbanCards.findFirst({
    where: eq(kanbanCards.id, cardId),
    with: {
      loop: true,
    },
  });

  if (!card) {
    if (idempotencyKey && scanDedupeManager) {
      await scanDedupeManager.markFailed(cardId, idempotencyKey, 'CARD_NOT_FOUND');
    }
    throw new AppError(404, 'Card not found. This QR code may be invalid.', 'CARD_NOT_FOUND');
  }

  if (tenantId && card.tenantId !== tenantId) {
    if (idempotencyKey && scanDedupeManager) {
      await scanDedupeManager.markFailed(cardId, idempotencyKey, 'TENANT_MISMATCH');
    }
    throw new AppError(403, 'Card does not belong to your tenant.', 'TENANT_MISMATCH');
  }

  // ── Conflict Detection ──
  // Replace simple stage check with granular conflict resolution
  const conflict = detectScanConflict(card.currentStage as CardStage, card.isActive);

  if (conflict !== 'ok') {
    if (idempotencyKey && scanDedupeManager) {
      await scanDedupeManager.markFailed(cardId, idempotencyKey, `SCAN_CONFLICT:${conflict}`);
    }

    // Emit conflict event for observability
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'scan.conflict_detected',
        tenantId: card.tenantId,
        payload: {
          cardId,
          scannedByUserId,
          currentStage: card.currentStage,
          resolution: conflict,
          idempotencyKey,
          scannedAt: scannedAt ?? new Date().toISOString(),
          timestamp: new Date().toISOString(),
        },
      } as ScanConflictDetectedEvent);
    } catch {
      log.warn({ cardId, conflict }, 'Failed to publish scan conflict event');
    }

    if (conflict === 'card_inactive') {
      throw new AppError(400, 'This card has been deactivated.', 'CARD_INACTIVE');
    }

    throw new AppError(
      409,
      `Scan conflict: card is in "${card.currentStage}" stage (resolution: ${conflict})`,
      'SCAN_CONFLICT',
    );
  }

  let result: Awaited<ReturnType<typeof transitionCard>>;

  try {
    // Transition to triggered.
    // transitionCard handles idempotent replays before transition validation.
    result = await transitionCard({
      cardId,
      tenantId: card.tenantId,
      toStage: 'triggered',
      userId: scannedByUserId,
      method: 'qr_scan',
      notes: 'Triggered via QR code scan',
      idempotencyKey,
      metadata: {
        scanLocation: location,
        scanTimestamp: scannedAt ?? new Date().toISOString(),
      },
    });

    // Mark dedupe as completed with the transition result
    if (idempotencyKey && scanDedupeManager) {
      await scanDedupeManager.markCompleted(cardId, idempotencyKey, {
        cardId: result.card.id,
        loopType: card.loop.loopType,
        partId: card.loop.partId,
      });
    }
  } catch (err) {
    // Mark dedupe as failed so retries are possible
    if (idempotencyKey && scanDedupeManager) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      await scanDedupeManager.markFailed(cardId, idempotencyKey, errMsg);
    }

    if (
      err instanceof AppError
      && err.code === 'INVALID_TRANSITION'
      && card.currentStage !== 'created'
    ) {
      throw new AppError(
        400,
        `This card is already in the "${card.currentStage}" stage. It can only be scanned when in the "created" stage.`,
        'CARD_ALREADY_TRIGGERED'
      );
    }
    throw err;
  }

  // Determine which queue to add this to based on loop type
  const queueType = card.loop.loopType === 'procurement'
    ? 'Order Queue'
    : card.loop.loopType === 'production'
      ? 'Production Queue'
      : 'Transfer Queue';

  // Queue surfaces are derived from card stage state in the orders service.

  return {
    card: result.card,
    loopType: card.loop.loopType,
    partId: card.loop.partId,
    message: `Card triggered. Part added to ${queueType}.`,
  };
}

// ─── Scan Conflict Detection (pure function) ─────────────────────────
// Determines whether a scan should proceed based on the card's current
// stage and active status. Returns a resolution code.
export function detectScanConflict(
  currentStage: CardStage,
  isActive: boolean,
): ScanConflictResolution {
  if (!isActive) return 'card_inactive';
  if (currentStage === 'created') return 'ok';
  if (currentStage === 'triggered') return 'already_triggered';
  return 'stage_advanced';
}

// ─── Batch Replay for Offline Scans ──────────────────────────────────
// Processes an array of queued scans sequentially. Each scan is isolated:
// one failure does not block the rest.
export async function replayScans(
  items: ScanReplayItem[],
  tenantId: string,
  userId?: string,
): Promise<ScanReplayResult[]> {
  const results: ScanReplayResult[] = [];

  for (const item of items) {
    try {
      const triggerResult = await triggerCardByScan({
        cardId: item.cardId,
        scannedByUserId: userId,
        tenantId,
        location: item.location,
        idempotencyKey: item.idempotencyKey,
        scannedAt: item.scannedAt,
      });

      results.push({
        cardId: item.cardId,
        idempotencyKey: item.idempotencyKey,
        success: true,
        card: triggerResult.card,
        loopType: triggerResult.loopType,
        partId: triggerResult.partId,
        message: triggerResult.message,
        wasReplay: true,
      });
    } catch (err) {
      let errorCode = 'UNKNOWN_ERROR';
      let errorMessage = 'An unexpected error occurred';

      if (err instanceof ScanDuplicateError) {
        errorCode = 'SCAN_DUPLICATE';
        errorMessage = err.message;
      } else if (err instanceof AppError) {
        errorCode = err.code ?? 'APP_ERROR';
        errorMessage = err.message;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }

      results.push({
        cardId: item.cardId,
        idempotencyKey: item.idempotencyKey,
        success: false,
        error: errorMessage,
        errorCode,
        wasReplay: true,
      });
    }
  }

  return results;
}

// ─── Get Card History (All Transitions for a Card) ────────────────────
export async function getCardHistory(cardId: string, tenantId: string) {
  const transitions = await db.query.cardStageTransitions.findMany({
    where: and(
      eq(cardStageTransitions.cardId, cardId),
      eq(cardStageTransitions.tenantId, tenantId)
    ),
    orderBy: cardStageTransitions.transitionedAt,
  });

  return transitions;
}

// ─── Get Velocity Data for a Loop ─────────────────────────────────────
// Calculates average cycle times between each stage pair.
export async function getLoopVelocity(loopId: string, tenantId: string) {
  // Get all transitions for this loop, ordered by card and time
  const transitions = await db.query.cardStageTransitions.findMany({
    where: and(
      eq(cardStageTransitions.loopId, loopId),
      eq(cardStageTransitions.tenantId, tenantId)
    ),
    orderBy: [cardStageTransitions.cardId, cardStageTransitions.transitionedAt],
  });

  if (transitions.length < 2) {
    return { message: 'Insufficient data for velocity calculation', dataPoints: transitions.length };
  }

  // Group by cycle and calculate stage durations
  const cycleTimes: Record<string, number[]> = {};
  let prevTransition: typeof transitions[0] | null = null;

  for (const t of transitions) {
    if (prevTransition && prevTransition.cardId === t.cardId && prevTransition.cycleNumber === t.cycleNumber && t.fromStage) {
      const stageKey = `${t.fromStage}_to_${t.toStage}`;
      const durationHours =
        (t.transitionedAt.getTime() - prevTransition.transitionedAt.getTime()) / (1000 * 60 * 60);

      if (!cycleTimes[stageKey]) cycleTimes[stageKey] = [];
      cycleTimes[stageKey].push(durationHours);
    }
    prevTransition = t;
  }

  // Calculate averages
  const velocity: Record<string, { avgHours: number; count: number; minHours: number; maxHours: number }> = {};
  for (const [key, times] of Object.entries(cycleTimes)) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    velocity[key] = {
      avgHours: Math.round(avg * 100) / 100,
      count: times.length,
      minHours: Math.round(Math.min(...times) * 100) / 100,
      maxHours: Math.round(Math.max(...times) * 100) / 100,
    };
  }

  // Calculate total cycle time
  const fullCycleKey = 'full_cycle';
  const fullCycleTimes: number[] = [];
  // Group transitions by card+cycle and sum durations
  const cardCycles = new Map<string, { start?: Date; end?: Date }>();
  for (const t of transitions) {
    const key = `${t.cardId}-${t.cycleNumber}`;
    if (!cardCycles.has(key)) cardCycles.set(key, {});
    const cycle = cardCycles.get(key)!;
    if (t.toStage === 'triggered' && !cycle.start) cycle.start = t.transitionedAt;
    if (t.toStage === 'restocked') cycle.end = t.transitionedAt;
  }
  for (const cycle of cardCycles.values()) {
    if (cycle.start && cycle.end) {
      fullCycleTimes.push(
        (cycle.end.getTime() - cycle.start.getTime()) / (1000 * 60 * 60)
      );
    }
  }
  if (fullCycleTimes.length > 0) {
    const avg = fullCycleTimes.reduce((a, b) => a + b, 0) / fullCycleTimes.length;
    velocity[fullCycleKey] = {
      avgHours: Math.round(avg * 100) / 100,
      count: fullCycleTimes.length,
      minHours: Math.round(Math.min(...fullCycleTimes) * 100) / 100,
      maxHours: Math.round(Math.max(...fullCycleTimes) * 100) / 100,
    };
  }

  return {
    loopId,
    dataPoints: transitions.length,
    completedCycles: fullCycleTimes.length,
    stageDurations: velocity,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LIFECYCLE EVENT QUERIES
// ═══════════════════════════════════════════════════════════════════════

// ─── Get Card Lifecycle Events (Audit Trail) ─────────────────────────
// Returns all transition records for a card, enriched with stage duration.
export async function getCardLifecycleEvents(cardId: string, tenantId: string) {
  const transitions = await db.query.cardStageTransitions.findMany({
    where: and(
      eq(cardStageTransitions.cardId, cardId),
      eq(cardStageTransitions.tenantId, tenantId),
    ),
    orderBy: [asc(cardStageTransitions.transitionedAt)],
  });

  // Enrich with stage duration
  return transitions.map((t, i) => {
    const nextTransition = transitions[i + 1];
    const stageDurationSeconds = nextTransition
      ? Math.round((nextTransition.transitionedAt.getTime() - t.transitionedAt.getTime()) / 1000)
      : null;

    return {
      ...t,
      stageDurationSeconds,
      isCurrentStage: !nextTransition,
    };
  });
}

// ─── Get Loop Lifecycle Events ───────────────────────────────────────
// Returns all transitions for all cards in a loop, grouped by card.
export async function getLoopLifecycleEvents(
  loopId: string,
  tenantId: string,
  options?: { limit?: number; offset?: number }
) {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  const transitions = await db.query.cardStageTransitions.findMany({
    where: and(
      eq(cardStageTransitions.loopId, loopId),
      eq(cardStageTransitions.tenantId, tenantId),
    ),
    orderBy: [desc(cardStageTransitions.transitionedAt)],
    limit,
    offset,
  });

  return {
    events: transitions,
    pagination: { limit, offset, count: transitions.length },
  };
}
