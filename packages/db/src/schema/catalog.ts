import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  numeric,
  integer,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const catalogSchema = pgSchema('catalog');

// ─── Enums ────────────────────────────────────────────────────────────
export const partTypeEnum = pgEnum('part_type', [
  'raw_material',
  'component',
  'subassembly',
  'finished_good',
  'consumable',
  'packaging',
  'other',
]);

export const uomEnum = pgEnum('unit_of_measure', [
  'each',
  'box',
  'case',
  'pallet',
  'kg',
  'lb',
  'meter',
  'foot',
  'liter',
  'gallon',
  'roll',
  'sheet',
  'pair',
  'set',
  'other',
]);

// ─── Part Categories ──────────────────────────────────────────────────
export const partCategories = catalogSchema.table(
  'part_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    parentCategoryId: uuid('parent_category_id'), // self-referencing for hierarchy
    description: text('description'),
    sortOrder: integer('sort_order').default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('part_categories_tenant_idx').on(table.tenantId),
    uniqueIndex('part_categories_tenant_name_idx').on(table.tenantId, table.name),
  ]
);

// ─── Parts (Master Catalog) ──────────────────────────────────────────
export const parts = catalogSchema.table(
  'parts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    partNumber: varchar('part_number', { length: 100 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    categoryId: uuid('category_id').references(() => partCategories.id),
    type: partTypeEnum('type').notNull().default('component'),
    uom: uomEnum('uom').notNull().default('each'),
    unitCost: numeric('unit_cost', { precision: 12, scale: 4 }),
    unitPrice: numeric('unit_price', { precision: 12, scale: 4 }),
    weight: numeric('weight', { precision: 10, scale: 4 }), // in base unit (kg or lb, per tenant setting)
    upcBarcode: varchar('upc_barcode', { length: 50 }),
    manufacturerPartNumber: varchar('manufacturer_part_number', { length: 100 }),
    imageUrl: text('image_url'),
    orderMechanism: varchar('order_mechanism', { length: 30 }).notNull().default('purchase_order'),
    location: varchar('location', { length: 255 }),
    minQty: integer('min_qty'),
    minQtyUnit: varchar('min_qty_unit', { length: 50 }),
    orderQty: integer('order_qty'),
    orderQtyUnit: varchar('order_qty_unit', { length: 50 }),
    primarySupplierName: varchar('primary_supplier_name', { length: 255 }),
    primarySupplierLink: text('primary_supplier_link'),
    itemNotes: text('item_notes'),
    glCode: varchar('gl_code', { length: 100 }),
    itemSubtype: varchar('item_subtype', { length: 100 }),
    specifications: jsonb('specifications').$type<Record<string, string>>().default({}),
    isActive: boolean('is_active').notNull().default(true),
    isSellable: boolean('is_sellable').notNull().default(false), // exposed to eCommerce API
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('parts_tenant_partnumber_idx').on(table.tenantId, table.partNumber),
    index('parts_tenant_idx').on(table.tenantId),
    index('parts_category_idx').on(table.categoryId),
    index('parts_upc_idx').on(table.upcBarcode),
    index('parts_sellable_idx').on(table.tenantId, table.isSellable),
  ]
);

