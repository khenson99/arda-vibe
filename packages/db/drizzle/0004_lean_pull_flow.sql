ALTER TABLE "catalog"."parts"
  ADD COLUMN "order_mechanism" varchar(30),
  ADD COLUMN "location" varchar(255),
  ADD COLUMN "min_qty" integer,
  ADD COLUMN "min_qty_unit" varchar(50),
  ADD COLUMN "order_qty" integer,
  ADD COLUMN "order_qty_unit" varchar(50),
  ADD COLUMN "primary_supplier_name" varchar(255),
  ADD COLUMN "primary_supplier_link" text,
  ADD COLUMN "item_notes" text,
  ADD COLUMN "gl_code" varchar(100),
  ADD COLUMN "item_subtype" varchar(100);

UPDATE "catalog"."parts"
SET
  "order_mechanism" = COALESCE(
    NULLIF(BTRIM("order_mechanism"), ''),
    NULLIF(BTRIM("specifications" ->> 'orderMechanism'), ''),
    NULLIF(BTRIM("specifications" ->> 'order_mechanism'), ''),
    'purchase_order'
  ),
  "location" = COALESCE(
    NULLIF(BTRIM("location"), ''),
    NULLIF(BTRIM("specifications" ->> 'location'), ''),
    NULLIF(BTRIM("specifications" ->> 'storageLocation'), '')
  ),
  "min_qty" = COALESCE(
    "min_qty",
    NULLIF(REGEXP_REPLACE(COALESCE("specifications" ->> 'minQty', ''), '[^0-9-]', '', 'g'), '')::integer
  ),
  "min_qty_unit" = COALESCE(
    NULLIF(BTRIM("min_qty_unit"), ''),
    NULLIF(BTRIM("specifications" ->> 'minQtyUnit'), ''),
    NULLIF(BTRIM("specifications" ->> 'min_qty_unit'), '')
  ),
  "order_qty" = COALESCE(
    "order_qty",
    NULLIF(REGEXP_REPLACE(COALESCE("specifications" ->> 'orderQty', ''), '[^0-9-]', '', 'g'), '')::integer
  ),
  "order_qty_unit" = COALESCE(
    NULLIF(BTRIM("order_qty_unit"), ''),
    NULLIF(BTRIM("specifications" ->> 'orderQtyUnit'), ''),
    NULLIF(BTRIM("specifications" ->> 'order_qty_unit'), '')
  ),
  "primary_supplier_name" = COALESCE(
    NULLIF(BTRIM("primary_supplier_name"), ''),
    NULLIF(BTRIM("specifications" ->> 'primarySupplier'), ''),
    NULLIF(BTRIM("specifications" ->> 'primary_supplier_name'), '')
  ),
  "primary_supplier_link" = COALESCE(
    NULLIF(BTRIM("primary_supplier_link"), ''),
    NULLIF(BTRIM("specifications" ->> 'primarySupplierLink'), ''),
    NULLIF(BTRIM("specifications" ->> 'primary_supplier_link'), '')
  ),
  "item_notes" = COALESCE(
    NULLIF(BTRIM("item_notes"), ''),
    NULLIF(BTRIM("specifications" ->> 'itemNotes'), ''),
    NULLIF(BTRIM("specifications" ->> '__ardaItemNotesHtml'), ''),
    NULLIF(BTRIM("description"), '')
  ),
  "gl_code" = COALESCE(
    NULLIF(BTRIM("gl_code"), ''),
    NULLIF(BTRIM("specifications" ->> 'glCode'), ''),
    NULLIF(BTRIM("specifications" ->> 'gl_code'), '')
  ),
  "item_subtype" = COALESCE(
    NULLIF(BTRIM("item_subtype"), ''),
    NULLIF(BTRIM("specifications" ->> 'itemSubtype'), ''),
    NULLIF(BTRIM("specifications" ->> 'item_subtype'), '')
  );

UPDATE "catalog"."parts"
SET "order_mechanism" = 'purchase_order'
WHERE "order_mechanism" IS NULL OR BTRIM("order_mechanism") = '';

ALTER TABLE "catalog"."parts"
  ALTER COLUMN "order_mechanism" SET DEFAULT 'purchase_order',
  ALTER COLUMN "order_mechanism" SET NOT NULL;
