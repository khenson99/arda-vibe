import Redis from 'ioredis';
import { createLogger } from '@arda/config';

const log = createLogger('event-bus');

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

export type ArdaEvent =
  | CardTransitionEvent
  | OrderCreatedEvent
  | OrderStatusChangedEvent
  | LoopParameterChangedEvent
  | ReloWisaRecommendationEvent
  | QueueRiskDetectedEvent
  | NotificationEvent;

// ─── Event Channel Names ────────────────────────────────────────────
const CHANNEL_PREFIX = 'arda:events';

export function getTenantChannel(tenantId: string): string {
  return `${CHANNEL_PREFIX}:${tenantId}`;
}

export function getGlobalChannel(): string {
  return `${CHANNEL_PREFIX}:global`;
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
    const tenantId = event.tenantId;
    const channel = getTenantChannel(tenantId);
    const message = JSON.stringify(event);

    await Promise.all([
      this.publisher.publish(channel, message),
      this.publisher.publish(getGlobalChannel(), message),
    ]);
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