// ─── Suppliers ────────────────────────────────────────────────────────
export const suppliers = catalogSchema.table(
  'suppliers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    code: varchar('code', { length: 50 }),
    contactName: varchar('contact_name', { length: 255 }),
    contactEmail: varchar('contact_email', { length: 255 }),
    contactPhone: varchar('contact_phone', { length: 50 }),
    addressLine1: varchar('address_line_1', { length: 255 }),
    addressLine2: varchar('address_line_2', { length: 255 }),
    city: varchar('city', { length: 100 }),
    state: varchar('state', { length: 100 }),
    postalCode: varchar('postal_code', { length: 20 }),
    country: varchar('country', { length: 100 }).default('US'),
    website: text('website'),
    notes: text('notes'),
    recipient: varchar('recipient', { length: 255 }),
    recipientEmail: varchar('recipient_email', { length: 255 }),
    statedLeadTimeDays: integer('stated_lead_time_days'), // supplier-provided lead time
    paymentTerms: varchar('payment_terms', { length: 100 }), // "Net 30", "2/10 Net 30"
    shippingTerms: varchar('shipping_terms', { length: 100 }),
    orderMethods: jsonb('order_methods').$type<string[]>().default([]), // e.g. ["email","phone","portal","fax"]
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('suppliers_tenant_idx').on(table.tenantId),
    uniqueIndex('suppliers_tenant_code_idx').on(table.tenantId, table.code),
  ]
);

// ─── Supplier-Part Link (Many-to-Many + pricing/lead time per link) ──
export const supplierParts = catalogSchema.table(
  'supplier_parts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    supplierPartNumber: varchar('supplier_part_number', { length: 100 }),
    unitCost: numeric('unit_cost', { precision: 12, scale: 4 }),
    minimumOrderQty: integer('minimum_order_qty').default(1),
    leadTimeDays: integer('lead_time_days'),
    isPrimary: boolean('is_primary').notNull().default(false), // primary supplier for this part
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('supplier_parts_tenant_supplier_part_idx').on(
      table.tenantId,
      table.supplierId,
      table.partId
    ),
    index('supplier_parts_tenant_idx').on(table.tenantId),
    index('supplier_parts_part_idx').on(table.partId),
    index('supplier_parts_supplier_idx').on(table.supplierId),
  ]
);

// ─── BOM Items (Single-Level Bill of Materials) ──────────────────────
export const bomItems = catalogSchema.table(
  'bom_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    parentPartId: uuid('parent_part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    childPartId: uuid('child_part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'restrict' }),
    quantityPer: numeric('quantity_per', { precision: 10, scale: 4 }).notNull(), // qty of child per 1 parent
    sortOrder: integer('sort_order').default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('bom_items_parent_child_idx').on(
      table.tenantId,
      table.parentPartId,
      table.childPartId
    ),
    index('bom_items_tenant_idx').on(table.tenantId),
    index('bom_items_parent_idx').on(table.parentPartId),
    index('bom_items_child_idx').on(table.childPartId),
  ]
);

// ─── Relations ────────────────────────────────────────────────────────
export const partsRelations = relations(parts, ({ one, many }) => ({
  category: one(partCategories, {
    fields: [parts.categoryId],
    references: [partCategories.id],
  }),
  supplierParts: many(supplierParts),
  bomChildren: many(bomItems, { relationName: 'parentBom' }),
  bomParents: many(bomItems, { relationName: 'childBom' }),
}));

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  supplierParts: many(supplierParts),
}));

export const supplierPartsRelations = relations(supplierParts, ({ one }) => ({
  supplier: one(suppliers, {
    fields: [supplierParts.supplierId],
    references: [suppliers.id],
  }),
  part: one(parts, {
    fields: [supplierParts.partId],
    references: [parts.id],
  }),
}));

export const bomItemsRelations = relations(bomItems, ({ one }) => ({
  parentPart: one(parts, {
    fields: [bomItems.parentPartId],
    references: [parts.id],
    relationName: 'parentBom',
  }),
  childPart: one(parts, {
    fields: [bomItems.childPartId],
    references: [parts.id],
    relationName: 'childBom',
  }),
}));

// --- Import Pipeline Enums (MVP-21) ------------------------------------------
export const importJobStatusEnum = pgEnum('import_job_status', [
  'pending',
  'parsing',
  'matching',
  'review',
  'applying',
  'completed',
  'failed',
  'cancelled',
]);

export const importSourceTypeEnum = pgEnum('import_source_type', [
  'csv',
  'xlsx',
  'google_sheets',
  'manual_entry',
]);

