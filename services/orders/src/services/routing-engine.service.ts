/**
 * Routing Execution Engine (Ticket #75)
 *
 * Manages routing template application, sequential step execution,
 * step status transitions, and WO auto-completion checks.
 */

import { db, schema, writeAuditEntry } from '@arda/db';
import { eq, and, asc, sql, lt } from 'drizzle-orm';
import { getEventBus } from '@arda/events';
import { config, createLogger } from '@arda/config';
import type { ProductionStepCompletedEvent } from '@arda/events';
import { ROUTING_STEP_VALID_TRANSITIONS } from '@arda/shared-types';
import type { RoutingStepStatus } from '@arda/shared-types';
import { AppError } from '../middleware/error-handler.js';

const log = createLogger('routing-engine');

const {
  workOrders,
  workOrderRoutings,
  routingTemplates,
  routingTemplateSteps,
  productionOperationLogs,
  productionQueueEntries,
} = schema;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Types ────────────────────────────────────────────────────────────

export interface ApplyTemplateInput {
  tenantId: string;
  workOrderId: string;
  templateId: string;
  userId?: string;
}

export interface ApplyTemplateResult {
  templateName: string;
  stepsCreated: number;
}

export interface TransitionStepInput {
  tenantId: string;
  workOrderId: string;
  routingStepId: string;
  toStatus: RoutingStepStatus;
  actualMinutes?: number;
  notes?: string;
  userId?: string;
}

export interface TransitionStepResult {
  routingStepId: string;
  fromStatus: string;
  toStatus: string;
  stepNumber: number;
  operationName: string;
  allStepsComplete: boolean;
  canAutoComplete: boolean;
}

// ─── Template Application ────────────────────────────────────────────

/**
 * Apply a routing template to a work order, copying all steps.
 * Template steps are COPIED (not referenced) -- changes to the template
 * do not affect existing WOs.
 */
export async function applyRoutingTemplate(
  input: ApplyTemplateInput
): Promise<ApplyTemplateResult> {
  const { tenantId, workOrderId, templateId, userId } = input;

  // Verify WO exists and is in a modifiable state
  const [wo] = await db
    .select({
      id: workOrders.id,
      status: workOrders.status,
      woNumber: workOrders.woNumber,
    })
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
    .execute();

  if (!wo) {
    throw new AppError(404, `Work order ${workOrderId} not found`);
  }

  if (wo.status !== 'draft' && wo.status !== 'scheduled') {
    throw new AppError(
      400,
      `Cannot apply routing template to a WO in ${wo.status} status. Must be draft or scheduled.`
    );
  }

  // Verify template exists and is active
  const [template] = await db
    .select({ id: routingTemplates.id, name: routingTemplates.name })
    .from(routingTemplates)
    .where(
      and(
        eq(routingTemplates.id, templateId),
        eq(routingTemplates.tenantId, tenantId),
        eq(routingTemplates.isActive, true)
      )
    )
    .execute();

  if (!template) {
    throw new AppError(404, `Routing template ${templateId} not found or inactive`);
  }

  // Fetch template steps
  const steps = await db
    .select()
    .from(routingTemplateSteps)
    .where(
      and(
        eq(routingTemplateSteps.templateId, templateId),
        eq(routingTemplateSteps.tenantId, tenantId)
      )
    )
    .orderBy(asc(routingTemplateSteps.stepNumber))
    .execute();

  if (steps.length === 0) {
    throw new AppError(400, `Template ${template.name} has no steps defined`);
  }

  // Execute in transaction
  const result = await db.transaction(async (tx) => {
    const now = new Date();

    // Delete any existing routing steps for this WO
    await tx
      .delete(workOrderRoutings)
      .where(
        and(eq(workOrderRoutings.workOrderId, workOrderId), eq(workOrderRoutings.tenantId, tenantId))
      )
      .execute();

    // Copy template steps to WO
    for (const step of steps) {
      await tx
        .insert(workOrderRoutings)
        .values({
          tenantId,
          workOrderId,
          workCenterId: step.workCenterId,
          stepNumber: step.stepNumber,
          operationName: step.operationName,
          status: 'pending',
          estimatedMinutes: step.estimatedMinutes,
        })
        .execute();
    }

    // Update WO to reference the template
    await tx
      .update(workOrders)
      .set({ routingTemplateId: templateId, updatedAt: now })
      .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
      .execute();

    // Update queue entry step counts
    await tx
      .update(productionQueueEntries)
      .set({ totalSteps: steps.length, completedSteps: 0, updatedAt: now })
      .where(
        and(
          eq(productionQueueEntries.workOrderId, workOrderId),
          eq(productionQueueEntries.tenantId, tenantId)
        )
      )
      .execute();

    // Audit
    await writeAuditEntry(tx, {
      tenantId,
      userId: userId || null,
      action: 'work_order.routing_template_applied',
      entityType: 'work_order',
      entityId: workOrderId,
      previousState: null,
      newState: {
        templateId,
        templateName: template.name,
        stepsCreated: steps.length,
      },
      metadata: { workOrderNumber: wo.woNumber, source: 'routing_engine' },
      timestamp: now,
    });

    return { templateName: template.name, stepsCreated: steps.length };
  });

  return result;
}

