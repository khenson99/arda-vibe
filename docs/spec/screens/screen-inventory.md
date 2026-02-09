# Arda V2 -- Screen Inventory

> Master inventory of every screen, modal, drawer, and key view in the MVP application.
> Each entry links to the detailed wireframe-level spec in its domain file.

---

## Inventory Summary

| Domain | Screens | Modals/Drawers | Detail File |
|--------|---------|----------------|-------------|
| Public / Auth | 5 | 0 | [shared-screens.md](./shared-screens.md#1-public--authentication) |
| Dashboard | 1 | 0 | [shared-screens.md](./shared-screens.md#2-dashboard) |
| Notifications | 2 | 1 | [shared-screens.md](./shared-screens.md#3-notifications) |
| Profile | 1 | 2 | [shared-screens.md](./shared-screens.md#4-profile) |
| Settings | 5 | 5 | [settings-screens.md](./settings-screens.md) |
| Kanban | 11 | 6 | [kanban-screens.md](./kanban-screens.md) |
| Order Queue | 3 | 3 | [order-screens.md](./order-screens.md#1-order-queue) |
| Purchase Orders | 4 | 5 | [order-screens.md](./order-screens.md#2-purchase-orders) |
| Work Orders | 3 | 3 | [order-screens.md](./order-screens.md#3-work-orders) |
| Work Centers | 3 | 2 | [order-screens.md](./order-screens.md#4-work-centers) |
| Transfer Orders | 4 | 3 | [order-screens.md](./order-screens.md#5-transfer-orders) |
| Catalog - Parts | 4 | 3 | [catalog-screens.md](./catalog-screens.md#1-parts) |
| Catalog - Categories | 3 | 2 | [catalog-screens.md](./catalog-screens.md#2-categories) |
| Catalog - Suppliers | 4 | 2 | [catalog-screens.md](./catalog-screens.md#3-suppliers) |
| Catalog - BOM | 2 | 1 | [catalog-screens.md](./catalog-screens.md#4-bill-of-materials) |
| Reports | 9 | 2 | [shared-screens.md](./shared-screens.md#5-reports--analytics) |
| eCommerce | 4 | 4 | [shared-screens.md](./shared-screens.md#6-ecommerce--distributor) |
| Mobile / Scan | 4 | 1 | [shared-screens.md](./shared-screens.md#7-scanning--mobile-pwa) |
| **TOTAL** | **72** | **45** | |

---

## Complete Route Table

| # | Route | Screen Name | Domain | Type | Detail File |
|---|-------|-------------|--------|------|-------------|
| 1 | `/login` | Login | Auth | Page | [shared](./shared-screens.md#screen-login) |
| 2 | `/register` | Register | Auth | Page | [shared](./shared-screens.md#screen-register) |
| 3 | `/forgot-password` | Forgot Password | Auth | Page | [shared](./shared-screens.md#screen-forgot-password) |
| 4 | `/reset-password/:token` | Reset Password | Auth | Page | [shared](./shared-screens.md#screen-reset-password) |
| 5 | `/scan/:cardId` (public) | QR Scan Landing | Auth | Page | [shared](./shared-screens.md#screen-qr-scan-landing-public) |
| 6 | `/dashboard` | Dashboard | Shared | Page | [shared](./shared-screens.md#screen-dashboard) |
| 7 | `/notifications` | Notification Center | Shared | Page | [shared](./shared-screens.md#screen-notification-center) |
| 8 | `/notifications/preferences` | Notification Preferences | Shared | Page | [shared](./shared-screens.md#screen-notification-preferences) |
| 9 | `/profile` | User Profile | Shared | Page | [shared](./shared-screens.md#screen-user-profile) |
| 10 | `/settings` | Tenant Settings | Settings | Page | [settings](./settings-screens.md#screen-tenant-settings) |
| 11 | `/settings/users` | User Management | Settings | Page | [settings](./settings-screens.md#screen-user-management) |
| 12 | `/settings/billing` | Billing and Plans | Settings | Page | [settings](./settings-screens.md#screen-billing-and-plans) |
| 13 | `/settings/facilities` | Facilities | Settings | Page | [settings](./settings-screens.md#screen-facilities) |
| 14 | `/settings/facilities/:id/locations` | Storage Locations | Settings | Page | [settings](./settings-screens.md#screen-storage-locations) |
| 15 | `/kanban` | Kanban Overview | Kanban | Page | [kanban](./kanban-screens.md#screen-kanban-overview) |
| 16 | `/kanban/loops` | Loop List | Kanban | Page | [kanban](./kanban-screens.md#screen-loop-list) |
| 17 | `/kanban/loops/new` | Create Loop | Kanban | Page | [kanban](./kanban-screens.md#screen-create-loop) |
| 18 | `/kanban/loops/:id` | Loop Detail | Kanban | Page | [kanban](./kanban-screens.md#screen-loop-detail) |
| 19 | `/kanban/loops/:id/edit` | Edit Loop | Kanban | Page | [kanban](./kanban-screens.md#screen-edit-loop) |
| 20 | `/kanban/cards` | Card List | Kanban | Page | [kanban](./kanban-screens.md#screen-card-list) |
| 21 | `/kanban/cards/:id` | Card Detail | Kanban | Page | [kanban](./kanban-screens.md#screen-card-detail) |
| 22 | `/kanban/cards/:id/print` | Card Print | Kanban | Page | [kanban](./kanban-screens.md#screen-card-print) |
| 23 | `/kanban/velocity` | Velocity Dashboard | Kanban | Page | [kanban](./kanban-screens.md#screen-velocity-dashboard) |
| 24 | `/kanban/velocity/:loopId` | Loop Velocity Detail | Kanban | Page | [kanban](./kanban-screens.md#screen-loop-velocity-detail) |
| 25 | `/kanban/relowisa` | ReLoWiSa Recommendations | Kanban | Page | [kanban](./kanban-screens.md#screen-relowisa-recommendations) |
| 26 | `/orders/queue` | Order Queue | Orders | Page | [orders](./order-screens.md#screen-order-queue) |
| 27 | `/orders/queue/summary` | Queue Summary | Orders | Page | [orders](./order-screens.md#screen-queue-summary) |
| 28 | `/orders/queue/risk` | Queue Risk Scanner | Orders | Page | [orders](./order-screens.md#screen-queue-risk-scanner) |
| 29 | `/orders/purchase` | PO List | Orders | Page | [orders](./order-screens.md#screen-po-list) |
| 30 | `/orders/purchase/new` | Create PO | Orders | Page | [orders](./order-screens.md#screen-create-po) |
| 31 | `/orders/purchase/:id` | PO Detail | Orders | Page | [orders](./order-screens.md#screen-po-detail) |
| 32 | `/orders/purchase/:id/receive` | Receive PO | Orders | Page | [orders](./order-screens.md#screen-receive-po) |
| 33 | `/orders/work` | WO List | Orders | Page | [orders](./order-screens.md#screen-wo-list) |
| 34 | `/orders/work/new` | Create WO | Orders | Page | [orders](./order-screens.md#screen-create-wo) |
| 35 | `/orders/work/:id` | WO Detail | Orders | Page | [orders](./order-screens.md#screen-wo-detail) |
| 36 | `/orders/work-centers` | Work Center List | Orders | Page | [orders](./order-screens.md#screen-work-center-list) |
| 37 | `/orders/work-centers/new` | Create Work Center | Orders | Page | [orders](./order-screens.md#screen-create-work-center) |
| 38 | `/orders/work-centers/:id` | Work Center Detail | Orders | Page | [orders](./order-screens.md#screen-work-center-detail) |
| 39 | `/orders/transfer` | TO List | Orders | Page | [orders](./order-screens.md#screen-to-list) |
| 40 | `/orders/transfer/new` | Create TO | Orders | Page | [orders](./order-screens.md#screen-create-to) |
| 41 | `/orders/transfer/:id` | TO Detail | Orders | Page | [orders](./order-screens.md#screen-to-detail) |
| 42 | `/orders/transfer/:id/receive` | Receive TO | Orders | Page | [orders](./order-screens.md#screen-receive-to) |
| 43 | `/catalog/parts` | Part List | Catalog | Page | [catalog](./catalog-screens.md#screen-part-list) |
| 44 | `/catalog/parts/new` | Create Part | Catalog | Page | [catalog](./catalog-screens.md#screen-create-part) |
| 45 | `/catalog/parts/:id` | Part Detail | Catalog | Page | [catalog](./catalog-screens.md#screen-part-detail) |
| 46 | `/catalog/parts/:id/edit` | Edit Part | Catalog | Page | [catalog](./catalog-screens.md#screen-edit-part) |
| 47 | `/catalog/categories` | Category List | Catalog | Page | [catalog](./catalog-screens.md#screen-category-list) |
| 48 | `/catalog/categories/new` | Create Category | Catalog | Page | [catalog](./catalog-screens.md#screen-create-category) |
| 49 | `/catalog/categories/:id` | Category Detail | Catalog | Page | [catalog](./catalog-screens.md#screen-category-detail) |
| 50 | `/catalog/suppliers` | Supplier List | Catalog | Page | [catalog](./catalog-screens.md#screen-supplier-list) |
| 51 | `/catalog/suppliers/new` | Create Supplier | Catalog | Page | [catalog](./catalog-screens.md#screen-create-supplier) |
| 52 | `/catalog/suppliers/:id` | Supplier Detail | Catalog | Page | [catalog](./catalog-screens.md#screen-supplier-detail) |
| 53 | `/catalog/suppliers/:id/edit` | Edit Supplier | Catalog | Page | [catalog](./catalog-screens.md#screen-edit-supplier) |
| 54 | `/catalog/bom` | BOM Explorer | Catalog | Page | [catalog](./catalog-screens.md#screen-bom-explorer) |
| 55 | `/catalog/bom/:partId` | BOM Detail | Catalog | Page | [catalog](./catalog-screens.md#screen-bom-detail) |
| 56 | `/reports` | Reports Home | Reports | Page | [shared](./shared-screens.md#screen-reports-home) |
| 57 | `/reports/inventory-turnover` | Inventory Turnover | Reports | Page | [shared](./shared-screens.md#screen-inventory-turnover) |
| 58 | `/reports/order-cycle-time` | Order Cycle Time | Reports | Page | [shared](./shared-screens.md#screen-order-cycle-time) |
| 59 | `/reports/stockout-history` | Stockout History | Reports | Page | [shared](./shared-screens.md#screen-stockout-history) |
| 60 | `/reports/supplier-performance` | Supplier Performance | Reports | Page | [shared](./shared-screens.md#screen-supplier-performance) |
| 61 | `/reports/kanban-efficiency` | Kanban Efficiency | Reports | Page | [shared](./shared-screens.md#screen-kanban-efficiency) |
| 62 | `/reports/audit-trail` | Audit Trail | Reports | Page | [shared](./shared-screens.md#screen-audit-trail) |
| 63 | `/reports/audit-summary` | Audit Summary | Reports | Page | [shared](./shared-screens.md#screen-audit-summary) |
| 64 | `/reports/exports` | Data Exports | Reports | Page | [shared](./shared-screens.md#screen-data-exports) |
| 65 | `/ecommerce` | eCommerce Dashboard | eCommerce | Page | [shared](./shared-screens.md#screen-ecommerce-dashboard) |
| 66 | `/ecommerce/catalog` | Sellable Catalog | eCommerce | Page | [shared](./shared-screens.md#screen-sellable-catalog) |
| 67 | `/ecommerce/api-keys` | API Key Management | eCommerce | Page | [shared](./shared-screens.md#screen-api-key-management) |
| 68 | `/ecommerce/webhooks` | Webhook Config | eCommerce | Page | [shared](./shared-screens.md#screen-webhook-config) |
| 69 | `/scan/:cardId` (auth) | Scan Result | Mobile | Page | [shared](./shared-screens.md#screen-scan-result) |
| 70 | `/scan/history` | Scan History | Mobile | Page | [shared](./shared-screens.md#screen-scan-history) |
| 71 | `/mobile/receiving` | Mobile Receiving | Mobile | Page | [shared](./shared-screens.md#screen-mobile-receiving) |
| 72 | `/mobile/cycle-count` | Cycle Count | Mobile | Page | [shared](./shared-screens.md#screen-cycle-count) |

---

## Modal / Drawer Inventory

| # | Name | Trigger Screen | Type | Domain |
|---|------|---------------|------|--------|
| 1 | Confirm Logout | Profile | Modal | Shared |
| 2 | Change Password | Profile | Modal | Shared |
| 3 | Notification Detail Drawer | Notification Center | Drawer | Shared |
| 4 | Invite User | User Management | Modal | Settings |
| 5 | Edit User Role | User Management | Modal | Settings |
| 6 | Deactivate User Confirm | User Management | Modal | Settings |
| 7 | Create Facility | Facilities | Modal | Settings |
| 8 | Edit Facility | Facilities | Modal | Settings |
| 9 | Create Storage Location | Storage Locations | Modal | Settings |
| 10 | Edit Storage Location | Storage Locations | Modal | Settings |
| 11 | Deactivate Facility Confirm | Facilities | Modal | Settings |
| 12 | Card Quick View | Loop Detail / Card List | Drawer | Kanban |
| 13 | Transition Card Confirm | Card Detail | Modal | Kanban |
| 14 | Deactivate Loop Confirm | Loop Detail | Modal | Kanban |
| 15 | Print Options | Card Detail | Modal | Kanban |
| 16 | ReLoWiSa Review | ReLoWiSa Recommendations | Drawer | Kanban |
| 17 | Add Card to Loop | Loop Detail | Modal | Kanban |
| 18 | Create PO from Queue | Order Queue | Modal | Orders |
| 19 | Create WO from Queue | Order Queue | Modal | Orders |
| 20 | Create TO from Queue | Order Queue | Modal | Orders |
| 21 | Approve PO | PO Detail | Modal | Orders |
| 22 | Send PO | PO Detail | Modal | Orders |
| 23 | Cancel PO Confirm | PO Detail | Modal | Orders |
| 24 | Add PO Line | Create PO | Modal | Orders |
| 25 | Receive Line Item | Receive PO | Modal | Orders |
| 26 | Cancel WO Confirm | WO Detail | Modal | Orders |
| 27 | Add Routing Step | Create WO | Modal | Orders |
| 28 | Update Step Status | WO Detail | Modal | Orders |
| 29 | Deactivate Work Center | Work Center Detail | Modal | Orders |
| 30 | Edit Work Center | Work Center Detail | Modal | Orders |
| 31 | Cancel TO Confirm | TO Detail | Modal | Orders |
| 32 | Ship TO Confirm | TO Detail | Modal | Orders |
| 33 | Receive TO Line Item | Receive TO | Modal | Orders |
| 34 | Link Supplier to Part | Part Detail | Modal | Catalog |
| 35 | Upload Part Image | Create/Edit Part | Modal | Catalog |
| 36 | Deactivate Part Confirm | Part Detail | Modal | Catalog |
| 37 | Delete Category Confirm | Category Detail | Modal | Catalog |
| 38 | Move Parts to Category | Category Detail | Modal | Catalog |
| 39 | Deactivate Supplier Confirm | Supplier Detail | Modal | Catalog |
| 40 | Edit Supplier Part Link | Supplier Detail | Modal | Catalog |
| 41 | Add BOM Line | BOM Detail | Modal | Catalog |
| 42 | Report Date Range Picker | All Reports | Modal | Reports |
| 43 | Export Report | All Reports | Modal | Reports |
| 44 | Create API Key | API Key Management | Modal | eCommerce |
| 45 | Revoke API Key Confirm | API Key Management | Modal | eCommerce |
| 46 | Create Webhook | Webhook Config | Modal | eCommerce |
| 47 | Edit Webhook | Webhook Config | Modal | eCommerce |
| 48 | Scan Trigger Confirm | Scan Result | Modal | Mobile |

---

## Persona-to-Screen Mapping

This table shows the primary screens each persona uses in their daily workflows.

| Persona | Primary Screens | Landing |
|---------|----------------|---------|
| **Operations Manager** (`tenant_admin`) | Dashboard, all Kanban, all Orders, all Catalog, Settings, Reports | `/dashboard` |
| **Inventory Manager** (`inventory_manager`) | Kanban Overview/Loops/Cards, Velocity, ReLoWiSa, Parts, BOM, Cycle Count | `/kanban` |
| **Procurement Manager** (`procurement_manager`) | Order Queue, PO List/Create/Detail/Receive, Suppliers, Parts (read) | `/orders/queue` |
| **Warehouse/Receiving** (`receiving_manager`) | Mobile Receiving, Scan Result, TO List/Create/Receive, Cards (read) | `/mobile/receiving` |
| **eCommerce Director** (`ecommerce_director`) | eCommerce Dashboard, Sellable Catalog, API Keys, Webhooks | `/ecommerce` |
| **Salesperson** (`salesperson`) | Parts (read), Dashboard | `/catalog/parts` |
| **Executive** (`executive`) | Reports (all), Dashboard, Kanban (read), Billing (read) | `/reports` |

---

## Global UI Patterns

These patterns apply to every screen in the application.

### Application Shell
- **Left sidebar**: Always dark (`bg-sidebar-background`), collapsible, role-filtered nav items
- **Top header**: Breadcrumbs (left), search (center), notification bell + user avatar (right)
- **Content area**: White background, max-width container with responsive padding

### Table Pattern (used on all list screens)
- **Header bar**: Page title (left), primary action button (right)
- **Filter row**: Inline filters (status, facility, date range, search) with "Clear Filters" link
- **Table**: `bg-muted` header row, sortable columns, row hover `hover:bg-muted/50`, pagination at bottom
- **Density toggle**: Three-option toggle (Comfortable / Compact / Dense) in table header area

### Form Pattern (used on all create/edit screens)
- **Header**: Page title + breadcrumbs
- **Form body**: Single-column layout for simple forms, two-column for complex forms (Part, Supplier)
- **Footer**: "Cancel" (left, outline button), "Save" / "Create" (right, primary button)
- **Validation**: Inline field-level errors below inputs, toast for server errors
- **Unsaved changes**: Browser `beforeunload` prompt when navigating away from dirty form

### Detail Pattern (used on all entity detail screens)
- **Header**: Entity identifier (PO Number, Part Number, etc.) + status badge + action buttons
- **Tab layout**: Content organized in tabs (Overview, Lines, History, etc.)
- **Right sidebar panel**: Key metadata and quick-action buttons (optional, used on complex entities)

### Common States
- **Loading**: Skeleton UI matching the layout shape (not spinners)
- **Empty**: Illustration + descriptive text + primary action CTA
- **Error**: Error banner with retry button, or inline field errors
- **403 Forbidden**: "Access Denied" page with link back to dashboard
- **404 Not Found**: "Page Not Found" with link back to dashboard
