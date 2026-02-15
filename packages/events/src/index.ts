import Redis from 'ioredis';
import { createLogger } from '@arda/config';

const log = createLogger('event-bus');

// ─── Event Envelope (Protocol v2) ───────────────────────────────────
export interface EventMeta {
  id: string;
  schemaVersion: number;
  source: string;
  correlationId?: string;
  timestamp: string;
  replayed?: boolean;
}

export interface EventEnvelope<T extends ArdaEvent = ArdaEvent> {
  id: string;
  schemaVersion: number;
  source: string;
  correlationId?: string;
  timestamp: string;
  replayed?: boolean;
  event: T;
}

// ─── Event Types ────────────────────────────────────────────────────
export interface CardTransitionEvent {
  type: 'card.transition';
  tenantId: string;
  cardId: string;
  loopId: string;
  fromStage: string | null;
  toStage: string;
  method: string;
  userId?: string;
  timestamp: string;
}

export interface OrderCreatedEvent {
  type: 'order.created';
  tenantId: string;
  orderType: 'purchase_order' | 'work_order' | 'transfer_order';
  orderId: string;
  orderNumber: string;
  linkedCardIds: string[];
  timestamp: string;
}

export interface OrderStatusChangedEvent {
  type: 'order.status_changed';
  tenantId: string;
  orderType: 'purchase_order' | 'work_order' | 'transfer_order';
  orderId: string;
  orderNumber: string;
  fromStatus: string;
  toStatus: string;
  timestamp: string;
}

export interface LoopParameterChangedEvent {
  type: 'loop.parameters_changed';
  tenantId: string;
  loopId: string;
  changeType: string;
  reason: string;
  timestamp: string;
}

export interface ReloWisaRecommendationEvent {
  type: 'relowisa.recommendation';
  tenantId: string;
  loopId: string;
  recommendationId: string;
  confidenceScore: number;
  timestamp: string;
}

export interface QueueRiskDetectedEvent {
  type: 'queue.risk_detected';
  tenantId: string;
  queueType: 'procurement' | 'production' | 'transfer';
  loopId: string;
  cardId: string;
  partId: string;
  facilityId: string;
  riskLevel: 'medium' | 'high';
  triggeredAgeHours: number;
  estimatedDaysOfSupply: number | null;
  reason: string;
  timestamp: string;
}

export interface NotificationEvent {
  type: 'notification.created';
  tenantId: string;
  userId: string;
  notificationId: string;
  notificationType: string;
  title: string;
  timestamp: string;
}

// ─── Realtime Analytics / Audit / Activity Events ───────────────────
export interface KpiRefreshedEvent {
  type: 'kpi.refreshed';
  tenantId: string;
  kpiKey: string;
  window: '30d' | '60d' | '90d' | 'custom';
  facilityId?: string;
  value: number;
  previousValue?: number;
  deltaPercent?: number;
  refreshedAt: string;
  timestamp: string;
}

export interface AuditCreatedEvent {
  type: 'audit.created';
  tenantId: string;
  auditId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId?: string | null;
  method?: 'manual' | 'system' | 'scan' | 'api';
  timestamp: string;
}

export interface UserActivityEvent {
  type: 'user.activity';
  tenantId: string;
  userId: string;
  activityType: 'login' | 'logout' | 'page_view' | 'command' | 'mutation' | 'websocket_subscribe';
  route?: string;
  resourceType?: string;
  resourceId?: string;
  sessionId?: string;
  correlationId?: string;
  timestamp: string;
}

// ─── Lifecycle Domain Events ──────────────────────────────────────────
export interface LifecycleTransitionEvent {
  type: 'lifecycle.transition';
  tenantId: string;
  cardId: string;
  loopId: string;
  fromStage: string | null;
  toStage: string;
  cycleNumber: number;
  method: string;
  actorRole?: string;
  userId?: string;
  quantity?: number;
  stageDurationSeconds?: number;
  idempotencyKey?: string;
  eventId: string;
  timestamp: string;
}

