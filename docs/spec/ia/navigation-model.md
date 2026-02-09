# Arda V2 -- Navigation Model

> Defines the left sidebar navigation structure, persona landing routes, shared routes, breadcrumb patterns, and the route-to-role access matrix.

---

## 1. Persona Landing Routes

Each role has a default landing page after login. The `/` route redirects based on `user.role`.

| Role | Key | Default Landing Route | Rationale |
|------|-----|-----------------------|-----------|
| Operations Manager | `tenant_admin` | `/dashboard` | Full operational overview |
| Inventory Manager | `inventory_manager` | `/kanban` | Kanban loop and card status |
| Procurement Manager | `procurement_manager` | `/orders/queue` | Triggered cards needing POs |
| Warehouse / Receiving | `receiving_manager` | `/mobile/receiving` | Scan-first workflow on floor |
| eCommerce Director | `ecommerce_director` | `/ecommerce` | Channel and catalog overview |
| Salesperson | `salesperson` | `/catalog/parts` | Product catalog for customers |
| Executive | `executive` | `/reports` | KPI dashboards and reports |

---

## 2. Left Sidebar Navigation Structure

The sidebar is always rendered with dark background (`--sidebar-background: 0 0% 4%`). Navigation items are conditionally rendered based on the user's role. The sidebar has two zones: a scrollable main navigation area and a fixed bottom utilities area.

### 2.1 Sidebar Layout

```
+-----------------------------------+
| [Arda Logo]        [Tenant Name]  |
+-----------------------------------+
| MAIN NAVIGATION (scrollable)      |
|                                   |
|  Dashboard                        |
|  ---                              |
|  KANBAN                           |
|    Loops                          |
|    Cards                          |
|    Velocity                       |
|    ReLoWiSa                       |
|  ---                              |
|  ORDERS                           |
|    Order Queue                    |
|    Purchase Orders                |
|    Work Orders                    |
|    Transfer Orders                |
|    Work Centers                   |
|  ---                              |
|  CATALOG                          |
|    Parts                          |
|    Categories                     |
|    Suppliers                      |
|    BOM Explorer                   |
|  ---                              |
|  REPORTS                          |
|    Overview                       |
|    Inventory Turnover             |
|    Order Cycle Time               |
|    Stockout History               |
|    Supplier Performance           |
|    Kanban Efficiency              |
|    Audit Trail                    |
|  ---                              |
|  eCOMMERCE                        |
|    Dashboard                      |
|    Sellable Catalog               |
|    API Keys                       |
|    Webhooks                       |
+-----------------------------------+
| BOTTOM UTILITIES (fixed)          |
|                                   |
|  [Bell icon] Notifications  [3]   |
|  [Gear icon] Settings             |
|  [User avatar] Profile  [>]      |
+-----------------------------------+
```

### 2.2 Sidebar Sections by Persona

Not all sections are visible to all roles. The table below shows which sidebar sections render for each role.

| Sidebar Section | `tenant_admin` | `inventory_manager` | `procurement_manager` | `receiving_manager` | `ecommerce_director` | `salesperson` | `executive` |
|----------------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Dashboard | Y | Y | Y | Y | Y | Y | Y |
| Kanban | Y | Y | Y | Y (read) | - | - | Y (read) |
| Orders | Y | Y (read) | Y | Y (receiving) | - | - | Y (read) |
| Catalog | Y | Y | Y | Y (read) | Y (sellable) | Y (read) | Y (read) |
| Reports | Y | Y | Y | - | Y (ecom) | - | Y |
| eCommerce | Y | - | - | - | Y | - | Y (read) |
| Settings | Y | - | - | - | - | - | - |
| User Mgmt | Y | - | - | - | - | - | - |

---

## 3. Route Patterns

### 3.1 URL Convention

All routes follow these patterns:

| Pattern | Example | Usage |
|---------|---------|-------|
| `/{domain}` | `/kanban` | Domain landing / list |
| `/{domain}/{entity}` | `/kanban/loops` | Entity list |
| `/{domain}/{entity}/new` | `/kanban/loops/new` | Create form |
| `/{domain}/{entity}/:id` | `/kanban/loops/:id` | Detail view |
| `/{domain}/{entity}/:id/edit` | `/kanban/loops/:id/edit` | Edit form |
| `/{domain}/{entity}/:id/{action}` | `/orders/purchase/:id/receive` | Action on entity |

