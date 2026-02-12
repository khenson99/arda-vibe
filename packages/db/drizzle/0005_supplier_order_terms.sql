ALTER TABLE "catalog"."suppliers"
  ADD COLUMN "recipient" varchar(255),
  ADD COLUMN "recipient_email" varchar(255),
  ADD COLUMN "shipping_terms" varchar(100);

UPDATE "catalog"."suppliers"
SET
  "recipient" = COALESCE(
    NULLIF(BTRIM("recipient"), ''),
    NULLIF(BTRIM("contact_name"), '')
  ),
  "recipient_email" = COALESCE(
    NULLIF(BTRIM("recipient_email"), ''),
    NULLIF(BTRIM("contact_email"), '')
  )
WHERE
  ("recipient" IS NULL OR BTRIM("recipient") = '')
  OR ("recipient_email" IS NULL OR BTRIM("recipient_email") = '');