export interface LifecycleTransitionRejectedEvent {
  type: 'lifecycle.transition_rejected';
  tenantId: string;
  cardId: string;
  loopId: string;
  attemptedFromStage: string;
  attemptedToStage: string;
  reason: string;
  errorCode: string;
  userId?: string;
  actorRole?: string;
  timestamp: string;
}

export interface LifecycleCycleCompleteEvent {
  type: 'lifecycle.cycle_complete';
  tenantId: string;
  cardId: string;
  loopId: string;
  cycleNumber: number;
  totalCycleDurationSeconds: number;
  timestamp: string;
}

export interface LifecycleQueueEntryEvent {
  type: 'lifecycle.queue_entry';
  tenantId: string;
  cardId: string;
  loopId: string;
  loopType: 'procurement' | 'production' | 'transfer';
  partId: string;
  facilityId: string;
  quantity: number;
  timestamp: string;
}

export interface LifecycleOrderLinkedEvent {
  type: 'lifecycle.order_linked';
  tenantId: string;
  cardId: string;
  loopId: string;
  orderId: string;
  orderType: 'purchase_order' | 'work_order' | 'transfer_order';
  timestamp: string;
}

// ─── Receiving Events ────────────────────────────────────────────────
export interface ReceivingCompletedEvent {
  type: 'receiving.completed';
  tenantId: string;
  receiptId: string;
  receiptNumber: string;
  orderType: 'purchase_order' | 'transfer_order' | 'work_order';
  orderId: string;
  status: string;
  totalAccepted: number;
  totalDamaged: number;
  totalRejected: number;
  exceptionsCreated: number;
  timestamp: string;
}

export interface ReceivingExceptionCreatedEvent {
  type: 'receiving.exception_created';
  tenantId: string;
  exceptionId: string;
  receiptId: string;
  exceptionType: string;
  severity: string;
  quantityAffected: number;
  orderId: string;
  orderType: string;
  timestamp: string;
}

export interface ReceivingExceptionResolvedEvent {
  type: 'receiving.exception_resolved';
  tenantId: string;
  exceptionId: string;
  receiptId: string;
  exceptionType: string;
  resolutionType: string;
  resolvedByUserId?: string;
  followUpOrderId?: string;
  timestamp: string;
}

// ─── Production Events ──────────────────────────────────────────────
export interface ProductionStepCompletedEvent {
  type: 'production.step_completed';
  tenantId: string;
  workOrderId: string;
  workOrderNumber: string;
  stepNumber: number;
  operationName: string;
  workCenterId: string;
  actualMinutes: number;
  status: 'complete' | 'skipped';
  timestamp: string;
}

export interface ProductionQuantityReportedEvent {
  type: 'production.quantity_reported';
  tenantId: string;
  workOrderId: string;
  workOrderNumber: string;
  quantityProduced: number;
  quantityRejected: number;
  quantityScrapped: number;
  timestamp: string;
}

export interface ProductionHoldEvent {
  type: 'production.hold';
  tenantId: string;
  workOrderId: string;
  workOrderNumber: string;
  holdReason: string;
  holdNotes?: string;
  userId?: string;
  timestamp: string;
}

export interface ProductionResumeEvent {
  type: 'production.resume';
  tenantId: string;
  workOrderId: string;
  workOrderNumber: string;
  userId?: string;
  timestamp: string;
}

export interface ProductionExpediteEvent {
  type: 'production.expedite';
  tenantId: string;
  workOrderId: string;
  workOrderNumber: string;
  previousPriority: number;
  userId?: string;
  timestamp: string;
}

export interface ProductionSplitEvent {
  type: 'production.split';
  tenantId: string;
  parentWorkOrderId: string;
  childWorkOrderId: string;
  parentQuantity: number;
  childQuantity: number;
  timestamp: string;
}

