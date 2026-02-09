# Arda V2 -- Settings, User Management, and Billing Screens

> Wireframe-level behavior specs for tenant configuration, user management,
> billing/subscription, facilities, and storage locations.

---

## Screen: Tenant Settings

**Route**: `/settings`
**Roles**: tenant_admin (F) | **Access**: Full (admin only)

### Purpose
Configure tenant-level settings that affect the entire organization: timezone, currency, date format, Kanban card format, and approval workflow rules.

### Layout
- **Header**: "Settings" title
- **Left sidebar tabs** (vertical tab navigation within settings area): General | Approval Rules | Kanban Defaults
- **General tab**:
  - Tenant Name (text input, required)
  - Timezone (searchable select from IANA timezone list, required)
  - Currency (select: USD, EUR, GBP, CAD, MXN, etc., required)
  - Date Format (select: MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, required)
  - Tenant Logo (image upload + preview, optional)
  - "Save Changes" button (primary, bottom-right)
- **Approval Rules tab**:
  - Require Approval for POs (toggle, default on)
  - Auto-Consolidate Orders from Queue (toggle, default off) -- when on, queue items for the same supplier are auto-grouped
  - "Save Changes" button
- **Kanban Defaults tab**:
  - Default Card Format (select: 3x5, 4x6, Label, required)
  - ReLoWiSa Enabled (toggle, default on for Pro/Enterprise plans, disabled on Free/Starter)
  - "Save Changes" button

### Primary Actions
- "Save Changes": PATCH `/api/auth/tenants/{tenantId}` with settings JSON, toast on success
- Logo upload: Opens file picker, uploads to storage, updates `logoUrl`

### Data Displayed
- Current values from `tenants.settings` JSONB field
- Tenant name, logo from `tenants` record
- Plan feature flags determine which toggles are enabled vs. disabled with upgrade prompt

### States
- **Loading**: Skeleton form fields
- **Error**: Toast notification for save failures, inline field errors for validation
- **Validation**:
  - `name`: Required, max 255 chars. "Tenant name is required."
  - `timezone`: Required, must be valid IANA timezone.
  - `currency`: Required, must be valid ISO 4217 code.
  - `dateFormat`: Required.
  - Logo: Max 2MB, JPG/PNG/SVG format.
- **Feature-gated**: ReLoWiSa toggle shows lock icon + "Upgrade to Pro" link if tenant plan does not include `reloWisa` feature.

### Modals / Drawers
- None

---

## Screen: User Management

**Route**: `/settings/users`
**Roles**: tenant_admin (F) | **Access**: Full (admin only)

### Purpose
Manage users within the tenant: invite new users, change roles, deactivate accounts.

### Layout
- **Header bar**: "User Management" title (left), "+ Invite User" primary button (right)
- **Summary bar**: "{ activeCount } active users of { seatLimit } seats" with progress bar. Warning badge if at 90%+ capacity.
- **Filter row**: Role dropdown (All / each role), Active toggle, search by name/email
- **Table columns**: Name (first + last), Email, Role (badge), Active (badge), Last Login, Created At, Actions
- **Role badge colors**: tenant_admin=red, inventory_manager=blue, procurement_manager=purple, receiving_manager=green, ecommerce_director=cyan, salesperson=amber, executive=slate
- **Pagination**: Bottom

### Primary Actions
- "+ Invite User": Opens Invite User modal
- Actions per row: "Edit Role" (opens modal), "Deactivate" (opens confirm modal), "Reactivate" (for deactivated users)
- Cannot deactivate yourself (button disabled with tooltip: "You cannot deactivate your own account.")

### Data Displayed
- All `users WHERE tenantId = currentTenant` with role, last login
- Seat usage: active user count vs. `tenants.seatLimit`

### States
- **Empty**: "No users yet. Invite your first team member." (should not normally occur since admin exists)
- **Loading**: Table skeleton
- **Error**: Error banner
- **Seat limit reached**: "+ Invite User" button shows warning icon, clicking opens upgrade prompt instead of invite modal.

