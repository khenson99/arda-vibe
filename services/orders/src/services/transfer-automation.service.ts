/**
 * Transfer Order Automation Service
 *
 * Listens to lifecycle.queue_entry events for transfer-type loops and
 * automatically creates draft transfer orders, linking them to the triggering card.
 *
 * Key features:
 *   - Duplicate prevention: checks for existing linkedTransferOrderId
 *   - Automatic card transition: triggered -> ordered
 *   - Event publishing: automation.to_created
 *   - Audit trail: full transaction logging
 */

import { db, schema, writeAuditEntry } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import { getEventBus } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { getNextTONumber } from './order-number.service.js';
import { transitionTriggeredCardToOrdered } from './card-lifecycle.service.js';
import type { LifecycleQueueEntryEvent } from '@arda/events';

const log = createLogger('transfer-automation');

const {
  transferOrders,
  transferOrderLines,
  kanbanCards,
  kanbanLoops,
} = schema;

export interface TransferAutomationResult {
  success: boolean;
  transferOrderId?: string;
  toNumber?: string;
  alreadyExisted?: boolean;
  error?: string;
}

/**
 * Process a lifecycle.queue_entry event for transfer loops.
 * Creates a draft transfer order if the card doesn't already have one linked.
 */
export async function processTransferQueueEntry(
  event: LifecycleQueueEntryEvent
): Promise<TransferAutomationResult> {
  const { tenantId, cardId, loopId, loopType, partId, quantity } = event;

  // Only process transfer loop types
  if (loopType !== 'transfer') {
    log.debug({ loopType, cardId }, 'Skipping non-transfer loop event');
    return { success: true, alreadyExisted: true };
  }

  log.info({ tenantId, cardId, loopId }, 'Processing transfer queue entry event');

  try {
    // Fetch the card and loop to check for existing TO and get source facility
    const card = await db.query.kanbanCards.findFirst({
      where: and(eq(kanbanCards.id, cardId), eq(kanbanCards.tenantId, tenantId)),
      with: {
        loop: true,
      },
    });

    if (!card) {
      log.warn({ cardId, tenantId }, 'Card not found');
      return { success: false, error: 'Card not found' };
    }

    // Duplicate guard: check if card already has a linked TO
    if (card.linkedTransferOrderId) {
      log.info(
        { cardId, existingToId: card.linkedTransferOrderId },
        'Card already linked to transfer order, skipping'
      );
      return {
        success: true,
        alreadyExisted: true,
        transferOrderId: card.linkedTransferOrderId,
      };
    }

    // Validate loop has sourceFacilityId
    if (!card.loop.sourceFacilityId) {
      log.error(
        { loopId, tenantId },
        'Transfer loop missing sourceFacilityId, cannot create TO'
      );
      return {
        success: false,
        error: 'Transfer loop must have sourceFacilityId configured',
      };
    }

    const sourceFacilityId = card.loop.sourceFacilityId;
    const destFacilityId = card.loop.facilityId;

    // Create transfer order in transaction
    const result = await db.transaction(async (tx) => {
      // Generate TO number
      const toNumber = await getNextTONumber(tenantId, tx);

      // Create transfer order
      const [to] = await tx
        .insert(transferOrders)
        .values({
          tenantId,
          toNumber,
          sourceFacilityId,
          destinationFacilityId: destFacilityId,
          status: 'draft',
          kanbanCardId: cardId,
          notes: `Auto-created from transfer Kanban trigger (card ${cardId})`,
          requestedDate: new Date(),
        })
        .returning({ id: transferOrders.id, toNumber: transferOrders.toNumber })
        .execute();

      // Create transfer order line
      await tx
        .insert(transferOrderLines)
        .values({
          tenantId,
          transferOrderId: to.id,
          partId,
          quantityRequested: quantity,
          notes: `Auto-generated line for part ${partId}`,
        })
        .execute();

      // Transition card from triggered -> ordered
      await transitionTriggeredCardToOrdered(tx, {
        tenantId,
        cardId,
        linkedTransferOrderId: to.id,
        notes: 'Auto-transitioned by transfer automation',
        userId: undefined, // system action
      });

      // Audit entry
      await writeAuditEntry(tx, {
        tenantId,
        userId: null,
        action: 'transfer_order.created',
        entityType: 'transfer_order',
        entityId: to.id,
        previousState: null,
        newState: {
          status: 'draft',
          source: 'automation',
          lineCount: 1,
        },
        metadata: {
          systemActor: 'transfer_automation',
          source: 'automation',
          transferOrderNumber: to.toNumber,
          kanbanCardId: cardId,
          loopId,
          partId,
          quantity,
          sourceFacilityId,
          destinationFacilityId: destFacilityId,
        },
      });

      // Audit card stage transition
      await writeAuditEntry(tx, {
        tenantId,
        userId: null,
        action: 'kanban_card.stage_transitioned',
        entityType: 'kanban_card',
        entityId: cardId,
        previousState: { stage: 'triggered' },
        newState: { stage: 'ordered' },
        metadata: {
          systemActor: 'transfer_automation',
          source: 'automation',
          loopId,
          method: 'system',
          linkedTransferOrderId: to.id,
          transferOrderNumber: to.toNumber,
        },
      });

      return { id: to.id, toNumber: to.toNumber };
    });

    // Publish automation.to_created event (fire-and-forget)
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'automation.to_created',
        tenantId,
        transferOrderId: result.id,
        toNumber: result.toNumber,
        source: 'automation',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.warn(
        { err, toId: result.id },
        'Failed to publish automation.to_created event (non-critical)'
      );
    }

    log.info(
      { toId: result.id, toNumber: result.toNumber, cardId },
      'Transfer order created and card advanced to ordered stage'
    );

    return {
      success: true,
      transferOrderId: result.id,
      toNumber: result.toNumber,
      alreadyExisted: false,
    };
  } catch (err) {
    log.error({ err, tenantId, cardId }, 'Failed to process transfer queue entry');
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Start listening to lifecycle.queue_entry events.
 * Call this from the orders service startup.
 */
export async function startTransferAutomationListener(redisUrl: string): Promise<void> {
  const eventBus = getEventBus(redisUrl);

  await eventBus.subscribeGlobal(async (event) => {
    if (event.type !== 'lifecycle.queue_entry') return;
    const queueEvent = event as LifecycleQueueEntryEvent;

    // Only process transfer loops
    if (queueEvent.loopType === 'transfer') {
      await processTransferQueueEntry(queueEvent);
    }
  });

  log.info('Transfer automation listener started');
}