export interface ProductionReworkEvent {
  type: 'production.rework';
  tenantId: string;
  originalWorkOrderId: string;
  reworkWorkOrderId: string;
  reworkQuantity: number;
  timestamp: string;
}

// ─── Automation Events ──────────────────────────────────────────────
export interface AutomationPOCreatedEvent {
  type: 'automation.po_created';
  tenantId: string;
  purchaseOrderId: string;
  poNumber: string;
  source: 'automation';
  timestamp: string;
}

export interface AutomationTOCreatedEvent {
  type: 'automation.to_created';
  tenantId: string;
  transferOrderId: string;
  toNumber: string;
  source: 'automation';
  timestamp: string;
}

export interface AutomationEmailDispatchedEvent {
  type: 'automation.email_dispatched';
  tenantId: string;
  purchaseOrderId: string;
  supplierId: string;
  supplierEmail: string;
  totalAmount: number;
  source: 'automation';
  timestamp: string;
}

export interface AutomationShoppingListItemAddedEvent {
  type: 'automation.shopping_list_item_added';
  tenantId: string;
  partId: string;
  quantity: number;
  source: 'automation';
  timestamp: string;
}

export interface AutomationCardStageChangedEvent {
  type: 'automation.card_stage_changed';
  tenantId: string;
  cardId: string;
  loopId: string;
  fromStage: string;
  toStage: string;
  cycleNumber: number;
  source: 'automation';
  timestamp: string;
}

export interface AutomationEscalatedEvent {
  type: 'automation.escalated';
  tenantId: string;
  reason: string;
  entityType?: string;
  entityId?: string;
  source: 'automation';
  timestamp: string;
}

// ─── Inventory Events ──────────────────────────────────────────────

export interface InventoryUpdatedEvent {
  type: 'inventory:updated';
  tenantId: string;
  facilityId: string;
  partId: string;
  field: 'qtyOnHand' | 'qtyReserved' | 'qtyInTransit';
  adjustmentType: 'set' | 'increment' | 'decrement';
  quantity: number;
  previousValue: number;
  newValue: number;
  /** Present when the adjustment comes from a cycle count. */
  variance?: number;
  /** Source of the adjustment (e.g. 'cycle_count'). */
  source?: string;
  timestamp: string;
}

// ─── Scan Conflict Events ─────────────────────────────────────────
export interface ScanConflictDetectedEvent {
  type: 'scan.conflict_detected';
  tenantId: string;
  payload: {
    cardId: string;
    scannedByUserId?: string;
    currentStage: string;
    resolution: string;
    idempotencyKey?: string;
    scannedAt?: string;
    timestamp: string;
  };
}

// Re-export security events
export {
  type SecurityEvent,
  type AuthLoginEvent,
  type AuthLoginFailedEvent,
  type AuthLogoutEvent,
  type TokenRefreshEvent,
  type TokenReplayDetectedEvent,
  type TokenRevokedEvent,
  type AuthorizationDeniedEvent,
  type TenantContextViolationEvent,
  SecurityEventType,
  isSecurityEvent,
} from './security-events.js';

import type { SecurityEvent } from './security-events.js';

export type ArdaEvent =
  | CardTransitionEvent
  | OrderCreatedEvent
  | OrderStatusChangedEvent
  | LoopParameterChangedEvent
  | ReloWisaRecommendationEvent
  | QueueRiskDetectedEvent
  | NotificationEvent
  | KpiRefreshedEvent
  | AuditCreatedEvent
  | UserActivityEvent
  | SecurityEvent
  | LifecycleTransitionEvent
  | LifecycleTransitionRejectedEvent
  | LifecycleCycleCompleteEvent
  | LifecycleQueueEntryEvent
  | LifecycleOrderLinkedEvent
  | ReceivingCompletedEvent
  | ReceivingExceptionCreatedEvent
  | ReceivingExceptionResolvedEvent
  | ProductionStepCompletedEvent
  | ProductionQuantityReportedEvent
  | ProductionHoldEvent
  | ProductionResumeEvent
  | ProductionExpediteEvent
  | ProductionSplitEvent
  | ProductionReworkEvent
  | AutomationPOCreatedEvent
  | AutomationTOCreatedEvent
  | AutomationEmailDispatchedEvent
  | AutomationShoppingListItemAddedEvent
  | AutomationCardStageChangedEvent
  | AutomationEscalatedEvent
  | InventoryUpdatedEvent
  | ScanConflictDetectedEvent;

