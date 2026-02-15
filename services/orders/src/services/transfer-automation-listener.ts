/**
 * Transfer Automation Event Listener
 *
 * Thin adapter that subscribes to global events from the EventBus and
 * delegates transfer-order creation to the existing autoCreateTransferOrder
 * service when a lifecycle.queue_entry event with loopType='transfer' arrives.
 *
 * Designed to be started once at service boot and stopped on graceful shutdown.
 */

import { createLogger } from '@arda/config';
import { type EventBus, type ArdaEvent, type LifecycleQueueEntryEvent } from '@arda/events';
import { autoCreateTransferOrder } from './kanban-transfer-automation.service.js';

const log = createLogger('orders:transfer-automation-listener');

export interface TransferAutomationListener {
  stop: () => Promise<void>;
}

/**
 * Start listening for lifecycle.queue_entry events and auto-create
 * transfer orders for transfer-type loops.
 */
export async function startTransferAutomationListener(
  eventBus: EventBus,
): Promise<TransferAutomationListener> {
  const handler = async (event: ArdaEvent) => {
    if (event.type !== 'lifecycle.queue_entry') return;

    const queueEvent = event as LifecycleQueueEntryEvent;
    if (queueEvent.loopType !== 'transfer') return;

    log.info(
      { cardId: queueEvent.cardId, loopId: queueEvent.loopId, tenantId: queueEvent.tenantId },
      'Processing transfer queue entry',
    );

    try {
      const result = await autoCreateTransferOrder({
        tenantId: queueEvent.tenantId,
        cardId: queueEvent.cardId,
        // System-initiated — no userId
      });

      log.info(
        { transferOrderId: result.transferOrderId, toNumber: result.toNumber, cardId: result.cardId },
        'Transfer order auto-created from event',
      );
    } catch (err) {
      // Log but don't crash the listener — the event will be retried
      // if the card is still in 'triggered' stage (idempotent).
      log.error(
        { err, cardId: queueEvent.cardId, loopId: queueEvent.loopId },
        'Failed to auto-create transfer order from event',
      );
    }
  };

  await eventBus.subscribeGlobal(handler);

  log.info('Transfer automation listener started');

  return {
    stop: async () => {
      // EventBus.shutdown() handles full cleanup; individual handler
      // removal is not needed since shutdown clears all handlers.
      log.info('Transfer automation listener stopped');
    },
  };
}
