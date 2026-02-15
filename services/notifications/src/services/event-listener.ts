import { getEventBus, type ArdaEvent } from '@arda/events';
import { db, schema } from '@arda/db';
import { and, eq } from 'drizzle-orm';
import { dispatchNotificationChannels, type DispatchContext } from './channel-dispatch.js';

type OrderStatusChangedEvent = Extract<ArdaEvent, { type: 'order.status_changed' }>;
type CardTransitionNotificationEvent =
  | Extract<ArdaEvent, { type: 'card.transition' }>
  | Extract<ArdaEvent, { type: 'lifecycle.transition' }>;

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function formatExceptionType(type: string): string {
  const labels: Record<string, string> = {
    short_shipment: 'Short Shipment',
    damaged: 'Damaged Goods',
    quality_reject: 'Quality Rejection',
    wrong_item: 'Wrong Item',
    overage: 'Overage',
  };
  return labels[type] || formatStatus(type);
}

function formatResolutionType(type: string): string {
  const labels: Record<string, string> = {
    follow_up_po: 'Follow-up Purchase Order',
    replacement_card: 'Kanban Card Replacement',
    return_to_supplier: 'Return to Supplier',
    credit: 'Supplier Credit',
    accept_as_is: 'Accept As Is',
  };
  return labels[type] || formatStatus(type);
}

