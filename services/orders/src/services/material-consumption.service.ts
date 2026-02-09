/**
 * Material Consumption Service (Ticket #77)
 *
 * BOM-driven material consumption when routing steps complete:
 * - Lookup single-level BOM for the WO part
 * - Calculate required quantities based on WO quantity and BOM ratios
 * - Record consumption entries in the production operation log
 * - Publish events for inventory adjustment downstream
 *
 * NOTE: This service records the consumption intent. The actual
 * inventory decrement happens in the inventory/catalog service
 * via event subscription (eventually consistent).
 */

import { db, schema } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import { getEventBus } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';

const log = createLogger('material-consumption');

const {
  workOrders,
  productionOperationLogs,
  auditLog,
} = schema;

// BOM comes from the catalog schema
const { bomItems, parts } = schema;

// ─── Types ────────────────────────────────────────────────────────────

export interface MaterialConsumptionLine {
  childPartId: string;
  childPartNumber?: string;
  quantityPer: number;
  quantityConsumed: number;
}

export interface ConsumptionResult {
  workOrderId: string;
  stepId: string;
  lines: MaterialConsumptionLine[];
  totalLinesConsumed: number;
}

export interface RecordConsumptionInput {
  tenantId: string;
  workOrderId: string;
  stepId: string;
  quantityProduced: number;
  userId?: string;
}

// ─── BOM Lookup ──────────────────────────────────────────────────────

/**
 * Fetch single-level BOM for a given part.
 * Returns child parts with quantity-per ratios.
 */
export async function getBomForPart(
  tenantId: string,
  partId: string
): Promise<{ childPartId: string; childPartNumber: string; quantityPer: number }[]> {
  const rows = await db
    .select({
      childPartId: bomItems.childPartId,
      childPartNumber: parts.partNumber,
      quantityPer: bomItems.quantityPer,
    })
    .from(bomItems)
    .innerJoin(parts, eq(parts.id, bomItems.childPartId))
    .where(
      and(
        eq(bomItems.tenantId, tenantId),
        eq(bomItems.parentPartId, partId)
      )
    )
    .execute();

  return rows.map((r) => ({
    childPartId: r.childPartId,
    childPartNumber: r.childPartNumber,
    quantityPer: Number(r.quantityPer),
  }));
}

// ─── Record Material Consumption ────────────────────────────────────

/**
 * Record material consumption for a completed routing step.
 * Calculates required materials from BOM and logs consumption entries.
 *
 * This is called when a routing step completes and reports good quantity.
 * The consumption amount = quantityProduced * BOM quantityPer for each child.
 */
export async function recordMaterialConsumption(
  input: RecordConsumptionInput
): Promise<ConsumptionResult> {
  const { tenantId, workOrderId, stepId, quantityProduced, userId } = input;

  if (quantityProduced <= 0) {
    return { workOrderId, stepId, lines: [], totalLinesConsumed: 0 };
  }

  // Get the WO to find the part
  const [wo] = await db
    .select({ id: workOrders.id, partId: workOrders.partId })
    .from(workOrders)
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.tenantId, tenantId)))
    .execute();

  if (!wo) throw new AppError(404, `Work order ${workOrderId} not found`);

  // Get BOM
  const bom = await getBomForPart(tenantId, wo.partId);

  if (bom.length === 0) {
    log.info(
      { workOrderId, partId: wo.partId },
      'No BOM defined for part; skipping material consumption'
    );
    return { workOrderId, stepId, lines: [], totalLinesConsumed: 0 };
  }

  // Calculate and record consumption
  const lines: MaterialConsumptionLine[] = [];
  const now = new Date();
  const timestamp = now.toISOString();

  for (const bomLine of bom) {
    const quantityConsumed = quantityProduced * bomLine.quantityPer;

    // Log the consumption in the production operation log
    await db.insert(productionOperationLogs).values({
      tenantId,
      workOrderId,
      routingStepId: stepId,
      operationType: 'report_quantity',
      quantityProduced: quantityConsumed,
      quantityRejected: 0,
      quantityScrapped: 0,
      notes: `Material consumption: ${bomLine.childPartNumber} x ${quantityConsumed.toFixed(4)} (${quantityProduced} produced * ${bomLine.quantityPer} per)`,
      operatorUserId: userId || null,
    }).execute();

    lines.push({
      childPartId: bomLine.childPartId,
      childPartNumber: bomLine.childPartNumber,
      quantityPer: bomLine.quantityPer,
      quantityConsumed,
    });
  }

  // Audit
  await db.insert(auditLog).values({
    tenantId,
    userId: userId || null,
    action: 'material_consumption.recorded',
    entityType: 'work_order',
    entityId: workOrderId,
    previousState: null,
    newState: {
      stepId,
      quantityProduced,
      linesConsumed: lines.length,
      totalMaterials: lines.map((l) => ({
        partId: l.childPartId,
        qty: l.quantityConsumed,
      })),
    },
    metadata: { source: 'material_consumption' },
    ipAddress: null,
    userAgent: null,
    timestamp: now,
  });

  // Publish event for downstream inventory adjustment
  try {
    const eventBus = getEventBus(config.REDIS_URL);
    await eventBus.publish({
      type: 'production.quantity_reported',
      tenantId,
      workOrderId,
      workOrderNumber: '', // filled downstream
      quantityProduced,
      quantityRejected: 0,
      quantityScrapped: 0,
      timestamp,
    });
  } catch (err) {
    log.error({ err, workOrderId }, 'Failed to publish material consumption event');
  }

  log.info(
    { workOrderId, stepId, linesConsumed: lines.length, quantityProduced },
    'Material consumption recorded'
  );

  return {
    workOrderId,
    stepId,
    lines,
    totalLinesConsumed: lines.length,
  };
}