### 3.2 API Route Mapping

Frontend routes map to backend API routes via the API Gateway proxy:

| Frontend Route | API Endpoint | Service |
|----------------|-------------|---------|
| `/kanban/loops` | `GET /api/kanban/loops` | kanban |
| `/kanban/cards/:id` | `GET /api/kanban/cards/:id` | kanban |
| `/kanban/cards/:id` (transition) | `POST /api/kanban/cards/:id/transition` | kanban |
| `/kanban/velocity/:loopId` | `GET /api/kanban/velocity/:loopId` | kanban |
| `/orders/queue` | `GET /api/orders/queue` | orders |
| `/orders/queue/risk` | `GET /api/orders/queue/risk-scan` | orders |
| `/orders/queue` (create PO) | `POST /api/orders/queue/create-po` | orders |
| `/orders/queue` (create WO) | `POST /api/orders/queue/create-wo` | orders |
| `/orders/queue` (create TO) | `POST /api/orders/queue/create-to` | orders |
| `/orders/purchase` | `GET /api/orders/purchase-orders` | orders |
| `/orders/purchase/:id` | `GET /api/orders/purchase-orders/:id` | orders |
| `/orders/purchase/:id/receive` | `PATCH /api/orders/purchase-orders/:id/receive` | orders |
| `/orders/work` | `GET /api/orders/work-orders` | orders |
| `/orders/transfer` | `GET /api/orders/transfer-orders` | orders |
| `/catalog/parts` | `GET /api/catalog/parts` | catalog |
| `/catalog/suppliers` | `GET /api/catalog/suppliers` | catalog |
| `/catalog/categories` | `GET /api/catalog/categories` | catalog |
| `/catalog/bom/:partId` | `GET /api/catalog/bom/:partId` | catalog |
| `/notifications` | `GET /api/notifications` | notifications |
| `/notifications/preferences` | `GET /api/notifications/preferences` | notifications |
| `/reports/audit-trail` | `GET /api/orders/audit` | orders |
| `/reports/audit-summary` | `GET /api/orders/audit/summary` | orders |
| `/scan/:cardId` | `GET /api/kanban/scan/:cardId` | kanban |
| `/scan/:cardId` (trigger) | `POST /api/kanban/scan/:cardId/trigger` | kanban |

---

## 4. Shared Routes

These routes are accessible to every authenticated user regardless of role.

| Route | Page | Notes |
|-------|------|-------|
| `/dashboard` | Dashboard | Widgets vary by role |
| `/notifications` | Notification Center | All users receive notifications |
| `/notifications/preferences` | Notification Preferences | Per-user channel/type toggles |
| `/profile` | User Profile | Name, email, avatar, password |

---

## 5. Route-to-Role Access Matrix

**Legend:**
- **F** = Full access (CRUD)
- **R** = Read-only access
- **W** = Write/action access (e.g., receive, transition)
- **-** = No access (route hidden from sidebar, 403 if navigated directly)