function shouldNotifyCardStage(toStage: string): boolean {
  return ['triggered', 'received', 'restocked'].includes(toStage);
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

export async function startEventListener(
  redisUrl: string,
  dispatchCtx?: DispatchContext,
): Promise<void> {
  const eventBus = getEventBus(redisUrl);

  await eventBus.subscribeGlobal(async (event: ArdaEvent) => {
    try {
      switch (event.type) {
        case 'card.transition':
        case 'lifecycle.transition':
          // Create notification for relevant users when cards move to key stages
          if (shouldNotifyCardStage(event.toStage)) {
            const transitionEvent = event as CardTransitionNotificationEvent;
            await createNotification(eventBus, dispatchCtx, {
              tenantId: transitionEvent.tenantId,
              type: 'card_triggered',
              title: `Kanban card moved to ${transitionEvent.toStage}`,
              body: `Card ${transitionEvent.cardId} transitioned from ${transitionEvent.fromStage || 'initial'} to ${transitionEvent.toStage}`,
              actionUrl: `/loops/${transitionEvent.loopId}/cards/${transitionEvent.cardId}`,
              metadata: {
                cardId: transitionEvent.cardId,
                loopId: transitionEvent.loopId,
                stage: transitionEvent.toStage,
                eventType: transitionEvent.type,
              },
            });
          }
          break;

        case 'order.created':
          await createNotification(eventBus, dispatchCtx, {
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
          await createNotification(eventBus, dispatchCtx, {
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
          await createNotification(eventBus, dispatchCtx, {
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
          await createNotification(eventBus, dispatchCtx, {
            tenantId: event.tenantId,
            type: 'relowisa_recommendation',
            title: 'New ReLoWiSa recommendation',
            body: `Parameter optimization suggested for loop ${event.loopId} (confidence: ${event.confidenceScore}%)`,
            actionUrl: `/loops/${event.loopId}/recommendations/${event.recommendationId}`,
            metadata: { loopId: event.loopId, recommendationId: event.recommendationId },
          });
          break;

        case 'loop.parameters_changed':
          await createNotification(eventBus, dispatchCtx, {
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

        case 'receiving.completed': {
          const hasExceptions = event.exceptionsCreated > 0;
          await createNotification(eventBus, dispatchCtx, {
            tenantId: event.tenantId,
            type: 'receiving_completed',
            title: hasExceptions
              ? `Receiving completed with ${event.exceptionsCreated} exception(s)`
              : 'Receiving completed successfully',
            body: `Receipt ${event.receiptNumber}: ${event.totalAccepted} accepted, ${event.totalDamaged} damaged, ${event.totalRejected} rejected.${hasExceptions ? ` ${event.exceptionsCreated} exception(s) created.` : ''}`,
            actionUrl: `/receiving/${event.receiptId}`,
            metadata: {
              receiptId: event.receiptId,
              receiptNumber: event.receiptNumber,
              orderId: event.orderId,
              orderType: event.orderType,
              status: event.status,
              totalAccepted: event.totalAccepted,
              totalDamaged: event.totalDamaged,
              totalRejected: event.totalRejected,
              exceptionsCreated: event.exceptionsCreated,
            },
          });
          break;
        }

        case 'receiving.exception_created':
          await createNotification(eventBus, dispatchCtx, {
            tenantId: event.tenantId,
            type: 'exception_alert',
            title: `${formatExceptionType(event.exceptionType)} — ${event.severity} severity`,
            body: `${formatExceptionType(event.exceptionType)}: ${event.quantityAffected} units affected on receipt ${event.receiptId.slice(0, 8)}...`,
            actionUrl: `/receiving/exceptions/${event.exceptionId}`,
            metadata: {
              exceptionId: event.exceptionId,
              receiptId: event.receiptId,
              exceptionType: event.exceptionType,
              severity: event.severity,
              quantityAffected: event.quantityAffected,
              orderId: event.orderId,
              orderType: event.orderType,
            },
          });
          break;

        case 'receiving.exception_resolved':
          await createNotification(eventBus, dispatchCtx, {
            tenantId: event.tenantId,
            type: 'system_alert',
            title: `Exception resolved — ${formatResolutionType(event.resolutionType)}`,
            body: `${formatExceptionType(event.exceptionType)} exception resolved via ${formatResolutionType(event.resolutionType)}${event.followUpOrderId ? ' (follow-up order created)' : ''}`,
            actionUrl: `/receiving/exceptions/${event.exceptionId}`,
            metadata: {
              exceptionId: event.exceptionId,
              receiptId: event.receiptId,
              exceptionType: event.exceptionType,
              resolutionType: event.resolutionType,
              followUpOrderId: event.followUpOrderId,
            },
          });
          break;

        case 'production.hold':
          await createNotification(eventBus, dispatchCtx, {
            tenantId: event.tenantId,
            type: 'production_hold',
            title: 'Work order placed on hold',
            body: `${event.workOrderNumber} has been placed on hold: ${event.holdReason}${event.holdNotes ? ` — ${event.holdNotes}` : ''}`,
            actionUrl: `/work-orders/${event.workOrderId}`,
            metadata: {
              workOrderId: event.workOrderId,
              workOrderNumber: event.workOrderNumber,
              holdReason: event.holdReason,
              holdNotes: event.holdNotes,
              userId: event.userId,
            },
          });
          break;

        case 'automation.escalated':
          await createNotification(eventBus, dispatchCtx, {
            tenantId: event.tenantId,
            type: 'automation_escalated',
            title: 'Automation escalation',
            body: `Automated action requires attention: ${event.reason}`,
            actionUrl: event.entityType && event.entityId
              ? `/${event.entityType}s/${event.entityId}`
              : '/queue',
            metadata: {
              reason: event.reason,
              entityType: event.entityType,
              entityId: event.entityId,
              source: event.source,
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
  dispatchCtx: DispatchContext | undefined,
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

      // Dispatch to email/webhook channels (non-blocking on errors)
      if (dispatchCtx) {
        try {
          await dispatchNotificationChannels(
            {
              notificationId: notification.id,
              tenantId: params.tenantId,
              userId: notification.userId,
              type: notification.type,
              title: notification.title,
              body: params.body,
              actionUrl: params.actionUrl,
              metadata: params.metadata,
            },
            dispatchCtx,
          );
        } catch (dispatchErr) {
          console.error(
            `[notifications] Channel dispatch failed for ${notification.id}:`,
            dispatchErr,
          );
        }
      }
    })
  );
}