export const importItemDispositionEnum = pgEnum('import_item_disposition', [
  'new',
  'duplicate',
  'update',
  'skip',
  'error',
]);

export const aiOperationTypeEnum = pgEnum('ai_operation_type', [
  'field_mapping',
  'deduplication',
  'categorization',
  'enrichment',
  'validation',
]);

export const aiProviderLogStatusEnum = pgEnum('ai_provider_log_status', [
  'pending',
  'success',
  'error',
  'timeout',
]);

// --- Import Jobs -------------------------------------------------------------
export const importJobs = catalogSchema.table(
  'import_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    status: importJobStatusEnum('status').notNull().default('pending'),
    sourceType: importSourceTypeEnum('source_type').notNull(),
    fileName: varchar('file_name', { length: 500 }).notNull(),
    fileUrl: text('file_url'),
    fileSizeBytes: integer('file_size_bytes'),
    fieldMapping: jsonb('field_mapping').$type<Record<string, string>>(),
    totalRows: integer('total_rows').notNull().default(0),
    processedRows: integer('processed_rows').notNull().default(0),
    newItems: integer('new_items').notNull().default(0),
    duplicateItems: integer('duplicate_items').notNull().default(0),
    updatedItems: integer('updated_items').notNull().default(0),
    skippedItems: integer('skipped_items').notNull().default(0),
    errorItems: integer('error_items').notNull().default(0),
    errorLog: jsonb('error_log').$type<Array<{ row: number; field?: string; message: string }>>(),
    createdByUserId: uuid('created_by_user_id').notNull(),
    reviewedByUserId: uuid('reviewed_by_user_id'),
    appliedByUserId: uuid('applied_by_user_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('import_jobs_tenant_idx').on(table.tenantId),
    index('import_jobs_tenant_status_idx').on(table.tenantId, table.status),
    index('import_jobs_created_by_idx').on(table.createdByUserId),
    index('import_jobs_created_at_idx').on(table.tenantId, table.createdAt),
  ]
);

// --- Import Items (parsed rows from the source file) -------------------------
export const importItems = catalogSchema.table(
  'import_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    importJobId: uuid('import_job_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    rawData: jsonb('raw_data').$type<Record<string, unknown>>().notNull(),
    normalizedData: jsonb('normalized_data').$type<Record<string, unknown>>(),
    disposition: importItemDispositionEnum('disposition').notNull().default('new'),
    matchedPartId: uuid('matched_part_id'),
    validationErrors: jsonb('validation_errors').$type<Array<{ field: string; message: string }>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('import_items_tenant_idx').on(table.tenantId),
    index('import_items_job_idx').on(table.importJobId),
    index('import_items_job_disposition_idx').on(table.importJobId, table.disposition),
    index('import_items_matched_part_idx').on(table.matchedPartId),
    // Composite FKs enforce tenant isolation — cross-tenant references are impossible
    foreignKey({
      name: 'import_items_job_tenant_fk',
      columns: [table.importJobId, table.tenantId],
      foreignColumns: [importJobs.id, importJobs.tenantId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'import_items_part_tenant_fk',
      columns: [table.matchedPartId, table.tenantId],
      foreignColumns: [parts.id, parts.tenantId],
    }).onDelete('set null'),
  ]
);