// ─── Step Execution ──────────────────────────────────────────────────

/**
 * Transition a routing step to a new status, enforcing sequential execution.
 *
 * Guardrails:
 * - Cannot start step N unless step N-1 is complete or skipped
 * - actualMinutes required when completing a step
 * - Returns whether all steps are done and if WO can auto-complete
 */
export async function transitionRoutingStep(
  input: TransitionStepInput
): Promise<TransitionStepResult> {
  const { tenantId, workOrderId, routingStepId, toStatus, actualMinutes, notes, userId } = input;

  // Fetch the target step
  const [step] = await db
    .select()
    .from(workOrderRoutings)
    .where(
      and(
        eq(workOrderRoutings.id, routingStepId),
        eq(workOrderRoutings.workOrderId, workOrderId),
        eq(workOrderRoutings.tenantId, tenantId)
      )
    )
    .execute();

  if (!step) {
    throw new AppError(404, `Routing step ${routingStepId} not found`);
  }

  // Validate transition
  const fromStatus = step.status;
  if (!ROUTING_STEP_VALID_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    throw new AppError(
      400,
      `Cannot transition routing step from ${fromStatus} to ${toStatus}`
    );
  }

  // Validate completion requires actualMinutes
  if (toStatus === 'complete' && (actualMinutes === undefined || actualMinutes === null)) {
    throw new AppError(400, 'actualMinutes must be provided when completing a step');
  }

  // Enforce sequential execution for in_progress transition
  if (toStatus === 'in_progress' && fromStatus === 'pending') {
    await enforceSequentialOrder(tenantId, workOrderId, step.stepNumber);
  }

  // Fetch WO for number (used in events/audit)
  const [wo] = await db
    .select({ woNumber: workOrders.woNumber, quantityToProduce: workOrders.quantityToProduce, quantityProduced: workOrders.quantityProduced })
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
    .execute();

  if (!wo) {
    throw new AppError(404, `Work order ${workOrderId} not found`);
  }

  const now = new Date();
  const updateValues: Record<string, unknown> = {
    status: toStatus,
    updatedAt: now,
  };

  if (toStatus === 'in_progress' && fromStatus === 'pending') {
    updateValues.startedAt = now;
  }
  if (toStatus === 'complete') {
    updateValues.completedAt = now;
    updateValues.actualMinutes = actualMinutes;
  }
  if (notes !== undefined) {
    updateValues.notes = notes;
  }

  // Update the step
  await db
    .update(workOrderRoutings)
    .set(updateValues)
    .where(
      and(
        eq(workOrderRoutings.id, routingStepId),
        eq(workOrderRoutings.tenantId, tenantId)
      )
    )
    .execute();

  // Log operation
  if (toStatus === 'in_progress' || toStatus === 'complete' || toStatus === 'skipped') {
    const operationType =
      toStatus === 'in_progress' ? 'start_step' :
      toStatus === 'complete' ? 'complete_step' :
      'skip_step';

    await db.insert(productionOperationLogs).values({
      tenantId,
      workOrderId,
      routingStepId,
      operationType,
      actualMinutes: actualMinutes || null,
      operatorUserId: userId || null,
      notes: notes || null,
    }).execute();
  }

  // Audit
  await writeAuditEntry(db, {
    tenantId,
    userId: userId || null,
    action: 'work_order.routing_updated',
    entityType: 'work_order_routing',
    entityId: routingStepId,
    previousState: { status: fromStatus },
    newState: { status: toStatus, actualMinutes },
    metadata: {
      workOrderId,
      workOrderNumber: wo.woNumber,
      stepNumber: step.stepNumber,
      operationName: step.operationName,
      source: 'routing_engine',
    },
    timestamp: now,
  });

  // Check if all steps are done
  const allSteps = await db
    .select({ status: workOrderRoutings.status })
    .from(workOrderRoutings)
    .where(
      and(eq(workOrderRoutings.workOrderId, workOrderId), eq(workOrderRoutings.tenantId, tenantId))
    )
    .execute();

  const allDone = allSteps.every(
    (s) => s.status === 'complete' || s.status === 'skipped'
  );

  const completedCount = allSteps.filter(
    (s) => s.status === 'complete' || s.status === 'skipped'
  ).length;

  // Update queue entry step progress
  await db
    .update(productionQueueEntries)
    .set({ completedSteps: completedCount, updatedAt: now })
    .where(
      and(
        eq(productionQueueEntries.workOrderId, workOrderId),
        eq(productionQueueEntries.tenantId, tenantId)
      )
    )
    .execute();

  // Can auto-complete? All steps done AND quantity met
  const canAutoComplete = allDone && wo.quantityProduced >= wo.quantityToProduce;

  // Emit step completed event
  if (toStatus === 'complete' || toStatus === 'skipped') {
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'production.step_completed',
        tenantId,
        workOrderId,
        workOrderNumber: wo.woNumber,
        stepNumber: step.stepNumber,
        operationName: step.operationName,
        workCenterId: step.workCenterId,
        actualMinutes: actualMinutes ?? 0,
        status: toStatus as 'complete' | 'skipped',
        timestamp: now.toISOString(),
      } satisfies ProductionStepCompletedEvent);
    } catch (err) {
      log.error({ err }, 'Failed to emit step completed event');
    }
  }

  return {
    routingStepId,
    fromStatus,
    toStatus,
    stepNumber: step.stepNumber,
    operationName: step.operationName,
    allStepsComplete: allDone,
    canAutoComplete,
  };
}

