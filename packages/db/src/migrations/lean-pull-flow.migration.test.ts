import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_SQL_PATH = resolve(process.cwd(), 'drizzle/0004_lean_pull_flow.sql');

type Specs = Record<string, string>;

type PartFixture = {
  order_mechanism?: string | null;
  location?: string | null;
  min_qty?: number | null;
  min_qty_unit?: string | null;
  order_qty?: number | null;
  order_qty_unit?: string | null;
  primary_supplier_name?: string | null;
  primary_supplier_link?: string | null;
  item_notes?: string | null;
  gl_code?: string | null;
  item_subtype?: string | null;
  description?: string | null;
  specifications?: Specs | null;
};

function trimOrNull(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function toOptionalInt(value: string | null | undefined): number | null {
  if (value == null) return null;
  const digitsOnly = value.replace(/[^0-9-]/g, '');
  if (!digitsOnly) return null;
  const parsed = Number.parseInt(digitsOnly, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function fromSpecs(specs: Specs | null | undefined, keys: string[]): string | null {
  for (const key of keys) {
    const value = trimOrNull(specs?.[key]);
    if (value) return value;
  }
  return null;
}

function applyMigrationBackfill(input: PartFixture): Required<PartFixture> {
  const specs = input.specifications ?? {};

  const order_mechanism =
    trimOrNull(input.order_mechanism) ??
    fromSpecs(specs, ['orderMechanism', 'order_mechanism']) ??
    'purchase_order';

  const location =
    trimOrNull(input.location) ??
    fromSpecs(specs, ['location', 'storageLocation']) ??
    null;

  const min_qty =
    (typeof input.min_qty === 'number' ? input.min_qty : null) ??
    toOptionalInt(specs.minQty) ??
    null;

  const min_qty_unit =
    trimOrNull(input.min_qty_unit) ??
    fromSpecs(specs, ['minQtyUnit', 'min_qty_unit']) ??
    null;

  const order_qty =
    (typeof input.order_qty === 'number' ? input.order_qty : null) ??
    toOptionalInt(specs.orderQty) ??
    null;

  const order_qty_unit =
    trimOrNull(input.order_qty_unit) ??
    fromSpecs(specs, ['orderQtyUnit', 'order_qty_unit']) ??
    null;

  const primary_supplier_name =
    trimOrNull(input.primary_supplier_name) ??
    fromSpecs(specs, ['primarySupplier', 'primary_supplier_name']) ??
    null;

  const primary_supplier_link =
    trimOrNull(input.primary_supplier_link) ??
    fromSpecs(specs, ['primarySupplierLink', 'primary_supplier_link']) ??
    null;

  const item_notes =
    trimOrNull(input.item_notes) ??
    fromSpecs(specs, ['itemNotes', '__ardaItemNotesHtml']) ??
    trimOrNull(input.description) ??
    null;

  const gl_code =
    trimOrNull(input.gl_code) ??
    fromSpecs(specs, ['glCode', 'gl_code']) ??
    null;

  const item_subtype =
    trimOrNull(input.item_subtype) ??
    fromSpecs(specs, ['itemSubtype', 'item_subtype']) ??
    null;

  return {
    order_mechanism,
    location,
    min_qty,
    min_qty_unit,
    order_qty,
    order_qty_unit,
    primary_supplier_name,
    primary_supplier_link,
    item_notes,
    gl_code,
    item_subtype,
    description: input.description ?? null,
    specifications: specs,
  };
}

describe('0004 lean pull flow migration', () => {
  it('declares all required columns and default/not-null for order_mechanism', () => {
    const sql = readFileSync(MIGRATION_SQL_PATH, 'utf8');

    expect(sql).toContain('ADD COLUMN "order_mechanism"');
    expect(sql).toContain('ADD COLUMN "location"');
    expect(sql).toContain('ADD COLUMN "min_qty"');
    expect(sql).toContain('ADD COLUMN "min_qty_unit"');
    expect(sql).toContain('ADD COLUMN "order_qty"');
    expect(sql).toContain('ADD COLUMN "order_qty_unit"');
    expect(sql).toContain('ADD COLUMN "primary_supplier_name"');
    expect(sql).toContain('ADD COLUMN "primary_supplier_link"');
    expect(sql).toContain('ADD COLUMN "item_notes"');
    expect(sql).toContain('ADD COLUMN "gl_code"');
    expect(sql).toContain('ADD COLUMN "item_subtype"');
    expect(sql).toContain('ALTER COLUMN "order_mechanism" SET DEFAULT \'purchase_order\'');
    expect(sql).toContain('ALTER COLUMN "order_mechanism" SET NOT NULL');
  });

  it('backfills legacy specification keys and defaults missing methods to purchase_order', () => {
    const migratedFromSpecs = applyMigrationBackfill({
      order_mechanism: null,
      location: null,
      min_qty: null,
      min_qty_unit: null,
      order_qty: null,
      order_qty_unit: null,
      primary_supplier_name: null,
      primary_supplier_link: null,
      item_notes: null,
      gl_code: null,
      item_subtype: null,
      description: 'Description fallback',
      specifications: {
        orderMechanism: 'email',
        location: 'Rack-9',
        minQty: '15',
        minQtyUnit: 'case',
        orderQty: '40',
        orderQtyUnit: 'case',
        primarySupplier: 'Flow Supplier',
        primarySupplierLink: 'https://supplier.example/lean-bolt',
        itemNotes: 'Kanban note',
        glCode: 'GL-4100',
        itemSubtype: 'consumable',
      },
    });

    expect(migratedFromSpecs).toEqual(
      expect.objectContaining({
        order_mechanism: 'email',
        location: 'Rack-9',
        min_qty: 15,
        min_qty_unit: 'case',
        order_qty: 40,
        order_qty_unit: 'case',
        primary_supplier_name: 'Flow Supplier',
        primary_supplier_link: 'https://supplier.example/lean-bolt',
        item_notes: 'Kanban note',
        gl_code: 'GL-4100',
        item_subtype: 'consumable',
      }),
    );

    const migratedMissingMethod = applyMigrationBackfill({
      description: 'Only description',
      specifications: {},
    });

    expect(migratedMissingMethod.order_mechanism).toBe('purchase_order');
    expect(migratedMissingMethod.item_notes).toBe('Only description');
  });
});
