# Arda V2 -- Index Strategy

> Index design, query path analysis, partitioning considerations, and growth
> projections for the Arda data model.
> Source of truth: Drizzle ORM schema files in `packages/db/src/schema/`.
> Last updated: 2026-02-08

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Existing Index Inventory](#2-existing-index-inventory)
3. [Query Path Analysis](#3-query-path-analysis)
4. [Composite Index Design Rationale](#4-composite-index-design-rationale)
5. [Recommended Missing Indexes](#5-recommended-missing-indexes)
6. [Partitioning Strategy](#6-partitioning-strategy)
7. [Growth Projections at 100 Tenants](#7-growth-projections-at-100-tenants)
8. [Maintenance and Monitoring](#8-maintenance-and-monitoring)

---

## 1. Design Principles

### 1.1 Tenant-First Indexing

Every tenant-scoped query MUST filter by `tenant_id`. Therefore:

- **All composite indexes on tenant-scoped tables start with `tenant_id`** when
  the index is designed for list/filter queries. This ensures the B-tree
  efficiently narrows to a single tenant before filtering on the second column.
- Single-column indexes on `tenant_id` exist on every tenant-scoped table as a
  fallback for tenant-wide scans.
- Foreign-key lookup indexes (e.g., `supplier_id`, `facility_id`) do NOT
  necessarily include `tenant_id` because they are used for join lookups where
  the FK value is already known. The planner uses the FK index for the join and
  the tenant_id index for the WHERE clause.

### 1.2 Uniqueness Constraints as Indexes

All `UNIQUE` constraints implicitly create B-tree indexes. These serve double
duty: enforcing data integrity and supporting equality lookups.

### 1.3 Write-Optimized Append-Only Tables

Tables like `card_stage_transitions` and `audit_log` are append-only (no updates).
Their indexes are tuned for:
- Time-range scans (most recent first)
- Entity-specific lookups (all transitions for a card)
- Aggregate queries (cycle time calculations)

These tables do NOT need indexes on columns that are never used in WHERE/JOIN.

### 1.4 UUID Primary Keys

All tables use `uuid` primary keys with `gen_random_uuid()`. The B-tree index on
the PK handles point lookups. UUIDs are random, so inserts distribute uniformly
across the index -- no hot-spot issues, but slightly worse cache locality compared
to sequential IDs. This trade-off is acceptable for the expected scale.

---

## 2. Existing Index Inventory

### 2.1 Schema: auth

| Table | Index Name | Columns | Type | Query Path |
|---|---|---|---|---|
| tenants | PK | id | B-tree unique | Point lookup by ID |
| tenants | slug (inline unique) | slug | B-tree unique | Login/URL resolution |
| tenants | tenants_slug_idx | slug | B-tree | Redundant with inline unique |
| tenants | tenants_stripe_customer_idx | stripe_customer_id | B-tree | Stripe webhook lookup |
| users | PK | id | B-tree unique | Point lookup by ID |
| users | users_tenant_email_idx | (tenant_id, email) | B-tree unique | Login: find user by tenant+email |
| users | users_tenant_idx | tenant_id | B-tree | List users for a tenant |
| users | users_email_idx | email | B-tree | Cross-tenant email lookup (admin) |
| oauth_accounts | PK | id | B-tree unique | Point lookup |
| oauth_accounts | oauth_provider_account_idx | (provider, provider_account_id) | B-tree unique | OAuth login flow |
| oauth_accounts | oauth_user_idx | user_id | B-tree | List OAuth links for user |
| refresh_tokens | PK | id | B-tree unique | Point lookup |
| refresh_tokens | token_hash (inline unique) | token_hash | B-tree unique | Token validation |
| refresh_tokens | refresh_tokens_user_idx | user_id | B-tree | List/revoke tokens for user |
| refresh_tokens | refresh_tokens_hash_idx | token_hash | B-tree | Redundant with inline unique |

### 2.2 Schema: locations

| Table | Index Name | Columns | Type | Query Path |
|---|---|---|---|---|
| facilities | PK | id | B-tree unique | Point lookup |
| facilities | facilities_tenant_code_idx | (tenant_id, code) | B-tree unique | Lookup facility by code |
| facilities | facilities_tenant_idx | tenant_id | B-tree | List facilities for tenant |
| storage_locations | PK | id | B-tree unique | Point lookup |
| storage_locations | storage_locations_tenant_facility_code_idx | (tenant_id, facility_id, code) | B-tree unique | Lookup by facility+code |
| storage_locations | storage_locations_tenant_idx | tenant_id | B-tree | List all storage locations |
| storage_locations | storage_locations_facility_idx | facility_id | B-tree | List locations in facility |

### 2.3 Schema: catalog

| Table | Index Name | Columns | Type | Query Path |
|---|---|---|---|---|
| part_categories | PK | id | B-tree unique | Point lookup |
| part_categories | part_categories_tenant_idx | tenant_id | B-tree | List categories |
| part_categories | part_categories_tenant_name_idx | (tenant_id, name) | B-tree unique | Lookup by name |
| parts | PK | id | B-tree unique | Point lookup |
| parts | parts_tenant_partnumber_idx | (tenant_id, part_number) | B-tree unique | Lookup by part number |
| parts | parts_tenant_idx | tenant_id | B-tree | List all parts |
| parts | parts_category_idx | category_id | B-tree | Parts by category |
| parts | parts_upc_idx | upc_barcode | B-tree | Barcode scan lookup |
| parts | parts_sellable_idx | (tenant_id, is_sellable) | B-tree | eCommerce product API |
| suppliers | PK | id | B-tree unique | Point lookup |
| suppliers | suppliers_tenant_idx | tenant_id | B-tree | List suppliers |
| suppliers | suppliers_tenant_code_idx | (tenant_id, code) | B-tree unique | Lookup by code |
| supplier_parts | PK | id | B-tree unique | Point lookup |
| supplier_parts | supplier_parts_tenant_supplier_part_idx | (tenant_id, supplier_id, part_id) | B-tree unique | Prevent duplicate links |
| supplier_parts | supplier_parts_tenant_idx | tenant_id | B-tree | List all supplier-parts |
| supplier_parts | supplier_parts_part_idx | part_id | B-tree | Find suppliers for a part |
| supplier_parts | supplier_parts_supplier_idx | supplier_id | B-tree | Find parts for a supplier |
| bom_items | PK | id | B-tree unique | Point lookup |
| bom_items | bom_items_parent_child_idx | (tenant_id, parent_part_id, child_part_id) | B-tree unique | Prevent duplicate BOM links |
| bom_items | bom_items_tenant_idx | tenant_id | B-tree | List all BOM items |
| bom_items | bom_items_parent_idx | parent_part_id | B-tree | BOM explosion (children) |
| bom_items | bom_items_child_idx | child_part_id | B-tree | Where-used query |

### 2.4 Schema: kanban

| Table | Index Name | Columns | Type | Query Path |
|---|---|---|---|---|
| kanban_loops | PK | id | B-tree unique | Point lookup |
| kanban_loops | kanban_loops_unique_idx | (tenant_id, part_id, facility_id, loop_type) | B-tree unique | Prevent duplicate loops |
| kanban_loops | kanban_loops_tenant_idx | tenant_id | B-tree | List loops for tenant |
| kanban_loops | kanban_loops_part_idx | part_id | B-tree | Loops for a part |
| kanban_loops | kanban_loops_facility_idx | facility_id | B-tree | Loops at a facility |
| kanban_cards | PK | id | B-tree unique | Point lookup / QR scan |
| kanban_cards | kanban_cards_loop_number_idx | (loop_id, card_number) | B-tree unique | "Card X of Y" display |
| kanban_cards | kanban_cards_tenant_idx | tenant_id | B-tree | List cards for tenant |
| kanban_cards | kanban_cards_loop_idx | loop_id | B-tree | Cards in a loop |
| kanban_cards | kanban_cards_stage_idx | (tenant_id, current_stage) | B-tree | Order queue filtering |
| card_stage_transitions | PK | id | B-tree unique | Point lookup |
| card_stage_transitions | card_transitions_tenant_idx | tenant_id | B-tree | Tenant-wide scans |
| card_stage_transitions | card_transitions_card_idx | card_id | B-tree | Card history |
| card_stage_transitions | card_transitions_loop_idx | loop_id | B-tree | Loop-wide analytics |
| card_stage_transitions | card_transitions_time_idx | transitioned_at | B-tree | Time-range queries |
| card_stage_transitions | card_transitions_cycle_idx | (card_id, cycle_number) | B-tree | Cycle-specific lookups |
| kanban_parameter_history | PK | id | B-tree unique | Point lookup |
| kanban_parameter_history | param_history_tenant_idx | tenant_id | B-tree | Tenant-wide scans |
| kanban_parameter_history | param_history_loop_idx | loop_id | B-tree | History for a loop |
| kanban_parameter_history | param_history_time_idx | created_at | B-tree | Time-range queries |
| relowisa_recommendations | PK | id | B-tree unique | Point lookup |
| relowisa_recommendations | relowisa_tenant_idx | tenant_id | B-tree | Tenant-wide scans |
| relowisa_recommendations | relowisa_loop_idx | loop_id | B-tree | Recs for a loop |
| relowisa_recommendations | relowisa_status_idx | (tenant_id, status) | B-tree | Pending review dashboard |

### 2.5 Schema: orders

| Table | Index Name | Columns | Type | Query Path |
|---|---|---|---|---|
| purchase_orders | PK | id | B-tree unique | Point lookup |
| purchase_orders | po_tenant_number_idx | (tenant_id, po_number) | B-tree unique | PO lookup by number |
| purchase_orders | po_tenant_idx | tenant_id | B-tree | List POs for tenant |
| purchase_orders | po_supplier_idx | supplier_id | B-tree | POs for a supplier |
| purchase_orders | po_status_idx | (tenant_id, status) | B-tree | PO list filtered by status |
| purchase_orders | po_facility_idx | facility_id | B-tree | POs for a facility |
| purchase_order_lines | PK | id | B-tree unique | Point lookup |
| purchase_order_lines | po_lines_tenant_idx | tenant_id | B-tree | Tenant scan |
| purchase_order_lines | po_lines_po_idx | purchase_order_id | B-tree | Lines for a PO |
| purchase_order_lines | po_lines_part_idx | part_id | B-tree | PO lines for a part |
| purchase_order_lines | po_lines_card_idx | kanban_card_id | B-tree | Lines linked to a card |
| work_centers | PK | id | B-tree unique | Point lookup |
| work_centers | work_centers_tenant_code_idx | (tenant_id, code) | B-tree unique | Lookup by code |
| work_centers | work_centers_tenant_idx | tenant_id | B-tree | List work centers |
| work_centers | work_centers_facility_idx | facility_id | B-tree | Work centers at facility |
| work_orders | PK | id | B-tree unique | Point lookup |
| work_orders | wo_tenant_number_idx | (tenant_id, wo_number) | B-tree unique | WO lookup by number |
| work_orders | wo_tenant_idx | tenant_id | B-tree | List WOs for tenant |
| work_orders | wo_part_idx | part_id | B-tree | WOs for a part |
| work_orders | wo_status_idx | (tenant_id, status) | B-tree | WO list by status |
| work_orders | wo_facility_idx | facility_id | B-tree | WOs at facility |
| work_orders | wo_card_idx | kanban_card_id | B-tree | WO linked to card |
| work_order_routings | PK | id | B-tree unique | Point lookup |
| work_order_routings | wo_routing_step_idx | (work_order_id, step_number) | B-tree unique | Step ordering |
| work_order_routings | wo_routing_tenant_idx | tenant_id | B-tree | Tenant scan |
| work_order_routings | wo_routing_wo_idx | work_order_id | B-tree | Steps for a WO |
| work_order_routings | wo_routing_wc_idx | work_center_id | B-tree | Routings at work center |
| transfer_orders | PK | id | B-tree unique | Point lookup |
| transfer_orders | to_tenant_number_idx | (tenant_id, to_number) | B-tree unique | TO lookup by number |
| transfer_orders | to_tenant_idx | tenant_id | B-tree | List TOs for tenant |
| transfer_orders | to_source_facility_idx | source_facility_id | B-tree | TOs from a facility |
| transfer_orders | to_dest_facility_idx | destination_facility_id | B-tree | TOs to a facility |
| transfer_orders | to_status_idx | (tenant_id, status) | B-tree | TO list by status |
| transfer_order_lines | PK | id | B-tree unique | Point lookup |
| transfer_order_lines | to_lines_tenant_idx | tenant_id | B-tree | Tenant scan |
| transfer_order_lines | to_lines_to_idx | transfer_order_id | B-tree | Lines for a TO |
| transfer_order_lines | to_lines_part_idx | part_id | B-tree | TO lines for a part |

### 2.6 Schema: notifications

| Table | Index Name | Columns | Type | Query Path |
|---|---|---|---|---|
| notifications | PK | id | B-tree unique | Point lookup |
| notifications | notifications_tenant_idx | tenant_id | B-tree | Tenant scan |
| notifications | notifications_user_idx | user_id | B-tree | All notifications for user |
| notifications | notifications_user_unread_idx | (user_id, is_read) | B-tree | Unread badge count |
| notifications | notifications_time_idx | created_at | B-tree | Global time ordering |
| notification_preferences | PK | id | B-tree unique | Point lookup |
| notification_preferences | notif_prefs_user_idx | user_id | B-tree | Preferences for user |
| notification_preferences | notif_prefs_tenant_idx | tenant_id | B-tree | Tenant scan |

### 2.7 Schema: billing

| Table | Index Name | Columns | Type | Query Path |
|---|---|---|---|---|
| subscription_plans | PK | id | B-tree unique | Plan lookup |
| usage_records | PK | id | B-tree unique | Point lookup |
| usage_records | usage_tenant_idx | tenant_id | B-tree | Records for tenant |
| usage_records | usage_period_idx | (tenant_id, period_start) | B-tree | Billing period lookup |

### 2.8 Schema: audit

| Table | Index Name | Columns | Type | Query Path |
|---|---|---|---|---|
| audit_log | PK | id | B-tree unique | Point lookup |
| audit_log | audit_tenant_idx | tenant_id | B-tree | Tenant scan |
| audit_log | audit_user_idx | user_id | B-tree | Actions by user |
| audit_log | audit_entity_idx | (entity_type, entity_id) | B-tree | History for an entity |
| audit_log | audit_action_idx | action | B-tree | Filter by action type |
| audit_log | audit_time_idx | timestamp | B-tree | Global time ordering |
| audit_log | audit_tenant_time_idx | (tenant_id, timestamp) | B-tree | Tenant audit log (primary) |

**Total existing indexes: 84** (including primary keys).

---

## 3. Query Path Analysis

This section maps every expected query path to the index that serves it, and
identifies gaps.

### 3.1 Kanban Core Loop

| Query | Table(s) | Index Used | Notes |
|---|---|---|---|
| List loops for tenant + facility | kanban_loops | kanban_loops_facility_idx then filter tenant_id | See recommendation R-1 |
| List active cards by tenant + stage (Order Queue) | kanban_cards | kanban_cards_stage_idx (tenant_id, current_stage) | Primary dashboard query |
| List cards by loop | kanban_cards | kanban_cards_loop_idx | |
| QR scan: find card by UUID | kanban_cards | PK (id) | Single-row lookup |
| Card velocity: transitions for card by cycle | card_stage_transitions | card_transitions_cycle_idx (card_id, cycle_number) | |
| Card history: all transitions for card, ordered by time | card_stage_transitions | card_transitions_card_idx + sort on transitioned_at | |
| Loop velocity: all transitions for loop, time range | card_stage_transitions | card_transitions_loop_idx + filter on transitioned_at | See recommendation R-2 |
| Pending ReLoWiSa recommendations | relowisa_recommendations | relowisa_status_idx (tenant_id, status) | status = 'pending' |

### 3.2 Order Management

| Query | Table(s) | Index Used | Notes |
|---|---|---|---|
| PO list by tenant + status | purchase_orders | po_status_idx (tenant_id, status) | |
| PO list by supplier | purchase_orders | po_supplier_idx | |
| PO detail (with lines) | purchase_orders + purchase_order_lines | PK + po_lines_po_idx | |
| WO list by tenant + status | work_orders | wo_status_idx (tenant_id, status) | |
| WO list by facility | work_orders | wo_facility_idx | |
| WO detail (with routings) | work_orders + work_order_routings | PK + wo_routing_wo_idx | |
| TO list by tenant + status | transfer_orders | to_status_idx (tenant_id, status) | |
| Find PO lines for a card | purchase_order_lines | po_lines_card_idx | |

### 3.3 Catalog and Master Data

| Query | Table(s) | Index Used | Notes |
|---|---|---|---|
| Parts list for tenant (paginated) | parts | parts_tenant_idx | |
| Parts by category | parts | parts_category_idx | |
| Sellable parts for eCommerce API | parts | parts_sellable_idx (tenant_id, is_sellable) | |
| Part lookup by part_number | parts | parts_tenant_partnumber_idx | |
| Barcode scan | parts | parts_upc_idx | |
| Suppliers for a part | supplier_parts | supplier_parts_part_idx | |
| Parts for a supplier | supplier_parts | supplier_parts_supplier_idx | |
| BOM explosion (children of parent) | bom_items | bom_items_parent_idx | |
| Where-used (parents of child) | bom_items | bom_items_child_idx | |

### 3.4 Notifications

| Query | Table(s) | Index Used | Notes |
|---|---|---|---|
| Unread count for user | notifications | notifications_user_unread_idx (user_id, is_read) | WHERE is_read = false |
| Notification list for user, ordered by time | notifications | notifications_user_idx + sort on created_at | See recommendation R-3 |
| User preferences for a notification type | notification_preferences | notif_prefs_user_idx | |

### 3.5 Audit

| Query | Table(s) | Index Used | Notes |
|---|---|---|---|
| Audit log for tenant, time range | audit_log | audit_tenant_time_idx (tenant_id, timestamp) | Primary audit query |
| Audit log for specific entity | audit_log | audit_entity_idx (entity_type, entity_id) | |
| Audit log by action type | audit_log | audit_action_idx | |
| Audit log by user | audit_log | audit_user_idx | |

---

## 4. Composite Index Design Rationale

### 4.1 Tenant-Leading Composites

Indexes like `(tenant_id, status)`, `(tenant_id, po_number)`, and
`(tenant_id, part_number)` are the workhorses of the system. They follow the
**equality-first** principle: `tenant_id` is always an equality predicate, so it
comes first. The second column supports either:

- **Equality** (status filtering, number lookup) -- full index seek
- **Range** (time-range queries on the second column) -- index range scan

### 4.2 Multi-Column Uniqueness

Indexes like `(tenant_id, part_id, facility_id, loop_type)` on kanban_loops serve
both as business-rule enforcement (no duplicate loops) and as efficient lookup paths
for the exact combination of predicates.

### 4.3 Denormalized Columns in Transition Tables

`card_stage_transitions` includes `loop_id` even though it can be derived from
`card_id -> kanban_cards.loop_id`. This deliberate denormalization:

- Avoids a JOIN when querying all transitions for a loop
- Enables the `card_transitions_loop_idx` without a covering join
- Is safe because `loop_id` is immutable for a given card

### 4.4 FK Indexes Without Tenant Prefix

Indexes like `po_supplier_idx` on `(supplier_id)` without `tenant_id` are
intentional. These indexes support:

- JOIN operations where `supplier_id` is already a known FK value
- The query planner combines this with the `po_tenant_idx` via a bitmap AND

If these FK lookups always include `tenant_id` in the WHERE clause (which they
should), the planner benefits from having both the single-column FK index and the
tenant index available for bitmap combination.

---

## 5. Recommended Missing Indexes

Based on query path analysis, the following indexes are recommended additions.

### R-1: kanban_loops -- Composite for tenant + facility listing

**Current gap:** Listing loops for a tenant at a specific facility requires an
index scan on `kanban_loops_facility_idx` (facility_id only) followed by a
recheck against `tenant_id`.

```sql
CREATE INDEX kanban_loops_tenant_facility_idx
  ON kanban.kanban_loops (tenant_id, facility_id);
```

**Rationale:** The "Kanban Board" view filters by tenant + facility. This
composite eliminates the recheck.

### R-2: card_stage_transitions -- Composite for loop + time range

**Current gap:** Loop-level velocity analytics query transitions for a specific
loop within a time range. Currently requires `card_transitions_loop_idx` (loop_id)
plus a filter on `transitioned_at`.

```sql
CREATE INDEX card_transitions_loop_time_idx
  ON kanban.card_stage_transitions (loop_id, transitioned_at);
```

**Rationale:** Supports `WHERE loop_id = ? AND transitioned_at BETWEEN ? AND ?`
with a single index range scan. Critical for ReLoWiSa velocity calculations.

### R-3: notifications -- Composite for user + time ordering

**Current gap:** Notification list query uses `notifications_user_idx` (user_id)
but must sort by `created_at` in a separate step.

```sql
CREATE INDEX notifications_user_time_idx
  ON notifications.notifications (user_id, created_at DESC);
```

**Rationale:** Eliminates the sort step for the most common notification query
("my notifications, newest first"). DESC ordering matches the expected access
pattern.

### R-4: notification_preferences -- Uniqueness constraint

**Current gap:** No unique constraint prevents duplicate preference rows for
the same (user, type, channel) combination.

```sql
CREATE UNIQUE INDEX notif_prefs_unique_idx
  ON notifications.notification_preferences (user_id, notification_type, channel);
```

**Rationale:** Data integrity. Without this, the application layer is solely
responsible for preventing duplicates.

### R-5: purchase_orders -- Composite for tenant + supplier

**Current gap:** Listing POs by supplier within a tenant requires two separate
index lookups (po_tenant_idx + po_supplier_idx via bitmap AND).

```sql
CREATE INDEX po_tenant_supplier_idx
  ON orders.purchase_orders (tenant_id, supplier_id);
```

**Rationale:** The "Supplier PO History" view always filters by tenant + supplier.

### R-6: card_stage_transitions -- Tenant + time composite

**Current gap:** Tenant-wide transition analytics (dashboard widgets showing
overall throughput) must scan `card_transitions_tenant_idx` (tenant_id) then
filter/sort by `transitioned_at`.

```sql
CREATE INDEX card_transitions_tenant_time_idx
  ON kanban.card_stage_transitions (tenant_id, transitioned_at DESC);
```

**Rationale:** Supports tenant-level analytics dashboards with time-range filters.

### R-7: Redundant index cleanup

The following indexes are redundant because their columns are covered by an
inline UNIQUE constraint on the same column:

- `tenants_slug_idx` on (slug) -- redundant with `slug` column's inline `.unique()`
- `refresh_tokens_hash_idx` on (token_hash) -- redundant with `token_hash` column's inline `.unique()`

These can be dropped to reduce write amplification and storage without affecting
query performance.

### Summary of Recommendations

| ID | Table | Index | Type | Priority |
|---|---|---|---|---|
| R-1 | kanban_loops | (tenant_id, facility_id) | B-tree | High |
| R-2 | card_stage_transitions | (loop_id, transitioned_at) | B-tree | High |
| R-3 | notifications | (user_id, created_at DESC) | B-tree | Medium |
| R-4 | notification_preferences | (user_id, notification_type, channel) | B-tree unique | High |
| R-5 | purchase_orders | (tenant_id, supplier_id) | B-tree | Medium |
| R-6 | card_stage_transitions | (tenant_id, transitioned_at DESC) | B-tree | Medium |
| R-7 | tenants, refresh_tokens | Drop redundant indexes | -- | Low |

---

## 6. Partitioning Strategy

Two tables are candidates for partitioning due to unbounded growth:
`card_stage_transitions` and `audit_log`.

### 6.1 card_stage_transitions -- Range Partitioning by Month

**Growth driver:** Every card stage change inserts a row. A single card cycle
produces 5-6 transitions (created -> triggered -> ordered -> in_transit ->
received -> restocked). Active cards cycle every 1-4 weeks.

**Partition scheme:**

```sql
-- Convert to partitioned table
CREATE TABLE kanban.card_stage_transitions (
  id uuid DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  card_id uuid NOT NULL,
  loop_id uuid NOT NULL,
  cycle_number integer NOT NULL,
  from_stage card_stage,
  to_stage card_stage NOT NULL,
  transitioned_at timestamptz NOT NULL DEFAULT now(),
  transitioned_by_user_id uuid,
  method varchar(50) NOT NULL DEFAULT 'manual',
  notes text,
  metadata jsonb DEFAULT '{}',
  PRIMARY KEY (id, transitioned_at)
) PARTITION BY RANGE (transitioned_at);

-- Monthly partitions
CREATE TABLE kanban.card_stage_transitions_2026_01
  PARTITION OF kanban.card_stage_transitions
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE kanban.card_stage_transitions_2026_02
  PARTITION OF kanban.card_stage_transitions
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
-- ... auto-create future partitions via pg_partman or a cron job
```

**Key considerations:**
- The PK must include the partition key (`transitioned_at`), so the PK becomes
  `(id, transitioned_at)`.
- Existing indexes on `card_id`, `loop_id`, `cycle_number` become local partition
  indexes (automatically created per partition).
- Velocity calculations typically look at the last 90 days, so queries naturally
  prune to 3 partitions.
- Old partitions (>12 months) can be detached and archived to cold storage.

**When to implement:** When total transition rows exceed 1M (estimated at ~50
active tenants with moderate volume).

### 6.2 audit_log -- Range Partitioning by Month

**Growth driver:** Every significant user/system action inserts a row. At scale,
this is the highest-volume table.

**Partition scheme:**

```sql
CREATE TABLE audit.audit_log (
  id uuid DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid,
  action varchar(100) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id uuid,
  previous_state jsonb,
  new_state jsonb,
  metadata jsonb DEFAULT '{}',
  ip_address varchar(45),
  user_agent text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);
```

**Retention policy:**
- Hot partitions (last 3 months): SSD storage, full indexing
- Warm partitions (3-12 months): Standard storage, reduced indexing
- Cold partitions (>12 months): Compressed, archive-only, detached

**When to implement:** When total audit rows exceed 500K (estimated at ~30 active
tenants).

### 6.3 notifications -- Partitioning NOT recommended (yet)

Notifications are high-write but also high-delete (users mark as read, old
notifications can be purged). At the 100-tenant scale, simple time-based
TTL cleanup (DELETE WHERE created_at < now() - interval '90 days' AND is_read)
is sufficient. Revisit at 500+ tenants.

---

## 7. Growth Projections at 100 Tenants

Assumptions for a "typical tenant" at steady state:
- 3-5 users (average 4)
- 1-3 facilities (average 2)
- 200-1000 parts (average 500)
- 20-100 suppliers (average 40)
- 50-200 kanban loops (average 100)
- 100-400 kanban cards (average 200)
- 2-5 card cycles per month per card
- 5-20 POs per month
- 2-10 WOs per month (production tenants only, ~50%)
- 1-5 TOs per month (multi-facility tenants only, ~30%)

### Row Count Estimates at 100 Tenants (12 months)

| Table | Per Tenant (12mo) | 100 Tenants | Growth Rate | Notes |
|---|---|---|---|---|
| tenants | 1 | 100 | Slow | |
| users | 4 | 400 | Slow | |
| oauth_accounts | 2 | 200 | Slow | |
| refresh_tokens | 50 | 5,000 | Moderate | Token rotation |
| facilities | 2 | 200 | Slow | |
| storage_locations | 10 | 1,000 | Slow | |
| part_categories | 15 | 1,500 | Slow | |
| parts | 500 | 50,000 | Slow | |
| suppliers | 40 | 4,000 | Slow | |
| supplier_parts | 200 | 20,000 | Slow | |
| bom_items | 300 | 30,000 | Slow | |
| kanban_loops | 100 | 10,000 | Slow | |
| kanban_cards | 200 | 20,000 | Slow | |
| **card_stage_transitions** | **36,000** | **3,600,000** | **High** | 200 cards x 15 cycles x 6 transitions x 2/cycle |
| kanban_parameter_history | 200 | 20,000 | Low | |
| relowisa_recommendations | 100 | 10,000 | Low | |
| purchase_orders | 120 | 12,000 | Moderate | ~10/month |
| purchase_order_lines | 360 | 36,000 | Moderate | ~3 lines/PO |
| work_centers | 5 | 500 | Slow | |
| work_orders | 60 | 6,000 | Moderate | ~5/month (50% of tenants) |
| work_order_routings | 180 | 18,000 | Moderate | ~3 steps/WO |
| transfer_orders | 24 | 2,400 | Low | ~2/month (30% of tenants) |
| transfer_order_lines | 48 | 4,800 | Low | ~2 lines/TO |
| **notifications** | **5,000** | **500,000** | **High** | ~400/month |
| notification_preferences | 40 | 4,000 | Slow | 4 users x 10 types |
| subscription_plans | -- | 4 | Static | Global |
| usage_records | 12 | 1,200 | Low | Monthly |
| **audit_log** | **20,000** | **2,000,000** | **High** | ~1,600/month |

### Storage Estimates

| Table | Avg Row Size | 100 Tenants Rows | Estimated Size |
|---|---|---|---|
| card_stage_transitions | ~300 bytes | 3,600,000 | ~1.0 GB |
| audit_log | ~800 bytes (with JSONB) | 2,000,000 | ~1.5 GB |
| notifications | ~400 bytes | 500,000 | ~200 MB |
| All other tables combined | varies | ~250,000 | ~150 MB |
| **Total data** | | | **~2.9 GB** |
| **Total with indexes** | | | **~4.5 GB** |

These are well within PostgreSQL's comfortable operating range on a single node.
Partitioning becomes important for query performance (partition pruning) rather
than storage at this scale.

---

## 8. Maintenance and Monitoring

### 8.1 VACUUM and ANALYZE

- **Append-only tables** (card_stage_transitions, audit_log): Rarely need VACUUM
  for dead tuple reclamation since rows are never updated or deleted. However,
  `ANALYZE` is still needed to update planner statistics as data grows.
- **Frequently updated tables** (kanban_cards, purchase_orders, work_orders):
  Autovacuum should be configured with lower thresholds to keep dead tuple counts
  low. Recommended:
  ```sql
  ALTER TABLE kanban.kanban_cards SET (autovacuum_vacuum_scale_factor = 0.05);
  ALTER TABLE orders.purchase_orders SET (autovacuum_vacuum_scale_factor = 0.05);
  ```

### 8.2 Index Bloat Monitoring

Monitor index bloat with `pg_stat_user_indexes` and `pgstattuple`. Reindex
periodically for heavily-updated tables:

```sql
-- Check for bloated indexes
SELECT schemaname, tablename, indexname,
       pg_size_pretty(pg_relation_size(indexrelid)) as index_size
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;
```

### 8.3 Slow Query Logging

Enable `log_min_duration_statement = 200` (200ms) to catch queries that are not
using indexes effectively. Common culprits:

- Missing `tenant_id` in WHERE clause (full table scan)
- Sorting without a supporting index (in-memory sort)
- JSONB queries without GIN indexes (if introduced later)

### 8.4 Partition Management Automation

When partitioning is implemented, use `pg_partman` to automatically:

- Create future partitions (2 months ahead)
- Detach old partitions past retention window
- Maintain partition-local indexes

```sql
SELECT partman.create_parent(
  'kanban.card_stage_transitions',
  'transitioned_at',
  'native',
  'monthly'
);
```

### 8.5 Connection Pooling

With 100 tenants and multiple services, connection pooling via PgBouncer is
essential. Each service (api-gateway, auth, catalog, kanban, notifications, orders)
maintains its own pool. Recommended pool size per service: 5-10 connections.
Total PostgreSQL `max_connections` should be set to at least 100.