| Route | `tenant_admin` | `inventory_manager` | `procurement_manager` | `receiving_manager` | `ecommerce_director` | `salesperson` | `executive` |
|-------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Shared** | | | | | | | |
| `/dashboard` | F | F | F | F | F | F | F |
| `/notifications` | F | F | F | F | F | F | F |
| `/notifications/preferences` | F | F | F | F | F | F | F |
| `/profile` | F | F | F | F | F | F | F |
| **Settings** | | | | | | | |
| `/settings` | F | - | - | - | - | - | - |
| `/settings/users` | F | - | - | - | - | - | - |
| `/settings/billing` | F | - | - | - | - | - | R |
| `/settings/facilities` | F | R | R | R | - | - | R |
| `/settings/facilities/:id/locations` | F | R | R | R | - | - | R |
| **Kanban** | | | | | | | |
| `/kanban` | F | F | R | R | - | - | R |
| `/kanban/loops` | F | F | R | R | - | - | R |
| `/kanban/loops/new` | F | F | - | - | - | - | - |
| `/kanban/loops/:id` | F | F | R | R | - | - | R |
| `/kanban/loops/:id/edit` | F | F | - | - | - | - | - |
| `/kanban/cards` | F | F | R | R | - | - | R |
| `/kanban/cards/:id` | F | F | R | R | - | - | R |
| `/kanban/cards/:id/print` | F | F | R | R | - | - | - |
| `/kanban/velocity` | F | F | R | - | - | - | R |
| `/kanban/velocity/:loopId` | F | F | R | - | - | - | R |
| `/kanban/relowisa` | F | F | - | - | - | - | R |
| **Order Queue** | | | | | | | |
| `/orders/queue` | F | R | F | R | - | - | R |
| `/orders/queue/summary` | F | R | F | R | - | - | R |
| `/orders/queue/risk` | F | R | F | - | - | - | R |
| **Purchase Orders** | | | | | | | |
| `/orders/purchase` | F | R | F | R | - | - | R |
| `/orders/purchase/new` | F | - | F | - | - | - | - |
| `/orders/purchase/:id` | F | R | F | R | - | - | R |
| `/orders/purchase/:id/receive` | F | - | F | W | - | - | - |
| **Work Orders** | | | | | | | |
| `/orders/work` | F | R | R | R | - | - | R |
| `/orders/work/new` | F | F | - | - | - | - | - |
| `/orders/work/:id` | F | F | R | R | - | - | R |
| `/orders/work-centers` | F | F | R | R | - | - | R |
| `/orders/work-centers/new` | F | F | - | - | - | - | - |
| `/orders/work-centers/:id` | F | F | R | R | - | - | R |
| **Transfer Orders** | | | | | | | |
| `/orders/transfer` | F | R | R | F | - | - | R |
| `/orders/transfer/new` | F | R | - | F | - | - | - |
| `/orders/transfer/:id` | F | R | R | F | - | - | R |
| `/orders/transfer/:id/receive` | F | - | - | W | - | - | - |
| **Catalog** | | | | | | | |
| `/catalog/parts` | F | F | R | R | R | R | R |
| `/catalog/parts/new` | F | F | - | - | - | - | - |
| `/catalog/parts/:id` | F | F | R | R | R | R | R |
| `/catalog/parts/:id/edit` | F | F | - | - | - | - | - |
| `/catalog/categories` | F | F | R | R | R | R | R |
| `/catalog/categories/new` | F | F | - | - | - | - | - |
| `/catalog/categories/:id` | F | F | R | R | R | R | R |
| `/catalog/suppliers` | F | R | F | R | - | - | R |
| `/catalog/suppliers/new` | F | - | F | - | - | - | - |
| `/catalog/suppliers/:id` | F | R | F | R | - | - | R |
| `/catalog/suppliers/:id/edit` | F | - | F | - | - | - | - |
| `/catalog/bom` | F | F | R | R | - | - | R |
| `/catalog/bom/:partId` | F | F | R | R | - | - | R |
| **Reports** | | | | | | | |
| `/reports` | F | R | R | - | R | - | F |
| `/reports/inventory-turnover` | F | R | R | - | R | - | F |
| `/reports/order-cycle-time` | F | R | R | - | - | - | F |
| `/reports/stockout-history` | F | R | R | - | R | - | F |
| `/reports/supplier-performance` | F | - | R | - | - | - | F |
| `/reports/kanban-efficiency` | F | R | - | - | - | - | F |
| `/reports/audit-trail` | F | R | R | - | - | - | F |
| `/reports/audit-summary` | F | R | R | - | - | - | F |
| `/reports/exports` | F | R | R | - | R | - | F |
| **eCommerce** | | | | | | | |
| `/ecommerce` | F | - | - | - | F | - | R |
| `/ecommerce/catalog` | F | - | - | - | F | - | R |
| `/ecommerce/api-keys` | F | - | - | - | F | - | - |
| `/ecommerce/webhooks` | F | - | - | - | F | - | - |
| **Scanning / Mobile** | | | | | | | |
| `/scan/:cardId` | F | F | F | F | - | - | - |
| `/scan/history` | F | F | F | F | - | - | - |
| `/mobile/receiving` | F | - | W | F | - | - | - |
| `/mobile/cycle-count` | F | F | - | F | - | - | - |

---

## 6. Breadcrumb Patterns

Breadcrumbs follow a hierarchical structure based on the URL segments. The application shell renders breadcrumbs automatically using the route path.

### 6.1 Breadcrumb Rules

