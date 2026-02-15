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

export const kanbanSchema = pgSchema('kanban');

// ─── Enums ────────────────────────────────────────────────────────────
export const loopTypeEnum = pgEnum('loop_type', [
  'procurement',  // triggers external POs
  'production',   // triggers internal work orders
  'transfer',     // triggers inter-facility transfers
]);

export const cardStageEnum = pgEnum('card_stage', [
  'created',
  'triggered',
  'ordered',     // ordered/scheduled
  'in_transit',
  'received',
  'restocked',
]);

export const cardModeEnum = pgEnum('card_mode', [
  'single',  // one card per part per loop
  'multi',   // multiple cards for same part in same loop
]);

// ─── Kanban Loops ────────────────────────────────────────────────────
// A loop defines the configuration for a Kanban cycle for a specific part
// at a specific location.
export const kanbanLoops = kanbanSchema.table(
  'kanban_loops',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    partId: uuid('part_id').notNull(),
    facilityId: uuid('facility_id').notNull(),
    storageLocationId: uuid('storage_location_id'),
    loopType: loopTypeEnum('loop_type').notNull(),
    cardMode: cardModeEnum('card_mode').notNull().default('single'),

    // ── Kanban Parameters (ReLoWiSa) ──
    minQuantity: integer('min_quantity').notNull(), // reorder point (Re)
    orderQuantity: integer('order_quantity').notNull(), // lot size / qty per replenishment (Lo)
    numberOfCards: integer('number_of_cards').notNull().default(1), // cards in this loop
    wipLimit: integer('wip_limit'), // max cards in-flight simultaneously (Wi)
    safetyStockDays: numeric('safety_stock_days', { precision: 5, scale: 1 }).default('0'), // (Sa)

    // ── Supplier/Source Assignment ──
    primarySupplierId: uuid('primary_supplier_id'), // for procurement loops
    sourceFacilityId: uuid('source_facility_id'),   // for transfer loops

    // ── Lead Time (stated, for initial setup) ──
    statedLeadTimeDays: integer('stated_lead_time_days'),

    // ── Status ──
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('kanban_loops_tenant_idx').on(table.tenantId),
    index('kanban_loops_part_idx').on(table.partId),
    index('kanban_loops_facility_idx').on(table.facilityId),
    uniqueIndex('kanban_loops_unique_idx').on(
      table.tenantId,
      table.partId,
      table.facilityId,
      table.loopType
    ),
  ]
);

// ─── Kanban Cards ────────────────────────────────────────────────────
// The physical/digital card. UUID is immutable and survives reprints.
export const kanbanCards = kanbanSchema.table(
  'kanban_cards',
  {
    id: uuid('id').defaultRandom().primaryKey(), // THE Card UUID (on QR code)
    tenantId: uuid('tenant_id').notNull(),
    loopId: uuid('loop_id')
      .notNull()
      .references(() => kanbanLoops.id, { onDelete: 'cascade' }),
    cardNumber: integer('card_number').notNull().default(1), // "Card X of Y"
    currentStage: cardStageEnum('current_stage').notNull().default('created'),
    currentStageEnteredAt: timestamp('current_stage_entered_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // ── Linked Order/Job (set when stage moves to 'ordered') ──
    linkedPurchaseOrderId: uuid('linked_purchase_order_id'),
    linkedWorkOrderId: uuid('linked_work_order_id'),
    linkedTransferOrderId: uuid('linked_transfer_order_id'),

    // ── Print Tracking ──
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),
    printCount: integer('print_count').notNull().default(0),

    // ── Cycle Counter ──
    completedCycles: integer('completed_cycles').notNull().default(0),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('kanban_cards_tenant_idx').on(table.tenantId),
    index('kanban_cards_loop_idx').on(table.loopId),
    index('kanban_cards_stage_idx').on(table.tenantId, table.currentStage),
    uniqueIndex('kanban_cards_loop_number_idx').on(table.loopId, table.cardNumber),
    index('kanban_cards_queue_idx').on(table.tenantId, table.currentStage, table.isActive),
  ]
);