/**
 * Enforce that step N cannot start unless step N-1 is complete or skipped.
 */
async function enforceSequentialOrder(
  tenantId: string,
  workOrderId: string,
  currentStepNumber: number
): Promise<void> {
  if (currentStepNumber <= 1) {
    return; // First step has no predecessor constraint
  }

  // Fetch all steps with stepNumber < currentStepNumber
  const previousSteps = await db
    .select({ stepNumber: workOrderRoutings.stepNumber, status: workOrderRoutings.status })
    .from(workOrderRoutings)
    .where(
      and(
        eq(workOrderRoutings.workOrderId, workOrderId),
        eq(workOrderRoutings.tenantId, tenantId),
        lt(workOrderRoutings.stepNumber, currentStepNumber)
      )
    )
    .orderBy(asc(workOrderRoutings.stepNumber))
    .execute();

  const allPreviousDone = previousSteps.every(
    (s) => s.status === 'complete' || s.status === 'skipped'
  );

  if (!allPreviousDone) {
    const blockedStep = previousSteps.find(
      (s) => s.status !== 'complete' && s.status !== 'skipped'
    );
    throw new AppError(
      400,
      `Cannot start step ${currentStepNumber}: step ${blockedStep?.stepNumber} is still ${blockedStep?.status}`
    );
  }
}

// ─── Fetch Routing Steps ─────────────────────────────────────────────

/**
 * Get all routing steps for a work order, ordered by stepNumber.
 */
export async function getRoutingSteps(
  tenantId: string,
  workOrderId: string
): Promise<Array<typeof workOrderRoutings.$inferSelect>> {
  return db
    .select()
    .from(workOrderRoutings)
    .where(
      and(eq(workOrderRoutings.workOrderId, workOrderId), eq(workOrderRoutings.tenantId, tenantId))
    )
    .orderBy(asc(workOrderRoutings.stepNumber))
    .execute();
}

// ─── WO Auto-Completion Check ────────────────────────────────────────

/**
 * Check if a work order can be auto-completed:
 * - All routing steps must be complete or skipped
 * - quantityProduced >= quantityToProduce
 */
export async function canAutoCompleteWorkOrder(
  tenantId: string,
  workOrderId: string
): Promise<{ canComplete: boolean; reason?: string }> {
  const [wo] = await db
    .select({
      status: workOrders.status,
      quantityToProduce: workOrders.quantityToProduce,
      quantityProduced: workOrders.quantityProduced,
    })
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
    .execute();

  if (!wo) {
    return { canComplete: false, reason: 'Work order not found' };
  }

  if (wo.status !== 'in_progress') {
    return { canComplete: false, reason: `Work order is in ${wo.status} status` };
  }

  const steps = await db
    .select({ status: workOrderRoutings.status })
    .from(workOrderRoutings)
    .where(
      and(eq(workOrderRoutings.workOrderId, workOrderId), eq(workOrderRoutings.tenantId, tenantId))
    )
    .execute();

  const allDone = steps.length === 0 || steps.every(
    (s) => s.status === 'complete' || s.status === 'skipped'
  );

  if (!allDone) {
    return { canComplete: false, reason: 'Not all routing steps are complete or skipped' };
  }

  if (wo.quantityProduced < wo.quantityToProduce) {
    return {
      canComplete: false,
      reason: `Quantity produced (${wo.quantityProduced}) is less than required (${wo.quantityToProduce})`,
    };
  }

  return { canComplete: true };
}
