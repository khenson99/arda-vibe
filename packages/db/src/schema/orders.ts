import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const ordersSchema = pgSchema('orders');

// ─── Enums ────────────────────────────────────────────────────────────
export const poStatusEnum = pgEnum('po_status', [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'acknowledged',
  'partially_received',
  'received',
  'closed',
  'cancelled',
]);

export const woStatusEnum = pgEnum('wo_status', [
  'draft',
  'scheduled',
  'in_progress',
  'on_hold',
  'completed',
  'cancelled',
]);

export const transferStatusEnum = pgEnum('transfer_status', [
  'draft',
  'requested',
  'approved',
  'picking',
  'shipped',
  'in_transit',
  'received',
  'closed',
  'cancelled',
]);

export const routingStepStatusEnum = pgEnum('routing_step_status', [
  'pending',
  'in_progress',
  'complete',
  'on_hold',
  'skipped',
]);

export const woHoldReasonEnum = pgEnum('wo_hold_reason', [
  'material_shortage',
  'equipment_failure',
  'quality_hold',
  'labor_unavailable',
  'other',
]);

// ─── Purchase Orders ─────────────────────────────────────────────────
export const purchaseOrders = ordersSchema.table(
  'purchase_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    poNumber: varchar('po_number', { length: 50 }).notNull(), // auto-generated or manual
    supplierId: uuid('supplier_id').notNull(),
    facilityId: uuid('facility_id').notNull(), // receiving facility
    status: poStatusEnum('status').notNull().default('draft'),
    orderDate: timestamp('order_date', { withTimezone: true }),
    expectedDeliveryDate: timestamp('expected_delivery_date', { withTimezone: true }),
    actualDeliveryDate: timestamp('actual_delivery_date', { withTimezone: true }),
    subtotal: numeric('subtotal', { precision: 12, scale: 2 }).default('0'),
    taxAmount: numeric('tax_amount', { precision: 12, scale: 2 }).default('0'),
    shippingAmount: numeric('shipping_amount', { precision: 12, scale: 2 }).default('0'),
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).default('0'),
    currency: varchar('currency', { length: 3 }).default('USD'),
    notes: text('notes'),
    internalNotes: text('internal_notes'),
    paymentTerms: text('payment_terms'),
    shippingTerms: text('shipping_terms'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentToEmail: varchar('sent_to_email', { length: 255 }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdByUserId: uuid('created_by_user_id'),
    approvedByUserId: uuid('approved_by_user_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('po_tenant_number_idx').on(table.tenantId, table.poNumber),
    index('po_tenant_idx').on(table.tenantId),
    index('po_supplier_idx').on(table.supplierId),
    index('po_status_idx').on(table.tenantId, table.status),
    index('po_facility_idx').on(table.facilityId),
  ]
);

// ─── Purchase Order Lines ────────────────────────────────────────────
export const purchaseOrderLines = ordersSchema.table(
  'purchase_order_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    partId: uuid('part_id').notNull(),
    kanbanCardId: uuid('kanban_card_id'), // linked Kanban card that triggered this line
    lineNumber: integer('line_number').notNull(),
    quantityOrdered: integer('quantity_ordered').notNull(),
    quantityReceived: integer('quantity_received').notNull().default(0),
    unitCost: numeric('unit_cost', { precision: 12, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull(),
    notes: text('notes'),
    description: text('description'),
    orderMethod: varchar('order_method', { length: 30 }),
    sourceUrl: text('source_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('po_lines_tenant_idx').on(table.tenantId),
    index('po_lines_po_idx').on(table.purchaseOrderId),
    index('po_lines_part_idx').on(table.partId),
    index('po_lines_card_idx').on(table.kanbanCardId),
    index('po_lines_card_tenant_idx').on(table.tenantId, table.kanbanCardId),
  ]
);

// ─── Work Centers ────────────────────────────────────────────────────
export const workCenters = ordersSchema.table(
  'work_centers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    facilityId: uuid('facility_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    code: varchar('code', { length: 50 }).notNull(),
    description: text('description'),
    capacityPerHour: numeric('capacity_per_hour', { precision: 10, scale: 2 }),
    costPerHour: numeric('cost_per_hour', { precision: 10, scale: 2 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('work_centers_tenant_code_idx').on(table.tenantId, table.code),
    index('work_centers_tenant_idx').on(table.tenantId),
    index('work_centers_facility_idx').on(table.facilityId),
  ]
);

// ─── Work Orders ─────────────────────────────────────────────────────
export const workOrders = ordersSchema.table(
  'work_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    woNumber: varchar('wo_number', { length: 50 }).notNull(),
    partId: uuid('part_id').notNull(), // the part being produced
    facilityId: uuid('facility_id').notNull(),
    status: woStatusEnum('status').notNull().default('draft'),
    quantityToProduce: integer('quantity_to_produce').notNull(),
    quantityProduced: integer('quantity_produced').notNull().default(0),
    quantityRejected: integer('quantity_rejected').notNull().default(0),
    quantityScrapped: integer('quantity_scrapped').notNull().default(0),
    scheduledStartDate: timestamp('scheduled_start_date', { withTimezone: true }),
    scheduledEndDate: timestamp('scheduled_end_date', { withTimezone: true }),
    actualStartDate: timestamp('actual_start_date', { withTimezone: true }),
    actualEndDate: timestamp('actual_end_date', { withTimezone: true }),
    priority: integer('priority').notNull().default(0), // higher = more urgent
    isExpedited: boolean('is_expedited').notNull().default(false),
    isRework: boolean('is_rework').notNull().default(false),
    parentWorkOrderId: uuid('parent_work_order_id'), // for split WOs
    holdReason: woHoldReasonEnum('hold_reason'),
    holdNotes: text('hold_notes'),
    cancelReason: text('cancel_reason'),
    routingTemplateId: uuid('routing_template_id'), // last template applied (informational)
    notes: text('notes'),
    kanbanCardId: uuid('kanban_card_id'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wo_tenant_number_idx').on(table.tenantId, table.woNumber),
    index('wo_tenant_idx').on(table.tenantId),
    index('wo_part_idx').on(table.partId),
    index('wo_status_idx').on(table.tenantId, table.status),
    index('wo_facility_idx').on(table.facilityId),
    index('wo_card_idx').on(table.kanbanCardId),
    index('wo_parent_idx').on(table.parentWorkOrderId),
    index('wo_expedited_idx').on(table.tenantId, table.isExpedited),
  ]
);

// ─── Work Order Routing Steps ────────────────────────────────────────
export const workOrderRoutings = ordersSchema.table(
  'work_order_routings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrders.id, { onDelete: 'cascade' }),
    workCenterId: uuid('work_center_id')
      .notNull()
      .references(() => workCenters.id),
    stepNumber: integer('step_number').notNull(),
    operationName: varchar('operation_name', { length: 255 }).notNull(),
    status: routingStepStatusEnum('status').notNull().default('pending'),
    estimatedMinutes: integer('estimated_minutes'),
    actualMinutes: integer('actual_minutes'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wo_routing_tenant_idx').on(table.tenantId),
    index('wo_routing_wo_idx').on(table.workOrderId),
    index('wo_routing_wc_idx').on(table.workCenterId),
    uniqueIndex('wo_routing_step_idx').on(table.workOrderId, table.stepNumber),
  ]
);

// ─── Transfer Orders ─────────────────────────────────────────────────
export const transferOrders = ordersSchema.table(
  'transfer_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    toNumber: varchar('to_number', { length: 50 }).notNull(),
    sourceFacilityId: uuid('source_facility_id').notNull(),
    destinationFacilityId: uuid('destination_facility_id').notNull(),
    status: transferStatusEnum('status').notNull().default('draft'),
    requestedDate: timestamp('requested_date', { withTimezone: true }),
    shippedDate: timestamp('shipped_date', { withTimezone: true }),
    receivedDate: timestamp('received_date', { withTimezone: true }),
    priorityScore: numeric('priority_score', { precision: 8, scale: 4 }).default('0'),
    approvedByUserId: uuid('approved_by_user_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    notes: text('notes'),
    kanbanCardId: uuid('kanban_card_id'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('to_tenant_number_idx').on(table.tenantId, table.toNumber),
    index('to_tenant_idx').on(table.tenantId),
    index('to_source_facility_idx').on(table.sourceFacilityId),
    index('to_dest_facility_idx').on(table.destinationFacilityId),
    index('to_status_idx').on(table.tenantId, table.status),
    index('to_priority_idx').on(table.tenantId, table.priorityScore),
  ]
);

// ─── Transfer Order Lines ────────────────────────────────────────────
export const transferOrderLines = ordersSchema.table(
  'transfer_order_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    transferOrderId: uuid('transfer_order_id')
      .notNull()
      .references(() => transferOrders.id, { onDelete: 'cascade' }),
    partId: uuid('part_id').notNull(),
    quantityRequested: integer('quantity_requested').notNull(),
    quantityShipped: integer('quantity_shipped').notNull().default(0),
    quantityReceived: integer('quantity_received').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('to_lines_tenant_idx').on(table.tenantId),
    index('to_lines_to_idx').on(table.transferOrderId),
    index('to_lines_part_idx').on(table.partId),
  ]
);

// ─── Relations ────────────────────────────────────────────────────────
export const purchaseOrdersRelations = relations(purchaseOrders, ({ many }) => ({
  lines: many(purchaseOrderLines),
}));

export const purchaseOrderLinesRelations = relations(purchaseOrderLines, ({ one }) => ({
  purchaseOrder: one(purchaseOrders, {
    fields: [purchaseOrderLines.purchaseOrderId],
    references: [purchaseOrders.id],
  }),
}));

export const workOrdersRelations = relations(workOrders, ({ many }) => ({
  routings: many(workOrderRoutings),
}));

export const workOrderRoutingsRelations = relations(workOrderRoutings, ({ one }) => ({
  workOrder: one(workOrders, {
    fields: [workOrderRoutings.workOrderId],
    references: [workOrders.id],
  }),
  workCenter: one(workCenters, {
    fields: [workOrderRoutings.workCenterId],
    references: [workCenters.id],
  }),
}));

export const transferOrdersRelations = relations(transferOrders, ({ many }) => ({
  lines: many(transferOrderLines),
}));

export const transferOrderLinesRelations = relations(transferOrderLines, ({ one }) => ({
  transferOrder: one(transferOrders, {
    fields: [transferOrderLines.transferOrderId],
    references: [transferOrders.id],
  }),
}));

// ─── Receiving Enums ────────────────────────────────────────────────
export const receiptStatusEnum = pgEnum('receipt_status', [
  'complete',
  'partial',
  'exception',
]);

export const exceptionTypeEnum = pgEnum('exception_type', [
  'short_shipment',
  'damaged',
  'quality_reject',
  'wrong_item',
  'overage',
]);

export const exceptionSeverityEnum = pgEnum('exception_severity', [
  'low',
  'medium',
  'high',
  'critical',
]);

export const exceptionStatusEnum = pgEnum('exception_status', [
  'open',
  'in_progress',
  'resolved',
  'escalated',
]);

export const exceptionResolutionTypeEnum = pgEnum('exception_resolution_type', [
  'follow_up_po',
  'replacement_card',
  'return_to_supplier',
  'credit',
  'accept_as_is',
]);

// ─── Receipts ───────────────────────────────────────────────────────
export const receipts = ordersSchema.table(
  'receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    receiptNumber: varchar('receipt_number', { length: 50 }).notNull(),
    orderId: uuid('order_id').notNull(),
    orderType: varchar('order_type', { length: 30 }).notNull(), // purchase_order | work_order | transfer_order
    status: receiptStatusEnum('status').notNull().default('complete'),
    receivedByUserId: uuid('received_by_user_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('receipt_tenant_number_idx').on(table.tenantId, table.receiptNumber),
    index('receipt_tenant_idx').on(table.tenantId),
    index('receipt_order_idx').on(table.orderId),
    index('receipt_status_idx').on(table.tenantId, table.status),
  ]
);

// ─── Receipt Lines ──────────────────────────────────────────────────
export const receiptLines = ordersSchema.table(
  'receipt_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'cascade' }),
    orderLineId: uuid('order_line_id').notNull(), // FK to PO/WO/TO line
    partId: uuid('part_id').notNull(),
    quantityExpected: integer('quantity_expected').notNull(),
    quantityAccepted: integer('quantity_accepted').notNull().default(0),
    quantityDamaged: integer('quantity_damaged').notNull().default(0),
    quantityRejected: integer('quantity_rejected').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('receipt_lines_tenant_idx').on(table.tenantId),
    index('receipt_lines_receipt_idx').on(table.receiptId),
    index('receipt_lines_part_idx').on(table.partId),
  ]
);

// ─── Receiving Exceptions ───────────────────────────────────────────
export const receivingExceptions = ordersSchema.table(
  'receiving_exceptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'cascade' }),
    receiptLineId: uuid('receipt_line_id')
      .references(() => receiptLines.id),
    orderId: uuid('order_id').notNull(),
    orderType: varchar('order_type', { length: 30 }).notNull(),
    exceptionType: exceptionTypeEnum('exception_type').notNull(),
    severity: exceptionSeverityEnum('severity').notNull().default('medium'),
    status: exceptionStatusEnum('status').notNull().default('open'),
    quantityAffected: integer('quantity_affected').notNull(),
    description: text('description'),
    resolutionType: exceptionResolutionTypeEnum('resolution_type'),
    resolutionNotes: text('resolution_notes'),
    resolvedByUserId: uuid('resolved_by_user_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    followUpOrderId: uuid('follow_up_order_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('recv_exc_tenant_idx').on(table.tenantId),
    index('recv_exc_receipt_idx').on(table.receiptId),
    index('recv_exc_order_idx').on(table.orderId),
    index('recv_exc_status_idx').on(table.tenantId, table.status),
    index('recv_exc_type_idx').on(table.exceptionType),
  ]
);

// ─── Receiving Relations ────────────────────────────────────────────
export const receiptsRelations = relations(receipts, ({ many }) => ({
  lines: many(receiptLines),
  exceptions: many(receivingExceptions),
}));

export const receiptLinesRelations = relations(receiptLines, ({ one }) => ({
  receipt: one(receipts, {
    fields: [receiptLines.receiptId],
    references: [receipts.id],
  }),
}));

export const receivingExceptionsRelations = relations(receivingExceptions, ({ one }) => ({
  receipt: one(receipts, {
    fields: [receivingExceptions.receiptId],
    references: [receipts.id],
  }),
}));

// ─── Routing Templates ──────────────────────────────────────────────
export const routingTemplates = ordersSchema.table(
  'routing_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    partId: uuid('part_id'), // optional: default template for a specific part
    isActive: boolean('is_active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('routing_tpl_tenant_idx').on(table.tenantId),
    index('routing_tpl_part_idx').on(table.partId),
    index('routing_tpl_active_idx').on(table.tenantId, table.isActive),
  ]
);

// ─── Routing Template Steps ─────────────────────────────────────────
export const routingTemplateSteps = ordersSchema.table(
  'routing_template_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => routingTemplates.id, { onDelete: 'cascade' }),
    workCenterId: uuid('work_center_id')
      .notNull()
      .references(() => workCenters.id),
    stepNumber: integer('step_number').notNull(),
    operationName: varchar('operation_name', { length: 255 }).notNull(),
    estimatedMinutes: integer('estimated_minutes'),
    instructions: text('instructions'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('routing_tpl_step_tenant_idx').on(table.tenantId),
    index('routing_tpl_step_tpl_idx').on(table.templateId),
    uniqueIndex('routing_tpl_step_number_idx').on(table.templateId, table.stepNumber),
  ]
);

// ─── Production Operation Logs ──────────────────────────────────────
export const productionOperationLogs = ordersSchema.table(
  'production_operation_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrders.id, { onDelete: 'cascade' }),
    routingStepId: uuid('routing_step_id')
      .references(() => workOrderRoutings.id),
    operationType: varchar('operation_type', { length: 50 }).notNull(), // start_step, complete_step, skip_step, report_quantity, hold, resume, etc.
    actualMinutes: integer('actual_minutes'),
    quantityProduced: integer('quantity_produced'),
    quantityRejected: integer('quantity_rejected'),
    quantityScrapped: integer('quantity_scrapped'),
    operatorUserId: uuid('operator_user_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('prod_op_log_tenant_idx').on(table.tenantId),
    index('prod_op_log_wo_idx').on(table.workOrderId),
    index('prod_op_log_step_idx').on(table.routingStepId),
    index('prod_op_log_type_idx').on(table.operationType),
  ]
);

// ─── Work Center Capacity Windows ───────────────────────────────────
export const workCenterCapacityWindows = ordersSchema.table(
  'work_center_capacity_windows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    workCenterId: uuid('work_center_id')
      .notNull()
      .references(() => workCenters.id, { onDelete: 'cascade' }),
    dayOfWeek: integer('day_of_week').notNull(), // 0=Sun, 1=Mon, ... 6=Sat
    startHour: integer('start_hour').notNull(), // 0-23
    endHour: integer('end_hour').notNull(), // 0-23
    availableMinutes: integer('available_minutes').notNull(), // total minutes available in this window
    allocatedMinutes: integer('allocated_minutes').notNull().default(0),
    effectiveDate: timestamp('effective_date', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wc_cap_tenant_idx').on(table.tenantId),
    index('wc_cap_wc_idx').on(table.workCenterId),
    index('wc_cap_day_idx').on(table.workCenterId, table.dayOfWeek),
  ]
);

// ─── Production Queue Entries ───────────────────────────────────────
export const productionQueueEntries = ordersSchema.table(
  'production_queue_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrders.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id'), // linked kanban card
    loopId: uuid('loop_id'), // linked kanban loop
    partId: uuid('part_id').notNull(),
    facilityId: uuid('facility_id').notNull(),
    priorityScore: numeric('priority_score', { precision: 8, scale: 4 }).notNull().default('0'),
    manualPriority: integer('manual_priority').notNull().default(0),
    isExpedited: boolean('is_expedited').notNull().default(false),
    totalSteps: integer('total_steps').notNull().default(0),
    completedSteps: integer('completed_steps').notNull().default(0),
    status: varchar('status', { length: 30 }).notNull().default('pending'), // pending, active, on_hold, completed, cancelled
    enteredQueueAt: timestamp('entered_queue_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('prod_queue_tenant_idx').on(table.tenantId),
    uniqueIndex('prod_queue_wo_idx').on(table.workOrderId),
    index('prod_queue_card_idx').on(table.cardId),
    index('prod_queue_status_idx').on(table.tenantId, table.status),
    index('prod_queue_priority_idx').on(table.tenantId, table.priorityScore),
    index('prod_queue_facility_idx').on(table.facilityId),
  ]
);

// ─── Production Relations ───────────────────────────────────────────
export const routingTemplatesRelations = relations(routingTemplates, ({ many }) => ({
  steps: many(routingTemplateSteps),
}));

export const routingTemplateStepsRelations = relations(routingTemplateSteps, ({ one }) => ({
  template: one(routingTemplates, {
    fields: [routingTemplateSteps.templateId],
    references: [routingTemplates.id],
  }),
  workCenter: one(workCenters, {
    fields: [routingTemplateSteps.workCenterId],
    references: [workCenters.id],
  }),
}));

export const productionOperationLogsRelations = relations(productionOperationLogs, ({ one }) => ({
  workOrder: one(workOrders, {
    fields: [productionOperationLogs.workOrderId],
    references: [workOrders.id],
  }),
  routingStep: one(workOrderRoutings, {
    fields: [productionOperationLogs.routingStepId],
    references: [workOrderRoutings.id],
  }),
}));

export const workCenterCapacityWindowsRelations = relations(workCenterCapacityWindows, ({ one }) => ({
  workCenter: one(workCenters, {
    fields: [workCenterCapacityWindows.workCenterId],
    references: [workCenters.id],
  }),
}));

export const productionQueueEntriesRelations = relations(productionQueueEntries, ({ one }) => ({
  workOrder: one(workOrders, {
    fields: [productionQueueEntries.workOrderId],
    references: [workOrders.id],
  }),
}));

// ─── Lead Time History ──────────────────────────────────────────────
export const leadTimeHistory = ordersSchema.table(
  'lead_time_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    sourceFacilityId: uuid('source_facility_id').notNull(),
    destinationFacilityId: uuid('destination_facility_id').notNull(),
    partId: uuid('part_id').notNull(),
    transferOrderId: uuid('transfer_order_id')
      .references(() => transferOrders.id, { onDelete: 'set null' }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    leadTimeDays: numeric('lead_time_days', { precision: 6, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('lt_hist_tenant_idx').on(table.tenantId),
    index('lt_hist_route_idx').on(
      table.tenantId,
      table.sourceFacilityId,
      table.destinationFacilityId
    ),
    index('lt_hist_part_idx').on(table.partId),
    index('lt_hist_to_idx').on(table.transferOrderId),
    // Covers analytics date-range queries filtered by tenant
    index('lt_hist_tenant_received_idx').on(table.tenantId, table.receivedAt),
  ]
);

// ─── Lead Time History Relations ────────────────────────────────────
export const leadTimeHistoryRelations = relations(leadTimeHistory, ({ one }) => ({
  transferOrder: one(transferOrders, {
    fields: [leadTimeHistory.transferOrderId],
    references: [transferOrders.id],
  }),
}));

// ─── Order Issue Enums ─────────────────────────────────────────────
export const orderIssueCategoryEnum = pgEnum('order_issue_category', [
  'wrong_items',
  'wrong_quantity',
  'damaged',
  'late_delivery',
  'quality_defect',
  'pricing_discrepancy',
  'missing_documentation',
  'other',
]);

export const orderIssuePriorityEnum = pgEnum('order_issue_priority', [
  'low',
  'medium',
  'high',
  'critical',
]);

export const orderIssueStatusEnum = pgEnum('order_issue_status', [
  'open',
  'in_progress',
  'waiting_vendor',
  'resolved',
  'closed',
  'escalated',
]);

export const resolutionActionTypeEnum = pgEnum('resolution_action_type', [
  'contact_vendor',
  'return_initiated',
  'credit_requested',
  'credit_received',
  'replacement_ordered',
  'reorder',
  'accept_as_is',
  'escalated',
  'note_added',
  'status_changed',
]);

// ─── Order Issues ──────────────────────────────────────────────────
export const orderIssues = ordersSchema.table(
  'order_issues',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    orderType: varchar('order_type', { length: 30 }).notNull(), // purchase_order | work_order | transfer_order
    category: orderIssueCategoryEnum('category').notNull(),
    priority: orderIssuePriorityEnum('priority').notNull().default('medium'),
    status: orderIssueStatusEnum('status').notNull().default('open'),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    reportedByUserId: uuid('reported_by_user_id'),
    assignedToUserId: uuid('assigned_to_user_id'),
    resolvedByUserId: uuid('resolved_by_user_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    relatedReceiptId: uuid('related_receipt_id'),
    relatedExceptionId: uuid('related_exception_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('order_issue_tenant_idx').on(table.tenantId),
    index('order_issue_order_idx').on(table.orderId),
    index('order_issue_status_idx').on(table.tenantId, table.status),
    index('order_issue_category_idx').on(table.tenantId, table.category),
    index('order_issue_priority_idx').on(table.tenantId, table.priority),
    index('order_issue_assigned_idx').on(table.assignedToUserId),
  ]
);

// ─── Order Issue Resolution Steps ──────────────────────────────────
export const orderIssueResolutionSteps = ordersSchema.table(
  'order_issue_resolution_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => orderIssues.id, { onDelete: 'cascade' }),
    actionType: resolutionActionTypeEnum('action_type').notNull(),
    description: text('description'),
    performedByUserId: uuid('performed_by_user_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('issue_step_tenant_idx').on(table.tenantId),
    index('issue_step_issue_idx').on(table.issueId),
    index('issue_step_type_idx').on(table.actionType),
  ]
);

// ─── Order Notes ───────────────────────────────────────────────────
export const orderNotes = ordersSchema.table(
  'order_notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    orderId: uuid('order_id').notNull(),
    orderType: varchar('order_type', { length: 30 }).notNull(),
    content: text('content').notNull(),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('order_note_tenant_idx').on(table.tenantId),
    index('order_note_order_idx').on(table.orderId),
  ]
);

// ─── Order Issue Relations ─────────────────────────────────────────
export const orderIssuesRelations = relations(orderIssues, ({ many }) => ({
  resolutionSteps: many(orderIssueResolutionSteps),
}));

export const orderIssueResolutionStepsRelations = relations(orderIssueResolutionSteps, ({ one }) => ({
  issue: one(orderIssues, {
    fields: [orderIssueResolutionSteps.issueId],
    references: [orderIssues.id],
  }),
}));
