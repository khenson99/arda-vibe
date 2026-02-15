import type { ArdaEvent } from '@arda/events';
import type { WSEvent, WSEventType } from '@arda/shared-types';

export type GatewayWSEvent = WSEvent<ArdaEvent>;

function getTimestamp(event: ArdaEvent): string {
  if ('timestamp' in event && typeof event.timestamp === 'string') {
    return event.timestamp;
  }
  return new Date().toISOString();
}

function getTenantId(event: ArdaEvent): string | null {
  if ('tenantId' in event && typeof event.tenantId === 'string' && event.tenantId.length > 0) {
    return event.tenantId;
  }
  return null;
}

export function mapBackendEventToWSEventType(event: ArdaEvent): WSEventType | null {
  switch (event.type) {
    case 'card.transition':
      return event.toStage === 'triggered' ? 'card:triggered' : 'card:stage_changed';
    case 'lifecycle.transition':
      return event.toStage === 'triggered' ? 'card:triggered' : 'card:stage_changed';
    case 'order.created':
    case 'order.status_changed':
      if (event.orderType === 'purchase_order') return 'po:status_changed';
      if (event.orderType === 'work_order') return 'wo:status_changed';
      if (event.orderType === 'transfer_order') return 'transfer:status_changed';
      return null;
    case 'production.step_completed':
      return 'wo:step_completed';
    case 'production.quantity_reported':
      return 'wo:quantity_reported';
    case 'production.expedite':
      return 'wo:expedited';
    case 'production.hold':
      return 'wo:held';
    case 'production.resume':
      return 'wo:resumed';
    case 'receiving.completed':
      return 'receiving:completed';
    case 'receiving.exception_created':
      return 'receiving:exception_created';
    case 'receiving.exception_resolved':
      return 'receiving:exception_resolved';
    case 'automation.po_created':
      return 'automation:po_created';
    case 'automation.to_created':
      return 'automation:to_created';
    case 'automation.email_dispatched':
      return 'automation:email_dispatched';
    case 'automation.shopping_list_item_added':
      return 'automation:shopping_list_item_added';
    case 'automation.card_stage_changed':
      return 'automation:card_stage_changed';
    case 'automation.escalated':
      return 'automation:escalated';
    case 'notification.created':
      return 'notification:new';
    case 'relowisa.recommendation':
      return 'relowisa:recommendation';
    case 'inventory:updated':
      return 'inventory:updated';
    case 'kpi.refreshed':
      return 'kpi:refreshed';
    case 'audit.created':
      return 'audit:created';
    case 'user.activity':
      return 'user:activity';
    case 'loop.parameters_changed':
    case 'queue.risk_detected':
    case 'lifecycle.transition_rejected':
    case 'lifecycle.cycle_complete':
    case 'lifecycle.queue_entry':
    case 'lifecycle.order_linked':
    case 'production.split':
    case 'production.rework':
    case 'scan.conflict_detected':
    case 'order.email_draft_created':
    case 'order.email_sent':
    case 'security.auth.login':
    case 'security.auth.login_failed':
    case 'security.auth.logout':
    case 'security.token.refresh':
    case 'security.token.replay_detected':
    case 'security.token.revoked':
    case 'security.authorization.denied':
    case 'security.tenant.context_violation':
    case 'order.issue_created':
    case 'order.issue_status_changed':
      return null;
  }
}

export function mapBackendEventToWSEvent(event: ArdaEvent): GatewayWSEvent | null {
  const wsType = mapBackendEventToWSEventType(event);
  if (!wsType) return null;

  const tenantId = getTenantId(event);
  if (!tenantId) return null;

  return {
    type: wsType,
    tenantId,
    payload: event,
    timestamp: getTimestamp(event),
  };
}
