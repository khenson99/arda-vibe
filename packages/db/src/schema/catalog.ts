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
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

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
    statedLeadTimeDays: integer('stated_lead_time_days'), // supplier-provided lead time
    paymentTerms: varchar('payment_terms', { length: 100 }), // "Net 30", "2/10 Net 30"
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