### Modals / Drawers
- **Invite User Modal**:
  - Fields: First Name (text, required), Last Name (text, required), Email (email, required), Role (select from `user_role` enum, required)
  - Validation:
    - `firstName`: Required, max 100 chars.
    - `lastName`: Required, max 100 chars.
    - `email`: Required, valid email, unique per tenant. "A user with this email already exists."
    - `role`: Required.
  - Actions: "Cancel", "Send Invitation" (primary).
  - Sends invitation email. Creates user with `isActive = true`, `emailVerified = false`.
  - If seat limit would be exceeded: Shows error "Seat limit reached. Upgrade your plan or deactivate an existing user."

- **Edit User Role Modal**:
  - Shows user name and current role.
  - New Role (select from `user_role` enum).
  - Warning if changing from tenant_admin: "Removing admin role cannot be undone by this user."
  - Cannot change your own role (disabled with message).
  - Actions: "Cancel", "Update Role" (primary). PATCH `/api/auth/users/{userId}`.

- **Deactivate User Confirm Modal**:
  - "Deactivate {firstName} {lastName}? They will lose access immediately. Their data and audit history will be preserved."
  - Shows user's role and last login date.
  - Actions: "Cancel", "Deactivate" (destructive red). PATCH user `isActive = false`.

---

## Screen: Billing and Plans

**Route**: `/settings/billing`
**Roles**: tenant_admin (F), executive (R) | **Access**: F = manage subscription, R = view only

### Purpose
Display current subscription plan, usage metrics, and provide access to Stripe billing portal.

### Layout
- **Header**: "Billing & Plans" title
- **Current Plan card** (prominent):
  - Plan Name (e.g., "Pro"), Monthly Price, Billing Cycle (monthly/annual)
  - "Change Plan" button (F roles), "Manage Billing" button (F roles, opens Stripe portal)
- **Usage section** (two metric cards side by side):
  - **Cards**: Current card count / card limit, progress bar, overage count (if any), overage rate
  - **Seats**: Current seat count / seat limit, progress bar, overage count, overage rate
- **Plan Comparison table** (expandable):
  - Columns: Feature, Free, Starter, Pro, Enterprise
  - Rows: Price, Card Limit, Seat Limit, Multi-Location, Production Kanban, Transfer Kanban, ReLoWiSa, eCommerce API, Scheduled Reports, SSO, Webhooks, Priority Support
  - Current plan column highlighted
- **Billing History section**: Table of recent invoices from Stripe: Date, Amount, Status (paid/pending/failed), PDF link. "View All in Stripe" link.

### Primary Actions
- "Change Plan": Navigates to Stripe Customer Portal (external link) or shows upgrade modal with plan selection
- "Manage Billing": Opens Stripe Customer Portal for payment method management
- Invoice PDF link: Opens invoice PDF in new tab

### Data Displayed
- Tenant plan info from `tenants` (planId, cardLimit, seatLimit, stripeCustomerId, stripeSubscriptionId, trialEndsAt)
- Plan details from `subscription_plans`
- Usage from current `usage_records`
- Billing history from Stripe API (server-proxied)

### States
- **Loading**: Skeleton cards and table
- **Error**: Error banner for Stripe connection issues
- **Trial banner**: If `trialEndsAt` is set and in the future: "Your trial ends in {N} days. Upgrade to continue." with CTA.
- **Free plan**: "Change Plan" shows upgrade options. "Manage Billing" hidden.

### Modals / Drawers
- None (billing management defers to Stripe Customer Portal)

---

## Screen: Facilities

**Route**: `/settings/facilities`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: F = CRUD, R = view

### Purpose
Manage facilities (warehouses, plants, distribution centers) within the tenant.

