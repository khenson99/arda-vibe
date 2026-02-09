# Arda V2 -- Entity Catalog

> Per-entity specification: columns, types, constraints, relationships, and tenant
> isolation notes. Derived from Drizzle ORM schema files in `packages/db/src/schema/`.
> Last updated: 2026-02-08

---

## Table of Contents

1. [Schema: auth](#1-schema-auth)
   - [tenants](#11-authtenants)
   - [users](#12-authusers)
   - [oauth_accounts](#13-authoauth_accounts)
   - [refresh_tokens](#14-authrefresh_tokens)
2. [Schema: locations](#2-schema-locations)
   - [facilities](#21-locationsfacilities)
   - [storage_locations](#22-locationsstorage_locations)
3. [Schema: catalog](#3-schema-catalog)
   - [part_categories](#31-catalogpart_categories)
   - [parts](#32-catalogparts)
   - [suppliers](#33-catalogsuppliers)
   - [supplier_parts](#34-catalogsupplier_parts)
   - [bom_items](#35-catalogbom_items)
4. [Schema: kanban](#4-schema-kanban)
   - [kanban_loops](#41-kanbankanban_loops)
   - [kanban_cards](#42-kanbankanban_cards)
   - [card_stage_transitions](#43-kanbancard_stage_transitions)
   - [kanban_parameter_history](#44-kanbankanban_parameter_history)
   - [relowisa_recommendations](#45-kanbanrelowisa_recommendations)
5. [Schema: orders](#5-schema-orders)
   - [purchase_orders](#51-orderspurchase_orders)
   - [purchase_order_lines](#52-orderspurchase_order_lines)
   - [work_centers](#53-orderswork_centers)
   - [work_orders](#54-orderswork_orders)
   - [work_order_routings](#55-orderswork_order_routings)
   - [transfer_orders](#56-orderstransfer_orders)
   - [transfer_order_lines](#57-orderstransfer_order_lines)
6. [Schema: notifications](#6-schema-notifications)
   - [notifications](#61-notificationsnotifications)
   - [notification_preferences](#62-notificationsnotification_preferences)
7. [Schema: billing](#7-schema-billing)
   - [subscription_plans](#71-billingsubscription_plans)
   - [usage_records](#72-billingusage_records)
8. [Schema: audit](#8-schema-audit)
   - [audit_log](#81-auditaudit_log)

---

## Notation

- **PK** = Primary Key
- **FK** = Foreign Key (database-level constraint)
- **FK-app** = Foreign Key enforced at application layer (cross-schema)
- **UK** = Unique constraint
- **NN** = NOT NULL
- **D** = Has default value

---

## 1. Schema: auth

### 1.1 auth.tenants

The root entity. Every organization (company) in Arda is a tenant. All other
tenant-scoped tables reference back to this table via `tenant_id`.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| name | varchar(255) | NN | -- | -- | Display name |
| slug | varchar(100) | NN | -- | UK | URL-safe identifier |
| domain | varchar(255) | Y | -- | -- | Custom domain (optional) |
| logo_url | text | Y | -- | -- | Branding |
| settings | jsonb | Y | `{}` | -- | `TenantSettings` shape |
| stripe_customer_id | varchar(255) | Y | -- | -- | Stripe integration |
| stripe_subscription_id | varchar(255) | Y | -- | -- | Stripe integration |
| plan_id | varchar(50) | NN | `'free'` | FK-app -> billing.subscription_plans | Current subscription tier |
| card_limit | integer | NN | `50` | -- | Max kanban cards on plan |
| seat_limit | integer | NN | `3` | -- | Max users on plan |
| is_active | boolean | NN | `true` | -- | Soft delete / suspension |
| trial_ends_at | timestamptz | Y | -- | -- | Free trial expiry |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**TenantSettings JSON shape:**
```typescript
interface TenantSettings {
  timezone?: string;
  dateFormat?: string;
  currency?: string;
  defaultCardFormat?: string;
  requireApprovalForPO?: boolean;
  autoConsolidateOrders?: boolean;
  reloWisaEnabled?: boolean;
}
```

**Indexes:**
- `tenants_slug_idx` on (slug)
- `tenants_stripe_customer_idx` on (stripe_customer_id)

**Tenant isolation:** This IS the tenant table. RLS policy: unrestricted for
service-level queries; user-facing queries scoped by authenticated tenant.

---

### 1.2 auth.users

Individual user accounts. Scoped to a tenant. Email uniqueness is per-tenant
(different tenants may have users with the same email).

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK -> auth.tenants (CASCADE) | Tenant scope |
| email | varchar(255) | NN | -- | UK(tenant_id, email) | Unique per tenant |
| password_hash | text | Y | -- | -- | Null if OAuth-only |
| first_name | varchar(100) | NN | -- | -- | |
| last_name | varchar(100) | NN | -- | -- | |
| avatar_url | text | Y | -- | -- | |
| role | enum user_role | NN | `'inventory_manager'` | -- | See enum values below |
| is_active | boolean | NN | `true` | -- | Soft disable |
| email_verified | boolean | NN | `false` | -- | |
| last_login_at | timestamptz | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `user_role`:** `tenant_admin`, `inventory_manager`, `procurement_manager`,
`receiving_manager`, `ecommerce_director`, `salesperson`, `executive`

**Indexes:**
- `users_tenant_email_idx` UNIQUE on (tenant_id, email)
- `users_tenant_idx` on (tenant_id)
- `users_email_idx` on (email)

**Tenant isolation:** Filtered by `tenant_id`. RLS: `tenant_id = current_setting('app.tenant_id')`.

---

### 1.3 auth.oauth_accounts

Third-party OAuth provider links. Currently supports Google only.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| user_id | uuid | NN | -- | FK -> auth.users (CASCADE) | |
| provider | enum oauth_provider | NN | -- | UK(provider, provider_account_id) | |
| provider_account_id | varchar(255) | NN | -- | UK(provider, provider_account_id) | |
| access_token | text | Y | -- | -- | Encrypted at rest |
| refresh_token | text | Y | -- | -- | Encrypted at rest |
| expires_at | timestamptz | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |

**Enum `oauth_provider`:** `google`

**Indexes:**
- `oauth_provider_account_idx` UNIQUE on (provider, provider_account_id)
- `oauth_user_idx` on (user_id)

**Tenant isolation:** Indirectly scoped via user_id -> users.tenant_id. No direct
tenant_id column; queries join through users.

---

### 1.4 auth.refresh_tokens

JWT refresh token tracking for token rotation and revocation.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| user_id | uuid | NN | -- | FK -> auth.users (CASCADE) | |
| token_hash | varchar(255) | NN | -- | UK | SHA-256 of the token |
| expires_at | timestamptz | NN | -- | -- | |
| revoked_at | timestamptz | Y | -- | -- | Null if active |
| replaced_by_token_id | uuid | Y | -- | -- | Token rotation chain |
| user_agent | text | Y | -- | -- | Device identification |
| ip_address | varchar(45) | Y | -- | -- | IPv4 or IPv6 |
| created_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `refresh_tokens_user_idx` on (user_id)
- `refresh_tokens_hash_idx` on (token_hash)

**Tenant isolation:** Indirectly scoped via user_id -> users.tenant_id.

---

## 2. Schema: locations

### 2.1 locations.facilities

Physical locations: warehouses, plants, distribution centers.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| name | varchar(255) | NN | -- | -- | |
| code | varchar(50) | NN | -- | UK(tenant_id, code) | e.g. "PLT-01", "WH-EAST" |
| type | varchar(50) | NN | `'warehouse'` | -- | warehouse, plant, distribution_center |
| address_line_1 | varchar(255) | Y | -- | -- | |
| address_line_2 | varchar(255) | Y | -- | -- | |
| city | varchar(100) | Y | -- | -- | |
| state | varchar(100) | Y | -- | -- | |
| postal_code | varchar(20) | Y | -- | -- | |
| country | varchar(100) | Y | `'US'` | -- | |
| latitude | numeric(10,7) | Y | -- | -- | |
| longitude | numeric(10,7) | Y | -- | -- | |
| timezone | varchar(50) | Y | `'America/Chicago'` | -- | IANA timezone |
| is_active | boolean | NN | `true` | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `facilities_tenant_code_idx` UNIQUE on (tenant_id, code)
- `facilities_tenant_idx` on (tenant_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 2.2 locations.storage_locations

Bins, shelves, and zones within a facility.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| facility_id | uuid | NN | -- | FK -> locations.facilities (CASCADE) | |
| name | varchar(255) | NN | -- | -- | |
| code | varchar(100) | NN | -- | UK(tenant_id, facility_id, code) | e.g. "A-01-03" |
| zone | varchar(100) | Y | -- | -- | Logical grouping |
| description | text | Y | -- | -- | |
| is_active | boolean | NN | `true` | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `storage_locations_tenant_facility_code_idx` UNIQUE on (tenant_id, facility_id, code)
- `storage_locations_tenant_idx` on (tenant_id)
- `storage_locations_facility_idx` on (facility_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

## 3. Schema: catalog

### 3.1 catalog.part_categories

Hierarchical part classification. Self-referencing for nested categories.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| name | varchar(255) | NN | -- | UK(tenant_id, name) | Unique per tenant |
| parent_category_id | uuid | Y | -- | FK-app (self-ref) | Hierarchy |
| description | text | Y | -- | -- | |
| sort_order | integer | Y | `0` | -- | Display ordering |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `part_categories_tenant_idx` on (tenant_id)
- `part_categories_tenant_name_idx` UNIQUE on (tenant_id, name)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 3.2 catalog.parts

Master parts catalog. The central entity for all inventory and supply chain ops.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| part_number | varchar(100) | NN | -- | UK(tenant_id, part_number) | Unique per tenant |
| name | varchar(255) | NN | -- | -- | |
| description | text | Y | -- | -- | |
| category_id | uuid | Y | -- | FK -> catalog.part_categories | |
| type | enum part_type | NN | `'component'` | -- | See enum below |
| uom | enum unit_of_measure | NN | `'each'` | -- | See enum below |
| unit_cost | numeric(12,4) | Y | -- | -- | Standard cost |
| unit_price | numeric(12,4) | Y | -- | -- | Selling price |
| weight | numeric(10,4) | Y | -- | -- | In base unit per tenant setting |
| upc_barcode | varchar(50) | Y | -- | -- | |
| manufacturer_part_number | varchar(100) | Y | -- | -- | |
| image_url | text | Y | -- | -- | |
| specifications | jsonb | Y | `{}` | -- | Key-value spec pairs |
| is_active | boolean | NN | `true` | -- | Soft delete |
| is_sellable | boolean | NN | `false` | -- | Exposed to eCommerce API |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `part_type`:** `raw_material`, `component`, `subassembly`, `finished_good`,
`consumable`, `packaging`, `other`

**Enum `unit_of_measure`:** `each`, `box`, `case`, `pallet`, `kg`, `lb`, `meter`,
`foot`, `liter`, `gallon`, `roll`, `sheet`, `pair`, `set`, `other`

**Indexes:**
- `parts_tenant_partnumber_idx` UNIQUE on (tenant_id, part_number)
- `parts_tenant_idx` on (tenant_id)
- `parts_category_idx` on (category_id)
- `parts_upc_idx` on (upc_barcode)
- `parts_sellable_idx` on (tenant_id, is_sellable)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 3.3 catalog.suppliers

Vendor / supplier master data.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| name | varchar(255) | NN | -- | -- | |
| code | varchar(50) | Y | -- | UK(tenant_id, code) | Unique per tenant |
| contact_name | varchar(255) | Y | -- | -- | |
| contact_email | varchar(255) | Y | -- | -- | |
| contact_phone | varchar(50) | Y | -- | -- | |
| address_line_1 | varchar(255) | Y | -- | -- | |
| address_line_2 | varchar(255) | Y | -- | -- | |
| city | varchar(100) | Y | -- | -- | |
| state | varchar(100) | Y | -- | -- | |
| postal_code | varchar(20) | Y | -- | -- | |
| country | varchar(100) | Y | `'US'` | -- | |
| website | text | Y | -- | -- | |
| notes | text | Y | -- | -- | |
| stated_lead_time_days | integer | Y | -- | -- | Supplier-provided default |
| payment_terms | varchar(100) | Y | -- | -- | e.g. "Net 30" |
| is_active | boolean | NN | `true` | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `suppliers_tenant_idx` on (tenant_id)
- `suppliers_tenant_code_idx` UNIQUE on (tenant_id, code)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 3.4 catalog.supplier_parts

Many-to-many junction between suppliers and parts, with per-link pricing and lead
time. Enables multi-sourcing: multiple suppliers for the same part.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| supplier_id | uuid | NN | -- | FK -> catalog.suppliers (CASCADE) | |
| part_id | uuid | NN | -- | FK -> catalog.parts (CASCADE) | |
| supplier_part_number | varchar(100) | Y | -- | -- | Supplier's own SKU |
| unit_cost | numeric(12,4) | Y | -- | -- | Price from this supplier |
| minimum_order_qty | integer | Y | `1` | -- | MOQ |
| lead_time_days | integer | Y | -- | -- | Supplier-specific lead time |
| is_primary | boolean | NN | `false` | -- | Primary source flag |
| is_active | boolean | NN | `true` | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `supplier_parts_tenant_supplier_part_idx` UNIQUE on (tenant_id, supplier_id, part_id)
- `supplier_parts_tenant_idx` on (tenant_id)
- `supplier_parts_part_idx` on (part_id)
- `supplier_parts_supplier_idx` on (supplier_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 3.5 catalog.bom_items

Single-level Bill of Materials. Defines parent-child relationships between parts.
Multi-level BOM is resolved by recursive traversal at the application layer.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| parent_part_id | uuid | NN | -- | FK -> catalog.parts (CASCADE) | Assembly/parent |
| child_part_id | uuid | NN | -- | FK -> catalog.parts (RESTRICT) | Component/child |
| quantity_per | numeric(10,4) | NN | -- | -- | Qty of child per 1 parent |
| sort_order | integer | Y | `0` | -- | Display order in BOM list |
| notes | text | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `bom_items_parent_child_idx` UNIQUE on (tenant_id, parent_part_id, child_part_id)
- `bom_items_tenant_idx` on (tenant_id)
- `bom_items_parent_idx` on (parent_part_id)
- `bom_items_child_idx` on (child_part_id)

**Tenant isolation:** Filtered by `tenant_id`.

**Note on RESTRICT:** The `child_part_id` FK uses `ON DELETE RESTRICT` to prevent
accidental deletion of parts that are used as components in BOMs.

---

## 4. Schema: kanban

### 4.1 kanban.kanban_loops

A loop defines the Kanban replenishment cycle for a specific part at a specific
facility. The loop type determines what kind of order it triggers.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| part_id | uuid | NN | -- | FK-app -> catalog.parts | |
| facility_id | uuid | NN | -- | FK-app -> locations.facilities | Consuming facility |
| storage_location_id | uuid | Y | -- | FK-app -> locations.storage_locations | Specific bin/shelf |
| loop_type | enum loop_type | NN | -- | UK(tenant_id, part_id, facility_id, loop_type) | |
| card_mode | enum card_mode | NN | `'single'` | -- | Single vs multi-card |
| min_quantity | integer | NN | -- | -- | Reorder point |
| order_quantity | integer | NN | -- | -- | Qty per replenishment |
| number_of_cards | integer | NN | `1` | -- | Cards in this loop |
| safety_stock_days | numeric(5,1) | Y | `'0'` | -- | Buffer days |
| primary_supplier_id | uuid | Y | -- | FK-app -> catalog.suppliers | For procurement loops |
| source_facility_id | uuid | Y | -- | FK-app -> locations.facilities | For transfer loops |
| stated_lead_time_days | integer | Y | -- | -- | Initial lead time estimate |
| is_active | boolean | NN | `true` | -- | |
| notes | text | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `loop_type`:** `procurement` (triggers POs), `production` (triggers WOs),
`transfer` (triggers TOs)

**Enum `card_mode`:** `single`, `multi`

**Indexes:**
- `kanban_loops_unique_idx` UNIQUE on (tenant_id, part_id, facility_id, loop_type)
- `kanban_loops_tenant_idx` on (tenant_id)
- `kanban_loops_part_idx` on (part_id)
- `kanban_loops_facility_idx` on (facility_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 4.2 kanban.kanban_cards

The physical/digital Kanban card. The UUID is the immutable identity printed on the
QR code. A card cycles through stages within its parent loop.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | The QR code UUID |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| loop_id | uuid | NN | -- | FK -> kanban.kanban_loops (CASCADE) | Parent loop |
| card_number | integer | NN | `1` | UK(loop_id, card_number) | "Card X of Y" |
| current_stage | enum card_stage | NN | `'created'` | -- | |
| current_stage_entered_at | timestamptz | NN | `now()` | -- | Time in current stage |
| linked_purchase_order_id | uuid | Y | -- | FK-app -> orders.purchase_orders | Set at 'ordered' stage |
| linked_work_order_id | uuid | Y | -- | FK-app -> orders.work_orders | Set at 'ordered' stage |
| linked_transfer_order_id | uuid | Y | -- | FK-app -> orders.transfer_orders | Set at 'ordered' stage |
| last_printed_at | timestamptz | Y | -- | -- | |
| print_count | integer | NN | `0` | -- | |
| completed_cycles | integer | NN | `0` | -- | Lifetime cycle count |
| is_active | boolean | NN | `true` | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `card_stage`:** `created`, `triggered`, `ordered`, `in_transit`, `received`,
`restocked`

**Indexes:**
- `kanban_cards_loop_number_idx` UNIQUE on (loop_id, card_number)
- `kanban_cards_tenant_idx` on (tenant_id)
- `kanban_cards_loop_idx` on (loop_id)
- `kanban_cards_stage_idx` on (tenant_id, current_stage)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 4.3 kanban.card_stage_transitions

**Immutable append-only audit table.** Every stage change on every card is recorded
here. This is the source of truth for velocity/lead-time calculations and cycle
analysis by the ReLoWiSa engine.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| card_id | uuid | NN | -- | FK -> kanban.kanban_cards (CASCADE) | |
| loop_id | uuid | NN | -- | FK -> kanban.kanban_loops (CASCADE) | Denormalized for fast queries |
| cycle_number | integer | NN | -- | -- | Which cycle this belongs to |
| from_stage | enum card_stage | Y | -- | -- | Null for initial creation |
| to_stage | enum card_stage | NN | -- | -- | |
| transitioned_at | timestamptz | NN | `now()` | -- | When the transition happened |
| transitioned_by_user_id | uuid | Y | -- | FK-app -> auth.users | Null for system actions |
| method | varchar(50) | NN | `'manual'` | -- | 'qr_scan', 'manual', 'system' |
| notes | text | Y | -- | -- | |
| metadata | jsonb | Y | `{}` | -- | Extensible context |

**No `updated_at`** -- this table is append-only; rows are never updated.

**Indexes:**
- `card_transitions_tenant_idx` on (tenant_id)
- `card_transitions_card_idx` on (card_id)
- `card_transitions_loop_idx` on (loop_id)
- `card_transitions_time_idx` on (transitioned_at)
- `card_transitions_cycle_idx` on (card_id, cycle_number)

**Tenant isolation:** Filtered by `tenant_id`.

**Partitioning candidate:** This table grows unboundedly. See index-strategy.md
for partitioning recommendations.

---

### 4.4 kanban.kanban_parameter_history

Tracks every change to loop parameters (min qty, order qty, number of cards).
Used to correlate parameter changes with performance outcomes.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| loop_id | uuid | NN | -- | FK -> kanban.kanban_loops (CASCADE) | |
| change_type | varchar(50) | NN | -- | -- | 'manual', 'relowisa_approved', 'system' |
| previous_min_quantity | integer | Y | -- | -- | |
| new_min_quantity | integer | Y | -- | -- | |
| previous_order_quantity | integer | Y | -- | -- | |
| new_order_quantity | integer | Y | -- | -- | |
| previous_number_of_cards | integer | Y | -- | -- | |
| new_number_of_cards | integer | Y | -- | -- | |
| reason | text | Y | -- | -- | Human-readable justification |
| changed_by_user_id | uuid | Y | -- | FK-app -> auth.users | |
| created_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `param_history_tenant_idx` on (tenant_id)
- `param_history_loop_idx` on (loop_id)
- `param_history_time_idx` on (created_at)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 4.5 kanban.relowisa_recommendations

AI/algorithm-generated recommendations for optimizing kanban loop parameters.
Users review and approve/reject recommendations.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| loop_id | uuid | NN | -- | FK -> kanban.kanban_loops (CASCADE) | |
| status | varchar(50) | NN | `'pending'` | -- | pending/approved/rejected/expired |
| recommended_min_quantity | integer | Y | -- | -- | |
| recommended_order_quantity | integer | Y | -- | -- | |
| recommended_number_of_cards | integer | Y | -- | -- | |
| confidence_score | numeric(5,2) | Y | -- | -- | 0.00 to 100.00 |
| reasoning | text | Y | -- | -- | AI/algorithm explanation |
| data_points_used | integer | Y | -- | -- | Number of cycles analyzed |
| projected_impact | jsonb | Y | `{}` | -- | `ReloWisaImpact` shape |
| reviewed_by_user_id | uuid | Y | -- | FK-app -> auth.users | |
| reviewed_at | timestamptz | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |

**ReloWisaImpact JSON shape:**
```typescript
interface ReloWisaImpact {
  estimatedStockoutReduction?: number;  // percentage
  estimatedCarryingCostChange?: number; // percentage
  estimatedTurnImprovement?: number;    // ratio
}
```

**Indexes:**
- `relowisa_tenant_idx` on (tenant_id)
- `relowisa_loop_idx` on (loop_id)
- `relowisa_status_idx` on (tenant_id, status)

**Tenant isolation:** Filtered by `tenant_id`.

---

## 5. Schema: orders

### 5.1 orders.purchase_orders

External purchase orders sent to suppliers. Typically triggered by a kanban card
in a procurement loop reaching the "triggered" stage.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| po_number | varchar(50) | NN | -- | UK(tenant_id, po_number) | Auto-generated or manual |
| supplier_id | uuid | NN | -- | FK-app -> catalog.suppliers | |
| facility_id | uuid | NN | -- | FK-app -> locations.facilities | Receiving facility |
| status | enum po_status | NN | `'draft'` | -- | See enum below |
| order_date | timestamptz | Y | -- | -- | |
| expected_delivery_date | timestamptz | Y | -- | -- | |
| actual_delivery_date | timestamptz | Y | -- | -- | |
| subtotal | numeric(12,2) | Y | `'0'` | -- | |
| tax_amount | numeric(12,2) | Y | `'0'` | -- | |
| shipping_amount | numeric(12,2) | Y | `'0'` | -- | |
| total_amount | numeric(12,2) | Y | `'0'` | -- | |
| currency | varchar(3) | Y | `'USD'` | -- | ISO 4217 |
| notes | text | Y | -- | -- | Visible to supplier |
| internal_notes | text | Y | -- | -- | Internal only |
| sent_at | timestamptz | Y | -- | -- | When PO was sent to supplier |
| sent_to_email | varchar(255) | Y | -- | -- | |
| cancelled_at | timestamptz | Y | -- | -- | |
| cancel_reason | text | Y | -- | -- | |
| created_by_user_id | uuid | Y | -- | FK-app -> auth.users | |
| approved_by_user_id | uuid | Y | -- | FK-app -> auth.users | |
| approved_at | timestamptz | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `po_status`:** `draft`, `pending_approval`, `approved`, `sent`,
`acknowledged`, `partially_received`, `received`, `closed`, `cancelled`

**Indexes:**
- `po_tenant_number_idx` UNIQUE on (tenant_id, po_number)
- `po_tenant_idx` on (tenant_id)
- `po_supplier_idx` on (supplier_id)
- `po_status_idx` on (tenant_id, status)
- `po_facility_idx` on (facility_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 5.2 orders.purchase_order_lines

Individual line items on a PO. Each line may be linked to the kanban card that
triggered it.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| purchase_order_id | uuid | NN | -- | FK -> orders.purchase_orders (CASCADE) | |
| part_id | uuid | NN | -- | FK-app -> catalog.parts | |
| kanban_card_id | uuid | Y | -- | FK-app -> kanban.kanban_cards | Triggering card |
| line_number | integer | NN | -- | -- | Sequential within PO |
| quantity_ordered | integer | NN | -- | -- | |
| quantity_received | integer | NN | `0` | -- | Partial receiving support |
| unit_cost | numeric(12,4) | NN | -- | -- | |
| line_total | numeric(12,2) | NN | -- | -- | qty * unit_cost |
| notes | text | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `po_lines_tenant_idx` on (tenant_id)
- `po_lines_po_idx` on (purchase_order_id)
- `po_lines_part_idx` on (part_id)
- `po_lines_card_idx` on (kanban_card_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 5.3 orders.work_centers

Production work centers (machines, cells, lines) within a facility.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| facility_id | uuid | NN | -- | FK-app -> locations.facilities | |
| name | varchar(255) | NN | -- | -- | |
| code | varchar(50) | NN | -- | UK(tenant_id, code) | |
| description | text | Y | -- | -- | |
| capacity_per_hour | numeric(10,2) | Y | -- | -- | |
| cost_per_hour | numeric(10,2) | Y | -- | -- | |
| is_active | boolean | NN | `true` | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `work_centers_tenant_code_idx` UNIQUE on (tenant_id, code)
- `work_centers_tenant_idx` on (tenant_id)
- `work_centers_facility_idx` on (facility_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 5.4 orders.work_orders

Internal production orders. Triggered by kanban cards in production loops.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| wo_number | varchar(50) | NN | -- | UK(tenant_id, wo_number) | |
| part_id | uuid | NN | -- | FK-app -> catalog.parts | Part being produced |
| facility_id | uuid | NN | -- | FK-app -> locations.facilities | |
| status | enum wo_status | NN | `'draft'` | -- | See enum below |
| quantity_to_produce | integer | NN | -- | -- | |
| quantity_produced | integer | NN | `0` | -- | |
| quantity_rejected | integer | NN | `0` | -- | |
| scheduled_start_date | timestamptz | Y | -- | -- | |
| scheduled_end_date | timestamptz | Y | -- | -- | |
| actual_start_date | timestamptz | Y | -- | -- | |
| actual_end_date | timestamptz | Y | -- | -- | |
| priority | integer | NN | `0` | -- | Higher = more urgent |
| notes | text | Y | -- | -- | |
| kanban_card_id | uuid | Y | -- | FK-app -> kanban.kanban_cards | |
| created_by_user_id | uuid | Y | -- | FK-app -> auth.users | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `wo_status`:** `draft`, `scheduled`, `in_progress`, `on_hold`, `completed`,
`cancelled`

**Indexes:**
- `wo_tenant_number_idx` UNIQUE on (tenant_id, wo_number)
- `wo_tenant_idx` on (tenant_id)
- `wo_part_idx` on (part_id)
- `wo_status_idx` on (tenant_id, status)
- `wo_facility_idx` on (facility_id)
- `wo_card_idx` on (kanban_card_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 5.5 orders.work_order_routings

Ordered steps in the production process for a work order. Each step is performed
at a work center.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| work_order_id | uuid | NN | -- | FK -> orders.work_orders (CASCADE) | |
| work_center_id | uuid | NN | -- | FK -> orders.work_centers | No cascade |
| step_number | integer | NN | -- | UK(work_order_id, step_number) | Unique per WO |
| operation_name | varchar(255) | NN | -- | -- | |
| status | enum routing_step_status | NN | `'pending'` | -- | See enum below |
| estimated_minutes | integer | Y | -- | -- | |
| actual_minutes | integer | Y | -- | -- | |
| started_at | timestamptz | Y | -- | -- | |
| completed_at | timestamptz | Y | -- | -- | |
| notes | text | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `routing_step_status`:** `pending`, `in_progress`, `complete`, `on_hold`,
`skipped`

**Indexes:**
- `wo_routing_step_idx` UNIQUE on (work_order_id, step_number)
- `wo_routing_tenant_idx` on (tenant_id)
- `wo_routing_wo_idx` on (work_order_id)
- `wo_routing_wc_idx` on (work_center_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 5.6 orders.transfer_orders

Inter-facility inventory transfers. Triggered by kanban cards in transfer loops.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| to_number | varchar(50) | NN | -- | UK(tenant_id, to_number) | |
| source_facility_id | uuid | NN | -- | FK-app -> locations.facilities | |
| destination_facility_id | uuid | NN | -- | FK-app -> locations.facilities | |
| status | enum transfer_status | NN | `'draft'` | -- | See enum below |
| requested_date | timestamptz | Y | -- | -- | |
| shipped_date | timestamptz | Y | -- | -- | |
| received_date | timestamptz | Y | -- | -- | |
| notes | text | Y | -- | -- | |
| kanban_card_id | uuid | Y | -- | FK-app -> kanban.kanban_cards | |
| created_by_user_id | uuid | Y | -- | FK-app -> auth.users | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `transfer_status`:** `draft`, `requested`, `approved`, `picking`, `shipped`,
`in_transit`, `received`, `closed`, `cancelled`

**Indexes:**
- `to_tenant_number_idx` UNIQUE on (tenant_id, to_number)
- `to_tenant_idx` on (tenant_id)
- `to_source_facility_idx` on (source_facility_id)
- `to_dest_facility_idx` on (destination_facility_id)
- `to_status_idx` on (tenant_id, status)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 5.7 orders.transfer_order_lines

Line items on a transfer order.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| transfer_order_id | uuid | NN | -- | FK -> orders.transfer_orders (CASCADE) | |
| part_id | uuid | NN | -- | FK-app -> catalog.parts | |
| quantity_requested | integer | NN | -- | -- | |
| quantity_shipped | integer | NN | `0` | -- | |
| quantity_received | integer | NN | `0` | -- | |
| notes | text | Y | -- | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `to_lines_tenant_idx` on (tenant_id)
- `to_lines_to_idx` on (transfer_order_id)
- `to_lines_part_idx` on (part_id)

**Tenant isolation:** Filtered by `tenant_id`.

---

## 6. Schema: notifications

### 6.1 notifications.notifications

In-app and external notifications delivered to users.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| user_id | uuid | NN | -- | FK-app -> auth.users | Recipient |
| type | enum notification_type | NN | -- | -- | See enum below |
| title | varchar(255) | NN | -- | -- | |
| body | text | NN | -- | -- | |
| is_read | boolean | NN | `false` | -- | |
| read_at | timestamptz | Y | -- | -- | |
| action_url | text | Y | -- | -- | Deep link into app |
| metadata | jsonb | Y | `{}` | -- | Extensible context |
| created_at | timestamptz | NN | `now()` | -- | |

**Enum `notification_type`:** `card_triggered`, `po_created`, `po_sent`,
`po_received`, `stockout_warning`, `relowisa_recommendation`, `exception_alert`,
`wo_status_change`, `transfer_status_change`, `system_alert`

**Indexes:**
- `notifications_tenant_idx` on (tenant_id)
- `notifications_user_idx` on (user_id)
- `notifications_user_unread_idx` on (user_id, is_read)
- `notifications_time_idx` on (created_at)

**Tenant isolation:** Filtered by `tenant_id`.

---

### 6.2 notifications.notification_preferences

Per-user, per-type, per-channel notification opt-in/out settings.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| user_id | uuid | NN | -- | FK-app -> auth.users | |
| notification_type | enum notification_type | NN | -- | -- | |
| channel | enum notification_channel | NN | -- | -- | See enum below |
| is_enabled | boolean | NN | `true` | -- | |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**Enum `notification_channel`:** `in_app`, `email`, `webhook`

**Indexes:**
- `notif_prefs_user_idx` on (user_id)
- `notif_prefs_tenant_idx` on (tenant_id)

**Tenant isolation:** Filtered by `tenant_id`.

**Missing constraint (recommended):** A UNIQUE constraint on
`(user_id, notification_type, channel)` should be added to prevent duplicate
preference rows.

---

## 7. Schema: billing

### 7.1 billing.subscription_plans

Global lookup table defining available subscription tiers. NOT tenant-scoped.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | varchar(50) | NN | -- | PK | 'free', 'starter', 'pro', 'enterprise' |
| name | varchar(100) | NN | -- | -- | Display name |
| description | text | Y | -- | -- | |
| monthly_price_cents | integer | NN | -- | -- | Price in cents |
| annual_price_cents | integer | Y | -- | -- | Annual price in cents |
| card_limit | integer | NN | -- | -- | Max kanban cards |
| seat_limit | integer | NN | -- | -- | Max users |
| card_overage_price_cents | integer | Y | -- | -- | Per additional card/month |
| seat_overage_price_cents | integer | Y | -- | -- | Per additional seat/month |
| features | jsonb | Y | `{}` | -- | `PlanFeatures` shape |
| stripe_price_id_monthly | varchar(255) | Y | -- | -- | Stripe price ID |
| stripe_price_id_annual | varchar(255) | Y | -- | -- | Stripe price ID |
| is_active | boolean | NN | `true` | -- | |
| sort_order | integer | Y | `0` | -- | Display ordering |
| created_at | timestamptz | NN | `now()` | -- | |
| updated_at | timestamptz | NN | `now()` | -- | |

**PlanFeatures JSON shape:**
```typescript
interface PlanFeatures {
  multiLocation?: boolean;
  productionKanban?: boolean;
  transferKanban?: boolean;
  reloWisa?: boolean;
  ecommerceApi?: boolean;
  scheduledReports?: boolean;
  sso?: boolean;
  webhooks?: boolean;
  customBranding?: boolean;
  prioritySupport?: boolean;
}
```

**Indexes:** None (small lookup table, 4 rows).

**Tenant isolation:** NONE. This is a global table shared across all tenants.

---

### 7.2 billing.usage_records

Metered billing data per tenant per billing period.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| period_start | timestamptz | NN | -- | -- | Billing period start |
| period_end | timestamptz | NN | -- | -- | Billing period end |
| card_count | integer | NN | `0` | -- | Total active cards |
| seat_count | integer | NN | `0` | -- | Total active seats |
| card_overage | integer | NN | `0` | -- | Cards over limit |
| seat_overage | integer | NN | `0` | -- | Seats over limit |
| reported_to_stripe | boolean | NN | `false` | -- | Sync flag |
| stripe_usage_record_id | varchar(255) | Y | -- | -- | Stripe reference |
| created_at | timestamptz | NN | `now()` | -- | |

**Indexes:**
- `usage_tenant_idx` on (tenant_id)
- `usage_period_idx` on (tenant_id, period_start)

**Tenant isolation:** Filtered by `tenant_id`.

---

## 8. Schema: audit

### 8.1 audit.audit_log

**Immutable append-only log.** Every significant action in the system generates
a row here. No updates, no deletes -- ever.

| Column | Type | Null | Default | Constraints | Notes |
|---|---|---|---|---|---|
| id | uuid | NN | `gen_random_uuid()` | PK | |
| tenant_id | uuid | NN | -- | FK-app -> auth.tenants | Tenant scope |
| user_id | uuid | Y | -- | FK-app -> auth.users | Null for system actions |
| action | varchar(100) | NN | -- | -- | e.g. 'card.triggered', 'po.created' |
| entity_type | varchar(100) | NN | -- | -- | e.g. 'kanban_card', 'purchase_order' |
| entity_id | uuid | Y | -- | -- | ID of the affected entity |
| previous_state | jsonb | Y | -- | -- | Snapshot before change |
| new_state | jsonb | Y | -- | -- | Snapshot after change |
| metadata | jsonb | Y | `{}` | -- | Extensible context |
| ip_address | varchar(45) | Y | -- | -- | IPv4 or IPv6 |
| user_agent | text | Y | -- | -- | |
| timestamp | timestamptz | NN | `now()` | -- | Event time |

**Indexes:**
- `audit_tenant_idx` on (tenant_id)
- `audit_user_idx` on (user_id)
- `audit_entity_idx` on (entity_type, entity_id)
- `audit_action_idx` on (action)
- `audit_time_idx` on (timestamp)
- `audit_tenant_time_idx` on (tenant_id, timestamp)

**Tenant isolation:** Filtered by `tenant_id`.

**Partitioning candidate:** This table grows unboundedly. See index-strategy.md
for range-partitioning recommendations on the `timestamp` column.

---

## Appendix: Enum Registry

| Enum Name | Schema | Values |
|---|---|---|
| `user_role` | auth | tenant_admin, inventory_manager, procurement_manager, receiving_manager, ecommerce_director, salesperson, executive |
| `oauth_provider` | auth | google |
| `part_type` | catalog | raw_material, component, subassembly, finished_good, consumable, packaging, other |
| `unit_of_measure` | catalog | each, box, case, pallet, kg, lb, meter, foot, liter, gallon, roll, sheet, pair, set, other |
| `loop_type` | kanban | procurement, production, transfer |
| `card_stage` | kanban | created, triggered, ordered, in_transit, received, restocked |
| `card_mode` | kanban | single, multi |
| `po_status` | orders | draft, pending_approval, approved, sent, acknowledged, partially_received, received, closed, cancelled |
| `wo_status` | orders | draft, scheduled, in_progress, on_hold, completed, cancelled |
| `transfer_status` | orders | draft, requested, approved, picking, shipped, in_transit, received, closed, cancelled |
| `routing_step_status` | orders | pending, in_progress, complete, on_hold, skipped |
| `notification_type` | notifications | card_triggered, po_created, po_sent, po_received, stockout_warning, relowisa_recommendation, exception_alert, wo_status_change, transfer_status_change, system_alert |
| `notification_channel` | notifications | in_app, email, webhook |
