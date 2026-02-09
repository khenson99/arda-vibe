# Arda V2 -- Sitemap

> Canonical information architecture for all authenticated application areas.
> Source of truth for route structure across all personas.

## Persona Summary (from `UserRole` enum)

| # | Role Key | Display Name | Primary Domain |
|---|----------|-------------|----------------|
| 1 | `tenant_admin` | Operations Manager | Full system visibility, configuration, strategic oversight |
| 2 | `inventory_manager` | Inventory Manager | Stock levels, reorder points, bin management, Kanban loops |
| 3 | `procurement_manager` | Procurement Manager | Purchase orders, suppliers, receiving, order queue |
| 4 | `receiving_manager` | Warehouse / Receiving Personnel | Scanning, receiving, inventory moves, transfer orders |
| 5 | `ecommerce_director` | eCommerce Director | Channel management, sellable catalog, distributor API |
| 6 | `salesperson` | Salesperson | Customer-facing catalog, order lookup, availability |
| 7 | `executive` | Executive | KPI dashboards, reports, exports |

---

## 1. Public / Unauthenticated Routes

| Route | Page | Description |
|-------|------|-------------|
| `/login` | Login | Email/password + Google OAuth login |
| `/register` | Register | Tenant + admin user registration |
| `/forgot-password` | Forgot Password | Password reset request |
| `/reset-password/:token` | Reset Password | Set new password via token |
| `/scan/:cardId` | QR Scan Landing | Public QR deep-link; redirects to PWA or shows card trigger page |

---

## 2. Shared / Global Routes (All Authenticated Roles)

| Route | Page | Description |
|-------|------|-------------|
| `/` | Home Redirect | Redirects to persona-specific landing page |
| `/dashboard` | Dashboard | Persona-specific dashboard (different widgets per role) |
| `/notifications` | Notification Center | In-app notification list, mark read, filter by type |
| `/notifications/preferences` | Notification Preferences | Per-type, per-channel toggle matrix |
| `/profile` | User Profile | Edit name, email, avatar, password |
| `/settings` | Tenant Settings | Tenant config (timezone, currency, date format, card format, approval rules) |
| `/settings/users` | User Management | Invite, edit roles, deactivate users (admin only) |
| `/settings/billing` | Billing & Plans | Subscription plan, card/seat usage, Stripe portal link |
| `/settings/facilities` | Facilities | CRUD facilities (warehouses, plants, distribution centers) |
| `/settings/facilities/:id/locations` | Storage Locations | CRUD bins/shelves/zones within a facility |

---

## 3. Kanban System

