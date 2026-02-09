import { getEventBus, type ArdaEvent } from '@arda/events';
import { db, schema } from '@arda/db';
import { and, eq } from 'drizzle-orm';

type OrderStatusChangedEvent = Extract<ArdaEvent, { type: 'order.status_changed' }>;

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function buildOrderStatusNotification(event: OrderStatusChangedEvent): {
  type: string;
  title: string;
  body: string;
} {
  const transitionBody = `${event.orderNumber} moved from ${formatStatus(event.fromStatus)} to ${formatStatus(event.toStatus)}.`;

  if (event.orderType === 'purchase_order') {
    if (event.toStatus === 'cancelled') {
      return {
        type: 'exception_alert',
        title: 'Purchase order cancelled',
        body: transitionBody,
      };
    }

    if (event.toStatus === 'sent') {
      return {
        type: 'po_sent',
        title: 'Purchase order sent',
        body: `${event.orderNumber} was sent to the supplier.`,
      };
    }

    if (event.toStatus === 'received' || event.toStatus === 'partially_received') {
      return {
        type: 'po_received',
        title:
          event.toStatus === 'received'
            ? 'Purchase order received'
            : 'Purchase order partially received',
        body: transitionBody,
      };
    }

    return {
      type: 'system_alert',
      title: 'Purchase order status updated',
      body: transitionBody,
    };
  }

  if (event.orderType === 'work_order') {
    if (event.toStatus === 'on_hold' || event.toStatus === 'cancelled') {
      return {
        type: 'exception_alert',
        title: 'Work order requires attention',
        body: transitionBody,
      };
    }

    return {
      type: 'wo_status_change',
      title: 'Work order status updated',
      body: transitionBody,
    };
  }

  if (event.toStatus === 'cancelled') {
    return {
      type: 'exception_alert',
      title: 'Transfer order cancelled',
      body: transitionBody,
    };
  }

  return {
    type: 'transfer_status_change',
    title: 'Transfer order status updated',
    body: transitionBody,
  };
}

export async function startEventListener(redisUrl: string): Promise<void> {
  const eventBus = getEventBus(redisUrl);

  await eventBus.subscribeGlobal(async (event: ArdaEvent) => {
    try {
      switch (event.type) {
        case 'card.transition':
          // Create notification for relevant users when cards move to key stages
          if (['triggered', 'received', 'restocked'].includes(event.toStage)) {
            await createNotification(eventBus, {
              tenantId: event.tenantId,
              type: 'card_triggered',
              title: `Kanban card moved to ${event.toStage}`,
              body: `Card ${event.cardId} transitioned from ${event.fromStage || 'initial'} to ${event.toStage}`,
              actionUrl: `/loops/${event.loopId}/cards/${event.cardId}`,
              metadata: { cardId: event.cardId, loopId: event.loopId, stage: event.toStage },
            });
          }
          break;

        case 'order.created':
          await createNotification(eventBus, {
            tenantId: event.tenantId,
            type: 'po_created',
            title: `New ${event.orderType.replace('_', ' ')} created`,
            body: `${event.orderNumber} has been created with ${event.linkedCardIds.length} linked card(s)`,
            actionUrl: `/orders/${event.orderId}`,
            metadata: {
              orderId: event.orderId,
              orderNumber: event.orderNumber,
              orderType: event.orderType,
            },
          });
          break;

        case 'order.status_changed': {
          const notification = buildOrderStatusNotification(event);
          await createNotification(eventBus, {
            tenantId: event.tenantId,
            type: notification.type,
            title: notification.title,
            body: notification.body,
            actionUrl: `/orders/${event.orderId}`,
            metadata: {
              orderId: event.orderId,
              orderNumber: event.orderNumber,
              orderType: event.orderType,
              fromStatus: event.fromStatus,
              toStatus: event.toStatus,
            },
          });
          break;
        }

        case 'queue.risk_detected':
          await createNotification(eventBus, {
            tenantId: event.tenantId,
            type: 'stockout_warning',
            title:
              event.riskLevel === 'high'
                ? 'High stockout risk detected'
                : 'Stockout risk detected',
            body: `${event.queueType.replace('_', ' ')} queue risk for card ${event.cardId}: ${event.reason}`,
            actionUrl: `/queue?loopType=${event.queueType}`,
            metadata: {
              queueType: event.queueType,
              cardId: event.cardId,
              loopId: event.loopId,
              partId: event.partId,
              facilityId: event.facilityId,
              riskLevel: event.riskLevel,
              triggeredAgeHours: event.triggeredAgeHours,
              estimatedDaysOfSupply: event.estimatedDaysOfSupply,
            },
          });
          break;

        case 'relowisa.recommendation':
          await createNotification(eventBus, {
            tenantId: event.tenantId,
            type: 'relowisa_recommendation',
            title: 'New ReLoWiSa recommendation',
            body: `Parameter optimization suggested for loop ${event.loopId} (confidence: ${event.confidenceScore}%)`,
            actionUrl: `/loops/${event.loopId}/recommendations/${event.recommendationId}`,
            metadata: { loopId: event.loopId, recommendationId: event.recommendationId },
          });
          break;

        case 'loop.parameters_changed':
          await createNotification(eventBus, {
            tenantId: event.tenantId,
            type: 'system_alert',
            title: 'Kanban parameters updated',
            body: `Loop ${event.loopId} parameters changed (${event.changeType}): ${event.reason}`,
            actionUrl: `/loops/${event.loopId}`,
            metadata: {
              loopId: event.loopId,
              changeType: event.changeType,
              reason: event.reason,
            },
          });
          break;
      }
    } catch (err) {
      console.error('[notifications] Failed to process event:', err);
    }
  });

  console.log('[notifications] Event listener started');
}

async function createNotification(
  eventBus: ReturnType<typeof getEventBus>,
  params: {
    tenantId: string;
    userId?: string;
    type: string;
    title: string;
    body: string;
    actionUrl?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const targetUserIds = params.userId
    ? [params.userId]
    : (
        await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.tenantId, params.tenantId), eq(schema.users.isActive, true)))
      ).map((row) => row.id);

  if (targetUserIds.length === 0) {
    return;
  }

  const insertedNotifications = await db
    .insert(schema.notifications)
    .values(
      targetUserIds.map((userId) => ({
        tenantId: params.tenantId,
        userId,
        type: params.type as (typeof schema.notificationTypeEnum.enumValues)[number],
        title: params.title,
        body: params.body,
        actionUrl: params.actionUrl,
        isRead: false,
        metadata: params.metadata || {},
        createdAt: new Date(),
      }))
    )
    .returning({
      id: schema.notifications.id,
      userId: schema.notifications.userId,
      type: schema.notifications.type,
      title: schema.notifications.title,
    });

  await Promise.all(
    insertedNotifications.map(async (notification) => {
      try {
        await eventBus.publish({
          type: 'notification.created',
          tenantId: params.tenantId,
          userId: notification.userId,
          notificationId: notification.id,
          notificationType: notification.type,
          title: notification.title,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(
          `[notifications] Failed to publish notification.created event for ${notification.id}`
        );
      }
    })
  );
}