// ─── Event Channel Names ────────────────────────────────────────────
const CHANNEL_PREFIX = 'arda:events';

export function getTenantChannel(tenantId: string): string {
  return `${CHANNEL_PREFIX}:${tenantId}`;
}

export function getGlobalChannel(): string {
  return `${CHANNEL_PREFIX}:global`;
}

function hasTenantScope(event: ArdaEvent): event is ArdaEvent & { tenantId: string } {
  return 'tenantId' in event && typeof event.tenantId === 'string' && event.tenantId.length > 0;
}

// ─── Event Bus (Redis Pub/Sub) ──────────────────────────────────────
export class EventBus {
  private publisher: Redis;
  private subscriber: Redis;
  private handlers: Map<string, Set<(event: ArdaEvent) => void>> = new Map();

  constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl);
    this.subscriber = new Redis(redisUrl);

    this.subscriber.on('message', (channel, message) => {
      try {
        const event = JSON.parse(message) as ArdaEvent;
        const channelHandlers = this.handlers.get(channel);
        if (channelHandlers) {
          for (const handler of channelHandlers) {
            handler(event);
          }
        }
      } catch (err) {
        log.error({ err }, 'Failed to parse event');
      }
    });
  }

  /** Publish an event to a tenant's channel */
  async publish(event: ArdaEvent): Promise<void> {
    const message = JSON.stringify(event);

    const publishOps: Array<Promise<number>> = [this.publisher.publish(getGlobalChannel(), message)];

    if (hasTenantScope(event)) {
      publishOps.push(this.publisher.publish(getTenantChannel(event.tenantId), message));
    }

    await Promise.all(publishOps);
  }

  /** Subscribe to events for a specific tenant */
  async subscribeTenant(
    tenantId: string,
    handler: (event: ArdaEvent) => void
  ): Promise<void> {
    const channel = getTenantChannel(tenantId);
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      await this.subscriber.subscribe(channel);
    }
    this.handlers.get(channel)!.add(handler);
  }

  /** Subscribe to all events globally */
  async subscribeGlobal(handler: (event: ArdaEvent) => void): Promise<void> {
    const channel = getGlobalChannel();
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      await this.subscriber.subscribe(channel);
    }
    this.handlers.get(channel)!.add(handler);
  }

  /** Unsubscribe from a tenant's events */
  async unsubscribeTenant(
    tenantId: string,
    handler: (event: ArdaEvent) => void
  ): Promise<void> {
    const channel = getTenantChannel(tenantId);
    const channelHandlers = this.handlers.get(channel);
    if (channelHandlers) {
      channelHandlers.delete(handler);
      if (channelHandlers.size === 0) {
        this.handlers.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    }
  }

  /** Health check — verify Redis connectivity */
  async ping(): Promise<boolean> {
    try {
      const result = await this.publisher.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /** Clean shutdown */
  async shutdown(): Promise<void> {
    await this.subscriber.unsubscribe();
    await this.publisher.quit();
    await this.subscriber.quit();
    this.handlers.clear();
  }
}

// ─── Singleton factory ──────────────────────────────────────────────
let eventBusInstance: EventBus | null = null;

export function getEventBus(redisUrl?: string): EventBus {
  if (!eventBusInstance) {
    if (!redisUrl) {
      throw new Error('Redis URL is required to initialize EventBus');
    }
    eventBusInstance = new EventBus(redisUrl);
  }
  return eventBusInstance;
}