1. **Root segment** maps to the domain label (e.g., `/kanban` -> "Kanban")
2. **Entity segment** maps to the entity plural label (e.g., `/loops` -> "Loops")
3. **`:id` segments** resolve to the entity display name via API (e.g., loop name, PO number)
4. **Action segments** map to action labels (e.g., `/edit` -> "Edit", `/receive` -> "Receive")
5. **Each breadcrumb segment is clickable** and navigates to that route level

### 6.2 Breadcrumb Examples

| Route | Breadcrumb Trail |
|-------|-----------------|
| `/dashboard` | Home |
| `/kanban/loops` | Kanban > Loops |
| `/kanban/loops/new` | Kanban > Loops > New Loop |
| `/kanban/loops/:id` | Kanban > Loops > {Loop Name} |
| `/kanban/loops/:id/edit` | Kanban > Loops > {Loop Name} > Edit |
| `/kanban/cards/:id` | Kanban > Cards > Card #{cardNumber} |
| `/kanban/cards/:id/print` | Kanban > Cards > Card #{cardNumber} > Print |
| `/orders/queue` | Orders > Queue |
| `/orders/queue/risk` | Orders > Queue > Risk Scanner |
| `/orders/purchase` | Orders > Purchase Orders |
| `/orders/purchase/:id` | Orders > Purchase Orders > {PO Number} |
| `/orders/purchase/:id/receive` | Orders > Purchase Orders > {PO Number} > Receive |
| `/orders/work/:id` | Orders > Work Orders > {WO Number} |
| `/orders/transfer/:id` | Orders > Transfer Orders > {TO Number} |
| `/catalog/parts` | Catalog > Parts |
| `/catalog/parts/:id` | Catalog > Parts > {Part Number} -- {Part Name} |
| `/catalog/suppliers/:id` | Catalog > Suppliers > {Supplier Name} |
| `/catalog/bom/:partId` | Catalog > BOM > {Part Number} |
| `/reports/audit-trail` | Reports > Audit Trail |
| `/settings/facilities/:id/locations` | Settings > Facilities > {Facility Name} > Storage Locations |

### 6.3 Breadcrumb Component API

```tsx
interface BreadcrumbSegment {
  label: string;         // Display text
  href?: string;         // Navigation URL (omit for current page)
  isLoading?: boolean;   // Show skeleton while resolving entity name
}

// The AppShell component generates breadcrumbs from the current route.
// Entity name resolution uses React Query cache (no extra API calls for already-loaded entities).
```

---

## 7. Navigation State Management

### 7.1 Sidebar State

- **Collapsed/Expanded**: Persisted in `localStorage` (`arda:sidebar-collapsed`)
- **Active Section**: Auto-expanded based on current route pathname
- **Mobile**: Sidebar is a drawer, toggled by hamburger menu in header

### 7.2 Route Guards

```
AuthGuard -> RoleGuard -> Component
```

1. **AuthGuard**: Checks JWT validity. Redirects to `/login` if expired/missing.
2. **RoleGuard**: Checks `user.role` against route access matrix. Returns 403 page if unauthorized.
3. **TenantGuard**: Ensures `user.tenantId` matches tenant context. Prevents cross-tenant access.

### 7.3 Deep Linking

- All routes are deep-linkable (no modal-only states for primary content)
- QR scan URLs (`/scan/:cardId`) work from unauthenticated state (redirect to login, then back to scan)
- Notification `actionUrl` field provides deep links to relevant entities
- Browser back/forward navigation preserves filter/sort state via URL query params

---

## 8. Responsive Behavior

| Breakpoint | Layout |
|-----------|--------|
| >= 1280px (xl) | Full sidebar + content area |
| 768-1279px (md-lg) | Collapsed sidebar (icons only) + content area |
| < 768px (sm) | Hidden sidebar (drawer) + full-width content + bottom nav |

### Mobile Bottom Navigation (< 768px)

For warehouse/receiving persona on mobile devices, a bottom navigation bar replaces the sidebar:

| Icon | Label | Route |
|------|-------|-------|
| Scan | Scan | `/scan` (camera) |
| Receive | Receive | `/mobile/receiving` |
| Cards | Cards | `/kanban/cards` |
| Queue | Queue | `/orders/queue` |
| More | More | Slide-up menu |