// ─── Card Stage Transitions (Immutable Audit + Velocity Data) ────────
// Every time a card changes stage, a row is inserted here.
// This is the source of truth for velocity calculations.
export const cardStageTransitions = kanbanSchema.table(
  'card_stage_transitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => kanbanCards.id, { onDelete: 'cascade' }),
    loopId: uuid('loop_id')
      .notNull()
      .references(() => kanbanLoops.id, { onDelete: 'cascade' }),
    cycleNumber: integer('cycle_number').notNull(), // which cycle this transition belongs to
    fromStage: cardStageEnum('from_stage'),          // null for initial creation
    toStage: cardStageEnum('to_stage').notNull(),
    transitionedAt: timestamp('transitioned_at', { withTimezone: true }).notNull().defaultNow(),
    transitionedByUserId: uuid('transitioned_by_user_id'),
    method: varchar('method', { length: 50 }).notNull().default('manual'), // 'qr_scan', 'manual', 'system'
    notes: text('notes'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  },
  (table) => [
    index('card_transitions_tenant_idx').on(table.tenantId),
    index('card_transitions_card_idx').on(table.cardId),
    index('card_transitions_loop_idx').on(table.loopId),
    index('card_transitions_time_idx').on(table.transitionedAt),
    index('card_transitions_cycle_idx').on(table.cardId, table.cycleNumber),
    index('card_transitions_risk_scan_idx').on(table.tenantId, table.loopId, table.toStage, table.transitionedAt),
  ]
);

// ─── Kanban Parameter History (Track Changes for ReLoWiSa) ──────────
export const kanbanParameterHistory = kanbanSchema.table(
  'kanban_parameter_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    loopId: uuid('loop_id')
      .notNull()
      .references(() => kanbanLoops.id, { onDelete: 'cascade' }),
    changeType: varchar('change_type', { length: 50 }).notNull(), // 'manual', 'relowisa_approved', 'system'
    previousMinQuantity: integer('previous_min_quantity'),
    newMinQuantity: integer('new_min_quantity'),
    previousOrderQuantity: integer('previous_order_quantity'),
    newOrderQuantity: integer('new_order_quantity'),
    previousNumberOfCards: integer('previous_number_of_cards'),
    newNumberOfCards: integer('new_number_of_cards'),
    previousWipLimit: integer('previous_wip_limit'),
    newWipLimit: integer('new_wip_limit'),
    previousSafetyStockDays: numeric('previous_safety_stock_days', { precision: 5, scale: 1 }),
    newSafetyStockDays: numeric('new_safety_stock_days', { precision: 5, scale: 1 }),
    previousLeadTimeDays: integer('previous_lead_time_days'),
    newLeadTimeDays: integer('new_lead_time_days'),
    reason: text('reason'),
    changedByUserId: uuid('changed_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('param_history_tenant_idx').on(table.tenantId),
    index('param_history_loop_idx').on(table.loopId),
    index('param_history_time_idx').on(table.createdAt),
  ]
);

// ─── ReLoWiSa Recommendations ───────────────────────────────────────
export const reloWisaRecommendations = kanbanSchema.table(
  'relowisa_recommendations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    loopId: uuid('loop_id')
      .notNull()
      .references(() => kanbanLoops.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 50 }).notNull().default('pending'), // pending, approved, rejected, expired
    recommendedMinQuantity: integer('recommended_min_quantity'),
    recommendedOrderQuantity: integer('recommended_order_quantity'),
    recommendedNumberOfCards: integer('recommended_number_of_cards'),
    recommendedWipLimit: integer('recommended_wip_limit'),
    confidenceScore: numeric('confidence_score', { precision: 5, scale: 2 }), // 0.00 - 100.00
    reasoning: text('reasoning'), // AI/algorithm explanation
    dataPointsUsed: integer('data_points_used'), // number of cycles analyzed
    projectedImpact: jsonb('projected_impact').$type<ReloWisaImpact>().default({}),
    reviewedByUserId: uuid('reviewed_by_user_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('relowisa_tenant_idx').on(table.tenantId),
    index('relowisa_loop_idx').on(table.loopId),
    index('relowisa_status_idx').on(table.tenantId, table.status),
  ]
);