### Layout
- **Header bar**: "Facilities" title (left), "+ Create Facility" button (right, F roles only)
- **Filter row**: Type dropdown (All/Warehouse/Plant/Distribution Center), Active toggle, search by name/code
- **Table columns**: Name (link), Code, Type (badge), City, State, Country, Active (badge), # Storage Locations, Actions
- **Type badge colors**: warehouse=blue, plant=purple, distribution_center=green
- **Pagination**: Bottom (usually small dataset, may not need pagination)

### Primary Actions
- "+ Create Facility": Opens Create Facility modal
- Row click / Name click: Navigates to `/settings/facilities/{id}/locations`
- Actions kebab (F roles): "Edit", "Deactivate"

### Data Displayed
- All `facilities` for tenant with storage location count

### States
- **Empty**: "No facilities configured. Create your first facility to set up your physical locations."
- **Loading**: Table skeleton
- **Error**: Error banner

### Modals / Drawers
- **Create Facility Modal**:
  - Fields: Name (text, required), Code (text, required, uppercase), Type (select: warehouse/plant/distribution_center, required), Address Line 1, Address Line 2, City, State, Postal Code, Country (select, default US), Timezone (searchable select, default America/Chicago)
  - Validation:
    - `name`: Required, max 255 chars. "Facility name is required."
    - `code`: Required, max 50 chars, unique per tenant. "Facility code is required." / "Code already exists."
    - `type`: Required.
  - Actions: "Cancel", "Create Facility" (primary). POST `/api/catalog/facilities`.

- **Edit Facility Modal**:
  - Same fields as Create, pre-populated. Code is **read-only**.
  - Actions: "Cancel", "Save Changes" (primary). PATCH `/api/catalog/facilities/{id}`.

- **Deactivate Facility Confirm**:
  - "Deactivate {name}? Active Kanban loops at this facility will NOT be deactivated. No new orders can be created for this facility."
  - Shows count of active loops and storage locations.
  - Actions: "Cancel", "Deactivate" (red). Blocks if it is the only active facility: "Cannot deactivate the last active facility."

---

## Screen: Storage Locations

**Route**: `/settings/facilities/:id/locations`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: F = CRUD, R = view

### Purpose
Manage storage locations (bins, shelves, zones) within a specific facility.

### Layout
- **Header**: "{Facility Name} -- Storage Locations" title, Facility code badge, "+ Create Location" button (F roles)
- **Breadcrumbs**: Settings > Facilities > {Facility Name} > Storage Locations
- **Filter row**: Zone dropdown (All / distinct zone values), Active toggle, search by name/code
- **Table columns**: Name, Code, Zone (badge), Description (truncated), Active (badge), Actions
- **Zone badge colors**: Auto-assigned from a color palette based on zone name hash
- **Pagination**: Bottom

### Primary Actions
- "+ Create Location": Opens Create Storage Location modal
- Actions per row (F roles): "Edit", "Deactivate"

### Data Displayed
- `storage_locations WHERE facilityId = :id` with zone grouping

### States
- **Empty**: "No storage locations defined for this facility. Create bins, shelves, or zones to organize inventory."
- **Loading**: Table skeleton
- **Error**: Error banner
- **404**: "Facility not found." (if facility ID is invalid)

### Modals / Drawers
- **Create Storage Location Modal**:
  - Fields: Name (text, required), Code (text, required, e.g., "A-01-03"), Zone (text with autocomplete from existing zones, optional), Description (textarea, optional)
  - Validation:
    - `name`: Required, max 255 chars. "Location name is required."
    - `code`: Required, max 100 chars, unique per facility per tenant. "Location code is required." / "Code already exists in this facility."
  - Actions: "Cancel", "Create Location" (primary). POST `/api/catalog/facilities/{facilityId}/locations`.

- **Edit Storage Location Modal**:
  - Same fields, pre-populated. Code is **read-only**.
  - Actions: "Cancel", "Save Changes" (primary). PATCH.