| Route | Page | Description |
|-------|------|-------------|
| `/kanban` | Kanban Overview | Summary of all loops: counts by type, stage distribution chart |
| `/kanban/loops` | Loop List | Filterable/sortable table of all Kanban loops |
| `/kanban/loops/new` | Create Loop | Form: part, facility, loop type, parameters, supplier/source |
| `/kanban/loops/:id` | Loop Detail | Cards in this loop, parameter history, ReLoWiSa recommendations |
| `/kanban/loops/:id/edit` | Edit Loop | Modify loop parameters (min qty, order qty, # cards) |
| `/kanban/cards` | Card List | All cards across loops, filter by stage, loop type, facility |
| `/kanban/cards/:id` | Card Detail | Current stage, QR code, transition history, linked order |
| `/kanban/cards/:id/print` | Card Print | Print-ready card layout with QR code (3x5, 4x6, label formats) |
| `/kanban/velocity` | Velocity Dashboard | Cycle times, throughput, stage duration charts |
| `/kanban/velocity/:loopId` | Loop Velocity Detail | Per-loop velocity metrics, trend charts |
| `/kanban/relowisa` | ReLoWiSa Recommendations | Pending recommendations, approve/reject with reasoning |

---

## 4. Order Queue

| Route | Page | Description |
|-------|------|-------------|
| `/orders/queue` | Order Queue | Triggered cards awaiting order creation, grouped by loop type |
| `/orders/queue/summary` | Queue Summary | Aggregate counts, oldest card age, risk indicators |
| `/orders/queue/risk` | Queue Risk Scanner | Risk analysis: stockout risk by triggered card age + days-of-supply |

---

## 5. Procurement (Purchase Orders)

| Route | Page | Description |
|-------|------|-------------|
| `/orders/purchase` | PO List | Filterable table of all purchase orders |
| `/orders/purchase/new` | Create PO | Manual PO creation form (supplier, facility, lines) |
| `/orders/purchase/:id` | PO Detail | Header, line items, status timeline, audit trail |
| `/orders/purchase/:id/receive` | Receive PO | Line-by-line receiving with quantity entry |

---

## 6. Production (Work Orders)

| Route | Page | Description |
|-------|------|-------------|
| `/orders/work` | WO List | Filterable table of all work orders |
| `/orders/work/new` | Create WO | Manual WO creation (part, facility, quantity, routing steps) |
| `/orders/work/:id` | WO Detail | Header, routing steps with status, quantity produced/rejected |
| `/orders/work-centers` | Work Center List | All work centers with capacity and cost info |
| `/orders/work-centers/new` | Create Work Center | Form: name, code, facility, capacity, cost |
| `/orders/work-centers/:id` | Work Center Detail | Utilization, assigned routings, edit form |

---

## 7. Transfers (Transfer Orders)

| Route | Page | Description |
|-------|------|-------------|
| `/orders/transfer` | TO List | Filterable table of all transfer orders |
| `/orders/transfer/new` | Create TO | Manual TO creation (source, destination, lines) |
| `/orders/transfer/:id` | TO Detail | Header, line items, status timeline, shipping/receiving info |
| `/orders/transfer/:id/receive` | Receive TO | Line-by-line receiving at destination facility |

---

## 8. Catalog

| Route | Page | Description |
|-------|------|-------------|
| `/catalog/parts` | Part List | Master parts catalog, filterable by type, category, sellable flag |
| `/catalog/parts/new` | Create Part | Form: part number, name, type, UOM, cost, price, specs |
| `/catalog/parts/:id` | Part Detail | Full part info, supplier links, BOM, Kanban loops, order history |
| `/catalog/parts/:id/edit` | Edit Part | Modify part details |
| `/catalog/categories` | Category List | Hierarchical category tree |
| `/catalog/categories/new` | Create Category | Form: name, parent category, description |
| `/catalog/categories/:id` | Category Detail | Parts in this category, edit form |
| `/catalog/suppliers` | Supplier List | All suppliers with contact info |
| `/catalog/suppliers/new` | Create Supplier | Form: name, code, contact, address, payment terms, lead time |
| `/catalog/suppliers/:id` | Supplier Detail | Contact info, linked parts, PO history, performance metrics |
| `/catalog/suppliers/:id/edit` | Edit Supplier | Modify supplier details |
| `/catalog/bom` | BOM Explorer | Visual BOM tree for any parent part |
| `/catalog/bom/:partId` | BOM Detail | Single-level BOM for a specific part |

---

## 9. Reporting & Analytics

| Route | Page | Description |
|-------|------|-------------|
| `/reports` | Reports Home | Report catalog with descriptions |
| `/reports/inventory-turnover` | Inventory Turnover | Turnover ratio by part, category, facility |
| `/reports/order-cycle-time` | Order Cycle Time | PO/WO/TO lead times vs stated |
| `/reports/stockout-history` | Stockout History | Historical stockout events and duration |
| `/reports/supplier-performance` | Supplier Performance | On-time delivery, quality, lead time accuracy |
| `/reports/kanban-efficiency` | Kanban Efficiency | Loop utilization, card velocity, ReLoWiSa impact |
| `/reports/audit-trail` | Audit Trail | Searchable audit log with filters |
| `/reports/audit-summary` | Audit Summary | Aggregated audit analytics (by action, entity, time) |
| `/reports/exports` | Data Exports | CSV/Excel export for any report |

---

## 10. eCommerce / Distributor

| Route | Page | Description |
|-------|------|-------------|
| `/ecommerce` | eCommerce Dashboard | Channel overview, API key management |
| `/ecommerce/catalog` | Sellable Catalog | Parts with `isSellable = true`, pricing, availability |
| `/ecommerce/api-keys` | API Key Management | Create/revoke distributor API keys |
| `/ecommerce/webhooks` | Webhook Config | Configure outbound webhooks for inventory/order events |

---

## 11. Scanning / Mobile (PWA)

| Route | Page | Description |
|-------|------|-------------|
| `/scan/:cardId` | Scan Result | Card info after QR scan, trigger action, status display |
| `/scan/history` | Scan History | Recent scans by this user |
| `/mobile/receiving` | Mobile Receiving | Simplified receiving UI for warehouse floor |
| `/mobile/cycle-count` | Cycle Count | Scan-driven cycle count for inventory accuracy |

---

## Route Hierarchy (Tree View)

```
/
+-- login
+-- register
+-- forgot-password
+-- reset-password/:token
+-- dashboard
+-- notifications
|   +-- preferences
+-- profile
+-- settings
|   +-- users
|   +-- billing
|   +-- facilities
|       +-- :id/locations
+-- kanban
|   +-- loops
|   |   +-- new
|   |   +-- :id
|   |   +-- :id/edit
|   +-- cards
|   |   +-- :id
|   |   +-- :id/print
|   +-- velocity
|   |   +-- :loopId
|   +-- relowisa
+-- orders
|   +-- queue
|   |   +-- summary
|   |   +-- risk
|   +-- purchase
|   |   +-- new
|   |   +-- :id
|   |   +-- :id/receive
|   +-- work
|   |   +-- new
|   |   +-- :id
|   +-- work-centers
|   |   +-- new
|   |   +-- :id
|   +-- transfer
|       +-- new
|       +-- :id
|       +-- :id/receive
+-- catalog
|   +-- parts
|   |   +-- new
|   |   +-- :id
|   |   +-- :id/edit
|   +-- categories
|   |   +-- new
|   |   +-- :id
|   +-- suppliers
|   |   +-- new
|   |   +-- :id
|   |   +-- :id/edit
|   +-- bom
|       +-- :partId
+-- reports
|   +-- inventory-turnover
|   +-- order-cycle-time
|   +-- stockout-history
|   +-- supplier-performance
|   +-- kanban-efficiency
|   +-- audit-trail
|   +-- audit-summary
|   +-- exports
+-- ecommerce
|   +-- catalog
|   +-- api-keys
|   +-- webhooks
+-- scan
|   +-- :cardId
|   +-- history
+-- mobile
    +-- receiving
    +-- cycle-count
```