export interface ReloWisaImpact {
  estimatedStockoutReduction?: number; // percentage
  estimatedCarryingCostChange?: number; // percentage
  estimatedTurnImprovement?: number;   // ratio
}

// ─── Print Job Status ────────────────────────────────────────────────
export const printJobStatusEnum = pgEnum('print_job_status', [
  'pending',
  'printing',
  'completed',
  'failed',
  'cancelled',
]);

// ─── Print Jobs ──────────────────────────────────────────────────────
// Tracks each batch print operation for audit and reprint workflows.
export const printJobs = kanbanSchema.table(
  'print_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    status: printJobStatusEnum('status').notNull().default('pending'),
    format: varchar('format', { length: 50 }).notNull(),       // CardFormat value
    printerClass: varchar('printer_class', { length: 20 }).notNull(), // 'standard' | 'thermal'
    cardCount: integer('card_count').notNull(),
    isReprint: boolean('is_reprint').notNull().default(false),
    settings: jsonb('settings').$type<PrintJobSettings>().default({}),
    requestedByUserId: uuid('requested_by_user_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('print_jobs_tenant_idx').on(table.tenantId),
    index('print_jobs_status_idx').on(table.tenantId, table.status),
  ]
);

export interface PrintJobSettings {
  scale?: number;
  margins?: { top: number; right: number; bottom: number; left: number };
  colorMode?: 'color' | 'monochrome';
  orientation?: 'portrait' | 'landscape';
  templateId?: string;
}

// ─── Card Templates ───────────────────────────────────────────────────
// Tenant-shared WYSIWYG templates for printable kanban cards.
export const cardTemplates = kanbanSchema.table(
  'card_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    format: varchar('format', { length: 50 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    createdByUserId: uuid('created_by_user_id'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('card_templates_tenant_fmt_status_idx').on(table.tenantId, table.format, table.status),
    index('card_templates_tenant_default_idx').on(table.tenantId, table.format, table.isDefault),
  ]
);

// ─── Print Job Items ─────────────────────────────────────────────────
// Each card included in a print job.
export const printJobItems = kanbanSchema.table(
  'print_job_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    printJobId: uuid('print_job_id')
      .notNull()
      .references(() => printJobs.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => kanbanCards.id, { onDelete: 'cascade' }),
    previousPrintCount: integer('previous_print_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('print_job_items_job_idx').on(table.printJobId),
    index('print_job_items_card_idx').on(table.cardId),
  ]
);

// ─── Relations ────────────────────────────────────────────────────────
export const kanbanLoopsRelations = relations(kanbanLoops, ({ many }) => ({
  cards: many(kanbanCards),
  transitions: many(cardStageTransitions),
  parameterHistory: many(kanbanParameterHistory),
  recommendations: many(reloWisaRecommendations),
}));

export const kanbanCardsRelations = relations(kanbanCards, ({ one, many }) => ({
  loop: one(kanbanLoops, {
    fields: [kanbanCards.loopId],
    references: [kanbanLoops.id],
  }),
  transitions: many(cardStageTransitions),
}));

export const cardStageTransitionsRelations = relations(cardStageTransitions, ({ one }) => ({
  card: one(kanbanCards, {
    fields: [cardStageTransitions.cardId],
    references: [kanbanCards.id],
  }),
  loop: one(kanbanLoops, {
    fields: [cardStageTransitions.loopId],
    references: [kanbanLoops.id],
  }),
}));

export const printJobsRelations = relations(printJobs, ({ many }) => ({
  items: many(printJobItems),
}));

export const cardTemplatesRelations = relations(cardTemplates, () => ({}));

export const printJobItemsRelations = relations(printJobItems, ({ one }) => ({
  printJob: one(printJobs, {
    fields: [printJobItems.printJobId],
    references: [printJobs.id],
  }),
  card: one(kanbanCards, {
    fields: [printJobItems.cardId],
    references: [kanbanCards.id],
  }),
}));