// --- Import Matches (deduplication match candidates) -------------------------
export const importMatches = catalogSchema.table(
  'import_matches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    importItemId: uuid('import_item_id').notNull(),
    existingPartId: uuid('existing_part_id').notNull(),
    matchScore: numeric('match_score', { precision: 5, scale: 4 }).notNull(),
    matchMethod: varchar('match_method', { length: 50 }).notNull(),
    matchDetails: jsonb('match_details').$type<Record<string, unknown>>(),
    isAccepted: boolean('is_accepted'),
    reviewedByUserId: uuid('reviewed_by_user_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('import_matches_tenant_idx').on(table.tenantId),
    index('import_matches_item_idx').on(table.importItemId),
    index('import_matches_existing_part_idx').on(table.existingPartId),
    index('import_matches_score_idx').on(table.importItemId, table.matchScore),
    // Composite FKs enforce tenant isolation — cross-tenant references are impossible
    foreignKey({
      name: 'import_matches_item_tenant_fk',
      columns: [table.importItemId, table.tenantId],
      foreignColumns: [importItems.id, importItems.tenantId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'import_matches_part_tenant_fk',
      columns: [table.existingPartId, table.tenantId],
      foreignColumns: [parts.id, parts.tenantId],
    }).onDelete('cascade'),
  ]
);

// --- AI Provider Config (per-tenant AI settings) -----------------------------
export const aiProviderConfig = catalogSchema.table(
  'ai_provider_config',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    providerName: varchar('provider_name', { length: 100 }).notNull(),
    operationType: aiOperationTypeEnum('operation_type').notNull(),
    modelName: varchar('model_name', { length: 100 }).notNull(),
    apiKeyEncrypted: text('api_key_encrypted'),
    config: jsonb('config').$type<Record<string, unknown>>().default({}),
    isEnabled: boolean('is_enabled').notNull().default(true),
    maxRequestsPerMinute: integer('max_requests_per_minute').default(60),
    maxTokensPerRequest: integer('max_tokens_per_request').default(4096),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ai_provider_config_tenant_idx').on(table.tenantId),
    uniqueIndex('ai_provider_config_tenant_op_idx').on(
      table.tenantId,
      table.operationType
    ),
    // Enabled configurations must have an API key to prevent runtime failures
    check(
      'ai_provider_config_enabled_key_chk',
      sql`${table.isEnabled} = false OR ${table.apiKeyEncrypted} IS NOT NULL`
    ),
  ]
);

// --- AI Provider Logs (audit trail for AI calls) -----------------------------
export const aiProviderLogs = catalogSchema.table(
  'ai_provider_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    importJobId: uuid('import_job_id').references(() => importJobs.id, { onDelete: 'set null' }),
    operationType: aiOperationTypeEnum('operation_type').notNull(),
    providerName: varchar('provider_name', { length: 100 }).notNull(),
    modelName: varchar('model_name', { length: 100 }).notNull(),
    status: aiProviderLogStatusEnum('status').notNull().default('pending'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    requestPayload: jsonb('request_payload').$type<Record<string, unknown>>(),
    responsePayload: jsonb('response_payload').$type<Record<string, unknown>>(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ai_provider_logs_tenant_idx').on(table.tenantId),
    index('ai_provider_logs_job_idx').on(table.importJobId),
    index('ai_provider_logs_tenant_op_idx').on(table.tenantId, table.operationType),
    index('ai_provider_logs_created_at_idx').on(table.tenantId, table.createdAt),
  ]
);

// --- Import Pipeline Relations -----------------------------------------------
export const importJobsRelations = relations(importJobs, ({ many }) => ({
  items: many(importItems),
  aiLogs: many(aiProviderLogs),
}));

export const importItemsRelations = relations(importItems, ({ one, many }) => ({
  importJob: one(importJobs, {
    fields: [importItems.importJobId],
    references: [importJobs.id],
  }),
  matchedPart: one(parts, {
    fields: [importItems.matchedPartId],
    references: [parts.id],
  }),
  matches: many(importMatches),
}));

export const importMatchesRelations = relations(importMatches, ({ one }) => ({
  importItem: one(importItems, {
    fields: [importMatches.importItemId],
    references: [importItems.id],
  }),
  existingPart: one(parts, {
    fields: [importMatches.existingPartId],
    references: [parts.id],
  }),
}));

export const aiProviderLogsRelations = relations(aiProviderLogs, ({ one }) => ({
  importJob: one(importJobs, {
    fields: [aiProviderLogs.importJobId],
    references: [importJobs.id],
  }),
}));
