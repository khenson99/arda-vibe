# Arda V2 -- Shared Screens

> Wireframe-level behavior specs for Dashboard, Notifications, Profile,
> Auth/Public, Reports, eCommerce, and Mobile/Scan screens.

---

## 1. Public / Authentication

---

### Screen: Login

**Route**: `/login`
**Roles**: Unauthenticated | **Access**: Public

#### Purpose
Authenticate existing users via email/password or Google OAuth.

#### Layout
- **Centered card** (max-width 400px) on a minimal background:
  - Arda logo (top center)
  - "Sign in to your account" heading
  - Email input (text, required)
  - Password input (password, required, show/hide toggle)
  - "Forgot password?" link (right-aligned, below password)
  - "Sign In" primary button (full width)
  - Divider: "or"
  - "Sign in with Google" OAuth button (full width, outline style with Google icon)
  - Bottom text: "Don't have an account? Register" with link to `/register`

#### Primary Actions
- "Sign In": POST `/api/auth/login` with email + password. On success: store JWT tokens, redirect to persona landing route. On error: show inline error.
- "Sign in with Google": Initiates OAuth flow via `/api/auth/google`. On success: same as above.
- "Forgot password?" link: Navigates to `/forgot-password`
- "Register" link: Navigates to `/register`

#### Data Displayed
- None (form only)

#### States
- **Loading**: "Sign In" button shows spinner, disabled
- **Error**: Inline error message below form: "Invalid email or password." / "Account is deactivated. Contact your administrator." / "Too many login attempts. Try again in {N} minutes."
- **Validation**:
  - `email`: Required, valid email format. "Enter your email address."
  - `password`: Required. "Enter your password."
- **Session expired redirect**: If redirected from an expired session, shows info banner above form: "Your session has expired. Please sign in again."
- **QR redirect**: If redirected from `/scan/:cardId`, shows info banner: "Sign in to view card details." and stores redirect URL for post-login.

#### Modals / Drawers
- None

---

### Screen: Register

**Route**: `/register`
**Roles**: Unauthenticated | **Access**: Public

#### Purpose
Register a new tenant (company) and its first admin user.

#### Layout
- **Centered card** (max-width 480px):
  - Arda logo
  - "Create your account" heading
  - Step indicator: Step 1 of 2
  - **Step 1: Company Info**
    - Company Name (text, required)
    - Company Slug (text, auto-generated from name, editable, required)
  - **Step 2: Admin User**
    - First Name (text, required)
    - Last Name (text, required)
    - Email (email, required)
    - Password (password, required, with strength indicator)
    - Confirm Password (password, required)
  - "Create Account" primary button
  - Divider: "or"
  - "Sign up with Google" OAuth button
  - Bottom: "Already have an account? Sign in" link

#### Primary Actions
- "Next" (Step 1): Validates company fields, advances to Step 2
- "Back" (Step 2): Returns to Step 1 with values preserved
- "Create Account": POST `/api/auth/register` with all fields. Creates tenant + admin user. Auto-logs in and redirects to `/dashboard`.
- "Sign up with Google": OAuth flow that collects company info first, then completes registration.

#### Data Displayed
- Slug preview: shows resulting URL pattern with slug

#### States
- **Loading**: Button spinner during registration
- **Error**: Inline field errors + toast for server errors
- **Validation**:
  - `companyName`: Required, max 255 chars. "Company name is required."
  - `slug`: Required, max 100 chars, lowercase alphanumeric + hyphens, unique. "Slug is required." / "This slug is already taken."
  - `firstName`: Required, max 100 chars.
  - `lastName`: Required, max 100 chars.
  - `email`: Required, valid email. "Enter a valid email." / "An account with this email already exists."
  - `password`: Required, min 8 chars, must contain uppercase, lowercase, number. Password strength meter: Weak (red), Fair (yellow), Good (blue), Strong (green).
  - `confirmPassword`: Must match password. "Passwords do not match."

#### Modals / Drawers
- None

---

### Screen: Forgot Password

**Route**: `/forgot-password`
**Roles**: Unauthenticated | **Access**: Public

#### Purpose
Request a password reset email.

#### Layout
- **Centered card** (max-width 400px):
  - Arda logo
  - "Reset your password" heading
  - Descriptive text: "Enter your email address and we'll send you a link to reset your password."
  - Email input (required)
  - "Send Reset Link" primary button (full width)
  - "Back to Sign In" link

#### Primary Actions
- "Send Reset Link": POST `/api/auth/forgot-password`. Always shows success message regardless of whether email exists (security best practice).
- "Back to Sign In": Navigates to `/login`

#### Data Displayed
- None

#### States
- **Loading**: Button spinner
- **Success**: Form replaced with: "Check your email. We've sent a password reset link to {email}. If you don't see it, check your spam folder." with "Back to Sign In" link.
- **Error**: Toast for server errors only (never reveal if email exists)
- **Validation**:
  - `email`: Required, valid email format.

#### Modals / Drawers
- None

---

### Screen: Reset Password

**Route**: `/reset-password/:token`
**Roles**: Unauthenticated | **Access**: Public (with valid token)

#### Purpose
Set a new password using a valid reset token from email.

#### Layout
- **Centered card** (max-width 400px):
  - Arda logo
  - "Set new password" heading
  - New Password (password, required, with strength indicator)
  - Confirm Password (password, required)
  - "Reset Password" primary button (full width)

#### Primary Actions
- "Reset Password": POST `/api/auth/reset-password` with token + new password. On success: redirect to `/login` with success toast "Password reset successfully. Please sign in."

#### Data Displayed
- None

#### States
- **Loading**: Button spinner
- **Invalid/Expired Token**: Full-page message: "This reset link is invalid or has expired. Request a new one." with link to `/forgot-password`.
- **Success**: Redirect to login with toast
- **Error**: Inline errors
- **Validation**:
  - `password`: Required, min 8 chars, uppercase + lowercase + number.
  - `confirmPassword`: Must match. "Passwords do not match."

#### Modals / Drawers
- None

---

### Screen: QR Scan Landing (Public)

**Route**: `/scan/:cardId`
**Roles**: Unauthenticated | **Access**: Public

#### Purpose
Handle QR code scans from physical Kanban cards. For unauthenticated users, prompt login then redirect. For authenticated users, show card info with trigger action.

#### Layout (unauthenticated)
- **Centered card**: Arda logo, "Sign in to manage this card" message, card UUID displayed (truncated), "Sign In" button. Stores `/scan/{cardId}` as post-login redirect.

#### Layout (authenticated)
- Redirects to authenticated `/scan/:cardId` (Scan Result screen)

#### Primary Actions
- "Sign In": Navigates to `/login` with return URL

#### States
- **Invalid Card ID**: "This QR code does not match any Kanban card in our system."

#### Modals / Drawers
- None

---

## 2. Dashboard

---

### Screen: Dashboard

**Route**: `/dashboard`
**Roles**: All authenticated roles (F) | **Access**: Full (content varies by role)

#### Purpose
Provide a persona-specific landing dashboard with key metrics, recent activity, and quick actions relevant to each role.

#### Layout
- **Header**: "Dashboard" title, "Good morning, {firstName}" greeting, current date
- **Widget grid** (responsive, 2-3 columns on desktop, 1 column mobile):
  - Widgets are conditionally rendered based on `user.role`
  - Each widget is a card (`rounded-xl shadow-sm`) with title, content, and optional "View All" link

#### Widgets by Role

**Operations Manager (tenant_admin)**:
1. **System Health**: Active loops, active cards, triggered cards (amber if > 0), open orders count
2. **Order Queue Summary**: Procurement / Production / Transfer queue counts, oldest item age
3. **Recent Activity**: Last 5 audit log entries across all domains
4. **Quick Actions**: "Create PO", "Create Loop", "Invite User"
5. **Stockout Risk**: Top 3 highest-risk items from queue risk scan

**Inventory Manager (inventory_manager)**:
1. **Kanban Summary**: Active loops by type, cards by stage distribution
2. **Triggered Cards**: Count of cards awaiting orders, oldest age
3. **ReLoWiSa Pending**: Count of pending recommendations with "Review" link
4. **Velocity Overview**: Avg cycle time (7d), trend arrow (up/down vs prev period)
5. **Quick Actions**: "View Cards", "Create Loop", "Cycle Count"

**Procurement Manager (procurement_manager)**:
1. **Order Queue**: Procurement queue count, oldest item, risk count
2. **Open POs**: PO count by status (sent, acknowledged, partially_received)
3. **Supplier Delivery**: On-time delivery rate (30d), late PO count
4. **Quick Actions**: "View Queue", "Create PO"
5. **Recent POs**: Last 5 POs with status badges

**Warehouse/Receiving (receiving_manager)**:
1. **Expected Deliveries**: POs/TOs expected today and this week
2. **Pending Receipts**: Count of POs/TOs in receivable status
3. **Recent Scans**: Last 5 scans by this user
4. **Quick Actions**: "Start Receiving", "Scan Card"

**eCommerce Director (ecommerce_director)**:
1. **Catalog Health**: Total sellable parts, out-of-stock sellable items
2. **API Activity**: API calls (24h), active API keys
3. **Webhook Status**: Configured webhooks, recent failures
4. **Quick Actions**: "View Catalog", "Manage API Keys"

**Salesperson (salesperson)**:
1. **Catalog Summary**: Total parts, sellable parts
2. **Quick Search**: Part search bar with top results
3. **Recent Views**: Last 5 parts viewed

**Executive (executive)**:
1. **KPI Summary**: Avg cycle time, on-time delivery rate, inventory turnover ratio
2. **Stockout Events** (30d): Count with trend
3. **Order Volume**: PO/WO/TO counts (30d) with trend
4. **Quick Links**: "Inventory Turnover", "Cycle Time Report", "Kanban Efficiency"

#### Primary Actions
- Widget "View All" links: Navigate to relevant list/detail pages
- Quick Action buttons: Navigate to create pages or specific workflows
- Widget metric clicks: Navigate to relevant filtered views

#### States
- **Loading**: Skeleton widget cards matching grid layout
- **Error**: Individual widget error states (one failing widget does not block others). Each shows "Failed to load" with retry.
- **Empty (new tenant)**: Welcome banner: "Welcome to Arda! Let's get started." with setup checklist: 1. Add a facility, 2. Create your first part, 3. Set up a Kanban loop.

#### Modals / Drawers
- None

---

## 3. Notifications

---

### Screen: Notification Center

**Route**: `/notifications`
**Roles**: All authenticated roles (F) | **Access**: Full

#### Purpose
Display in-app notifications with filtering, mark-as-read, and deep linking to relevant entities.

#### Layout
- **Header bar**: "Notifications" title (left), "Mark All Read" button (outline, right), "Preferences" link (right)
- **Filter tabs**: All | Unread | Read
- **Filter row**: Type dropdown (card_triggered, po_created, po_sent, po_received, stockout_warning, relowisa_recommendation, exception_alert, wo_status_change, transfer_status_change, system_alert)
- **Notification list** (card-based, not table):
  - Each notification card: Type icon (left), Title (bold), Body (truncated to 2 lines), Timestamp (relative, e.g., "3 hours ago"), Unread dot indicator (blue dot, left edge)
  - Click card: Marks as read + navigates to `actionUrl` if present, otherwise opens Notification Detail Drawer
  - Hover: "Mark as Read" / "Mark as Unread" icon button
- **Infinite scroll**: Load more on scroll (25 per page)

#### Primary Actions
- Card click: Mark read + navigate to deep link (if `actionUrl` exists)
- "Mark All Read": PATCH `/api/notifications/mark-all-read`, refreshes list
- "Preferences": Navigates to `/notifications/preferences`
- Type filter: Filters list by notification type

#### Data Displayed
- `notifications WHERE userId = currentUser` ordered by `createdAt DESC`
- Unread count badge shown in sidebar nav item

#### States
- **Empty**: "No notifications. You're all caught up!" with illustration
- **Empty (filtered)**: "No {type} notifications found."
- **Loading**: Skeleton notification cards
- **Error**: Error banner with retry

#### Modals / Drawers
- **Notification Detail Drawer** (right, 400px): Full notification body text, metadata (type, timestamp), "Go to {entity}" button if actionUrl exists. Mark as read on open. "Dismiss" button.

---

### Screen: Notification Preferences

**Route**: `/notifications/preferences`
**Roles**: All authenticated roles (F) | **Access**: Full

#### Purpose
Configure per-type, per-channel notification preferences for the current user.

#### Layout
- **Header**: "Notification Preferences" title, "Back to Notifications" link
- **Matrix table**: Rows = notification types, Columns = channels (In-App, Email, Webhook)
  - Each cell: Toggle switch (on/off)
  - Row labels with description: e.g., "Card Triggered -- When a Kanban card enters the triggered stage"
- **Notification type rows**:
  - Card Triggered
  - PO Created
  - PO Sent
  - PO Received
  - Stockout Warning
  - ReLoWiSa Recommendation
  - Exception Alert
  - WO Status Change
  - Transfer Status Change
  - System Alert
- **Channel columns**: In-App (always available), Email (always available), Webhook (available for Pro+ plans)
- **Footer**: "Save Preferences" primary button

#### Primary Actions
- Toggle switches: Optimistic UI update, debounced save
- "Save Preferences": Bulk save all preference changes via PUT `/api/notifications/preferences`

#### Data Displayed
- Current preferences from `notification_preferences WHERE userId = currentUser`
- Default to all enabled if no preferences exist

#### States
- **Loading**: Skeleton toggle matrix
- **Error**: Toast on save failure
- **Feature-gated**: Webhook column shows lock icon with "Upgrade to Pro" if plan lacks webhook feature

#### Modals / Drawers
- None

---

## 4. Profile

---

### Screen: User Profile

**Route**: `/profile`
**Roles**: All authenticated roles (F) | **Access**: Full (own profile only)

#### Purpose
Edit personal profile information: name, email, avatar, and password.

#### Layout
- **Header**: "Profile" title
- **Profile card** (centered, max-width 600px):
  - Avatar (circular image, 80px, click to upload new, or placeholder initials)
  - First Name (text input, required)
  - Last Name (text input, required)
  - Email (email input, read-only, displayed as text. Shows "Change email is not supported in MVP.")
  - Role (badge, read-only)
  - Joined date (text, read-only)
  - Last login (text, read-only)
  - "Save Profile" primary button
- **Security section** (below profile card):
  - "Change Password" button (outline)
  - OAuth connections: Shows linked Google account (if any), "Link Google Account" button if not linked

#### Primary Actions
- "Save Profile": PATCH `/api/auth/users/me` with name fields + avatar. Toast on success.
- Avatar click: Opens file picker, uploads image, updates preview
- "Change Password": Opens Change Password modal
- "Logout" button (bottom): Opens Confirm Logout modal

#### Data Displayed
- Current user data from JWT token + `GET /api/auth/users/me`

#### States
- **Loading**: Skeleton profile card
- **Error**: Toast on save failure, inline errors for validation
- **Validation**:
  - `firstName`: Required, max 100 chars.
  - `lastName`: Required, max 100 chars.
  - Avatar: Max 2MB, JPG/PNG format.

#### Modals / Drawers
- **Change Password Modal**:
  - Fields: Current Password (password, required), New Password (password, required, strength indicator), Confirm New Password (password, required)
  - Validation:
    - `currentPassword`: Required. "Enter your current password." Server validates: "Current password is incorrect."
    - `newPassword`: Required, min 8 chars, uppercase + lowercase + number. Must differ from current.
    - `confirmPassword`: Must match new password.
  - Actions: "Cancel", "Change Password" (primary). POST `/api/auth/change-password`.
  - On success: Toast "Password changed successfully.", modal closes.

- **Confirm Logout Modal**:
  - "Are you sure you want to sign out?"
  - Actions: "Cancel", "Sign Out" (primary). POST `/api/auth/logout` (revokes refresh token), clears local storage, redirects to `/login`.

---

## 5. Reports and Analytics

---

### Screen: Reports Home

**Route**: `/reports`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), ecommerce_director (R), executive (F) | **Access**: Read minimum

#### Purpose
Report catalog with descriptions and navigation to individual reports.

#### Layout
- **Header**: "Reports & Analytics" title
- **Report grid** (3 columns desktop, 1 mobile): Each report as a card with icon, title, description, "View Report" link
- **Report cards**:
  1. Inventory Turnover -- "Turnover ratio by part, category, and facility"
  2. Order Cycle Time -- "PO, WO, and TO lead times vs. stated"
  3. Stockout History -- "Historical stockout events and duration"
  4. Supplier Performance -- "On-time delivery, quality, lead time accuracy"
  5. Kanban Efficiency -- "Loop utilization, card velocity, ReLoWiSa impact"
  6. Audit Trail -- "Searchable log of all system actions"
  7. Audit Summary -- "Aggregated audit analytics by action, entity, and time"
  8. Data Exports -- "Export any report data as CSV or Excel"
- **Role filtering**: Cards not accessible to the current role are hidden

#### Primary Actions
- Card click / "View Report" link: Navigates to the specific report route

#### States
- **Loading**: Skeleton grid cards
- **Error**: Error banner

#### Modals / Drawers
- None

---

### Screen: Inventory Turnover

**Route**: `/reports/inventory-turnover`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), ecommerce_director (R), executive (F) | **Access**: Read

#### Purpose
Analyze inventory turnover ratio by part, category, and facility.

#### Layout
- **Header**: "Inventory Turnover" title, "Export" button, date range selector
- **Summary metrics** (3 cards): Overall Turnover Ratio, Best Performer (part), Worst Performer (part)
- **Chart**: Bar chart of turnover ratio by category or facility (toggle)
- **Detail table**: Part Number, Part Name, Category, Facility, COGS (period), Avg Inventory Value, Turnover Ratio, Days of Supply. Sortable columns.
- **Pagination**: Bottom

#### Primary Actions
- Date range change: Refreshes all metrics
- Group by toggle: Category / Facility / Part Type
- "Export": Opens Export Report modal
- Row click: Navigates to part detail

#### Data Displayed
- Computed metrics: Turnover = COGS / Avg Inventory Value
- Requires inventory transaction data and cost data

#### States
- **Empty**: "Not enough data to compute inventory turnover. Turnover requires at least one full month of transaction history."
- **Loading**: Skeleton metrics + chart + table
- **Error**: Error banner

#### Modals / Drawers
- **Report Date Range Picker**: Preset buttons (30d, 90d, 6m, 1y, YTD, Custom) + custom date range picker. Actions: "Apply", "Cancel".
- **Export Report Modal**: Format selector (CSV, Excel), date range confirmation, "Export" button. Triggers file download.

---

### Screen: Order Cycle Time

**Route**: `/reports/order-cycle-time`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), executive (F) | **Access**: Read

#### Purpose
Analyze PO, WO, and TO lead times comparing actual vs. stated.

#### Layout
- **Header**: "Order Cycle Time" title, "Export" button, date range selector
- **Summary metrics**: Avg PO Cycle Time (days), Avg WO Cycle Time, Avg TO Cycle Time, % On-Time (all types)
- **Chart**: Box plot or violin plot showing cycle time distribution per order type
- **Detail table**: Order Type, Order Number (link), Supplier/Facility, Stated Lead Time, Actual Lead Time, Variance (days), On-Time badge
- **Filter**: Order type (PO/WO/TO), Supplier, Facility

#### Primary Actions
- Filter changes, date range, export
- Order Number click: Navigates to order detail

#### States
- **Empty**: "No completed orders in the selected period."
- **Loading**: Skeleton
- **Error**: Error banner

#### Modals / Drawers
- Same date range picker and export modal as Inventory Turnover

---

### Screen: Stockout History

**Route**: `/reports/stockout-history`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), ecommerce_director (R), executive (F) | **Access**: Read

#### Purpose
Track historical stockout events: when inventory reached zero or triggered levels, duration, and impact.

#### Layout
- **Header**: "Stockout History" title, "Export", date range selector
- **Summary metrics**: Total Stockout Events, Avg Duration (hours), Most Affected Part, Most Affected Facility
- **Timeline chart**: Gantt-style chart showing stockout periods per part over time
- **Detail table**: Part (link), Facility, Start Date, End Date, Duration, Trigger (Kanban card ID link), Resolution (PO/WO/TO number link)

#### Primary Actions
- Date range, export, part/facility filter

#### States
- **Empty**: "No stockout events recorded in the selected period."
- **Loading**: Skeleton
- **Error**: Error banner

#### Modals / Drawers
- Date range picker + export modal

---

### Screen: Supplier Performance

**Route**: `/reports/supplier-performance`
**Roles**: tenant_admin (F), procurement_manager (R), executive (F) | **Access**: Read

#### Purpose
Evaluate supplier performance based on delivery, quality, and cost metrics.

#### Layout
- **Header**: "Supplier Performance" title, "Export", date range selector
- **Summary metrics**: Avg On-Time Rate (all suppliers), Best Supplier, Worst Supplier, Total Suppliers Evaluated
- **Scorecard table**: Supplier Name (link), # POs (period), On-Time Delivery %, Avg Lead Time vs Stated, Avg Cost Variance %, Quality Score (placeholder), Overall Score. Color-coded: green (>= 90%), yellow (70-89%), red (< 70%)
- **Chart**: Radar/spider chart for selected supplier comparing dimensions

#### Primary Actions
- Supplier row click: Navigates to supplier detail
- "Export", date range, supplier filter

#### States
- **Empty**: "Not enough completed POs to evaluate supplier performance. At least 3 completed POs per supplier needed."
- **Loading**: Skeleton
- **Error**: Error banner

#### Modals / Drawers
- Date range picker + export modal

---

### Screen: Kanban Efficiency

**Route**: `/reports/kanban-efficiency`
**Roles**: tenant_admin (F), inventory_manager (R), executive (F) | **Access**: Read

#### Purpose
Measure Kanban system efficiency: loop utilization, card velocity, and ReLoWiSa impact.

#### Layout
- **Header**: "Kanban Efficiency" title, "Export", date range selector
- **Summary metrics**: Active Loops, Avg Utilization %, Avg Cycle Time, ReLoWiSa Adoption Rate
- **Charts**:
  - Loop Utilization: Heatmap of loops x days, color intensity = utilization
  - Cycle Time Trend: Line chart, all loops averaged, with ReLoWiSa approval markers
  - Before/After ReLoWiSa: Grouped bar chart comparing pre- and post-recommendation cycle times
- **Loop table**: Loop (link), Part, Type, Avg Cycle Time, Utilization %, # Recommendations Applied, Impact (cycle time delta)

#### Primary Actions
- Loop row click: Navigates to `/kanban/velocity/{loopId}`
- Date range, export

#### States
- **Empty**: "Not enough Kanban cycle data for efficiency analysis."
- **Loading**: Skeleton
- **Error**: Error banner

#### Modals / Drawers
- Date range picker + export modal

---

### Screen: Audit Trail

**Route**: `/reports/audit-trail`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), executive (F) | **Access**: Read

#### Purpose
Searchable, filterable log of all significant system actions.

#### Layout
- **Header**: "Audit Trail" title, "Export", date range selector
- **Filter row**: Action type dropdown (card.triggered, po.created, po.sent, user.login, etc.), Entity Type dropdown (kanban_card, purchase_order, user, etc.), User dropdown, date range
- **Table columns**: Timestamp, Action (badge), Entity Type, Entity ID (link), User (name), IP Address, Details (expandable JSON)
- **Row expansion**: Click row to expand and show `previousState` and `newState` JSON diff (side-by-side)
- **Pagination**: Bottom, default 50 per page

#### Primary Actions
- Entity ID link: Navigate to entity detail (contextual)
- Row expand: Shows state diff
- "Export": Exports filtered results
- Filter changes: Refresh table

#### Data Displayed
- `audit_log` with user name join, ordered by timestamp DESC
- Entity type determines deep link target

#### States
- **Empty**: "No audit records found for the selected filters."
- **Loading**: Table skeleton
- **Error**: Error banner

#### Modals / Drawers
- Date range picker + export modal

---

### Screen: Audit Summary

**Route**: `/reports/audit-summary`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), executive (F) | **Access**: Read

#### Purpose
Aggregated audit analytics showing action patterns by type, entity, user, and time.

#### Layout
- **Header**: "Audit Summary" title, "Export", date range selector
- **Summary metrics**: Total Actions (period), Unique Users, Most Common Action, Peak Activity Hour
- **Charts**:
  - Actions by Type: Horizontal bar chart
  - Actions by Entity Type: Horizontal bar chart
  - Activity Heatmap: Day-of-week x hour-of-day heatmap
  - Top Users by Activity: Bar chart
  - Daily Action Trend: Line chart
- **Drill-down**: Click any chart segment to navigate to Audit Trail with corresponding filter

#### Primary Actions
- Chart segment click: Navigate to filtered Audit Trail
- Date range, export

#### States
- **Empty**: "No audit data in the selected period."
- **Loading**: Skeleton
- **Error**: Error banner

#### Modals / Drawers
- Date range picker + export modal

---

### Screen: Data Exports

**Route**: `/reports/exports`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), ecommerce_director (R), executive (F) | **Access**: Read

#### Purpose
Centralized export interface for generating CSV/Excel files from any report or data table.

#### Layout
- **Header**: "Data Exports" title
- **Export builder**:
  - Data Source selector: Parts Catalog, Suppliers, Purchase Orders, Work Orders, Transfer Orders, Kanban Loops, Kanban Cards, Audit Log, Inventory Turnover, Order Cycle Time
  - Date Range (if applicable): Start, End
  - Format: CSV, Excel (XLSX)
  - Filters (contextual based on data source)
  - "Generate Export" primary button
- **Recent Exports table**: Filename, Data Source, Generated At, Size, Status (ready/processing/failed), "Download" link
- Recent exports stored for 24 hours

#### Primary Actions
- "Generate Export": Queues export job, adds to Recent Exports table. Background processing for large datasets.
- "Download" link: Downloads the file

#### States
- **Empty (recent)**: "No recent exports. Generate your first export above."
- **Loading**: Processing spinner for active export jobs
- **Error**: Per-export error status with retry option

#### Modals / Drawers
- None

---

## 6. eCommerce / Distributor

---

### Screen: eCommerce Dashboard

**Route**: `/ecommerce`
**Roles**: tenant_admin (F), ecommerce_director (F), executive (R) | **Access**: F = manage, R = view

#### Purpose
Overview of eCommerce channel status: sellable catalog health, API activity, and webhook status.

#### Layout
- **Header**: "eCommerce" title
- **Metric cards** (4):
  - Sellable Parts: Count of parts with `isSellable = true`
  - Out of Stock: Sellable parts with zero inventory (placeholder metric for MVP)
  - Active API Keys: Count
  - Webhook Deliveries (24h): Success / Failure counts
- **Quick links**: "Manage Catalog", "API Keys", "Webhooks"
- **Recent API Activity**: Last 10 API calls with timestamp, method, endpoint, status code, API key name

#### Primary Actions
- Metric card click: Navigate to relevant sub-page
- Quick link click: Navigate to sub-page

#### States
- **Empty**: "eCommerce not configured yet. Start by marking parts as sellable and creating an API key."
- **Loading**: Skeleton metric cards
- **Error**: Error banner

#### Modals / Drawers
- None

---

### Screen: Sellable Catalog

**Route**: `/ecommerce/catalog`
**Roles**: tenant_admin (F), ecommerce_director (F), executive (R) | **Access**: F = manage sellable flag, R = view

#### Purpose
Manage which parts are exposed to the eCommerce/distributor API with pricing and availability.

#### Layout
- **Header**: "Sellable Catalog" title
- **Filter row**: Category, Part Type, search by part number/name
- **Table columns**: Part Number (link), Name, Type badge, Category, Unit Price, Sellable (toggle for F roles), Active, Availability Status
- **Bulk actions** (F roles): Select parts, "Mark Sellable" / "Mark Not Sellable"

#### Primary Actions
- Sellable toggle: PATCH part `isSellable`, immediate save
- Bulk mark: PATCH multiple parts
- Part Number link: Navigate to part detail
- "Export Catalog" button: Downloads current sellable catalog as CSV

#### Data Displayed
- `parts WHERE isActive = true` with sellable flag editable
- Availability computed from inventory levels (placeholder for MVP)

#### States
- **Empty**: "No parts in the catalog. Add parts in the Parts Catalog section first."
- **Loading**: Table skeleton
- **Error**: Error banner

#### Modals / Drawers
- None

---

### Screen: API Key Management

**Route**: `/ecommerce/api-keys`
**Roles**: tenant_admin (F), ecommerce_director (F) | **Access**: Full

#### Purpose
Create and manage API keys for distributor/eCommerce integrations.

#### Layout
- **Header**: "API Keys" title, "+ Create API Key" primary button
- **Table columns**: Key Name, Key Prefix (first 8 chars + "..."), Created At, Last Used At, Status (active/revoked badge), Actions
- **Important**: Full API key is only shown once at creation time.

#### Primary Actions
- "+ Create API Key": Opens Create API Key modal
- Actions per row: "Revoke" (opens confirm)

#### Data Displayed
- API keys for this tenant (stored server-side, only prefix shown)

#### States
- **Empty**: "No API keys. Create an API key to enable distributor integrations."
- **Loading**: Table skeleton
- **Error**: Error banner

#### Modals / Drawers
- **Create API Key Modal**:
  - Fields: Key Name (text, required, max 100 chars)
  - Actions: "Cancel", "Create Key" (primary)
  - On success: Shows full API key in a copyable field with warning: "Copy this key now. It will not be shown again." and "Copy" button. "Done" button to close.

- **Revoke API Key Confirm**:
  - "Revoke API key '{name}'? Any integrations using this key will immediately stop working."
  - Actions: "Cancel", "Revoke" (destructive red)

---

### Screen: Webhook Config

**Route**: `/ecommerce/webhooks`
**Roles**: tenant_admin (F), ecommerce_director (F) | **Access**: Full

#### Purpose
Configure outbound webhooks for inventory and order events.

#### Layout
- **Header**: "Webhooks" title, "+ Create Webhook" primary button
- **Table columns**: Name, URL (truncated), Events (badge list), Status (active/paused badge), Last Triggered, Last Status Code, Failures (24h), Actions
- **Event types available**: inventory.updated, order.created, order.status_changed, part.updated, stockout.detected

#### Primary Actions
- "+ Create Webhook": Opens Create Webhook modal
- Actions per row: "Edit", "Pause"/"Resume", "Delete", "Test" (sends test payload)
- "Test": Sends test event, shows result toast (success/failure with status code)

#### Data Displayed
- Webhook configurations for this tenant
- Recent delivery stats

#### States
- **Empty**: "No webhooks configured. Create a webhook to receive real-time event notifications."
- **Loading**: Table skeleton
- **Error**: Error banner

#### Modals / Drawers
- **Create Webhook Modal**:
  - Fields: Name (text, required), URL (URL input, required, must be HTTPS), Events (multi-select checkboxes from available event types, at least 1 required), Secret (auto-generated, shown once, used for signature verification)
  - Validation:
    - `name`: Required, max 100 chars.
    - `url`: Required, valid HTTPS URL. "URL must use HTTPS."
    - `events`: At least 1 event type required.
  - Actions: "Cancel", "Create Webhook" (primary)

- **Edit Webhook Modal**:
  - Same fields as create, pre-populated. URL and Events editable. Secret shown as masked with "Regenerate" option.
  - Actions: "Cancel", "Save Changes" (primary)

---

## 7. Scanning / Mobile (PWA)

---

### Screen: Scan Result

**Route**: `/scan/:cardId` (authenticated)
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (F), receiving_manager (F) | **Access**: F = trigger action

#### Purpose
Display Kanban card information after QR scan and enable stage transition (trigger action).

#### Layout
- **Mobile-optimized** (full-width, large touch targets):
  - **Card header**: Card #{cardNumber}, Part Number + Name (large), Loop Type badge
  - **Current Stage**: Large badge with stage name and duration in stage
  - **Key info cards**: Facility, Min Qty, Order Qty, loop supplier/source
  - **Action section** (bottom, fixed):
    - If stage allows transition: Large "Trigger" / "Advance to {nextStage}" primary button (full width, 56px height)
    - Stage workflow visual: Horizontal stage progress indicator showing all stages with current highlighted
  - **Recent transitions**: Last 3 transitions for this card

#### Primary Actions
- "Trigger" / "Advance": Opens Scan Trigger Confirm modal, then POST transition
- Part Number tap: Navigate to part detail
- "View Full Card Detail" link: Navigate to `/kanban/cards/{cardId}`

#### Data Displayed
- Card, loop, part, and facility data
- Recent transitions
- Valid next stage(s)

#### States
- **Loading**: Large skeleton card
- **Error**: Error banner with retry
- **Invalid Card**: "Card not found. This QR code may belong to a different organization or be invalid."
- **Inactive Card**: "This card is deactivated." with no action buttons
- **No Valid Transition**: Stage indicator shown but action button disabled with tooltip: "No transitions available from {currentStage}."

#### Modals / Drawers
- **Scan Trigger Confirm Modal**: "Advance card to {nextStage}?" Shows card number, part, current -> next stage. Optional notes input. Method auto-set to "qr_scan". Actions: "Cancel", "Confirm" (primary, large touch target). Success: Brief success animation, then updated card display.

---

### Screen: Scan History

**Route**: `/scan/history`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (F), receiving_manager (F) | **Access**: Read

#### Purpose
Show recent QR scans performed by the current user.

#### Layout
- **Mobile-optimized** list view:
  - Header: "Scan History" title
  - List of recent scans: Card # (link), Part Name, Stage at scan time, Transition made (if any), Timestamp (relative). Grouped by date.
  - Pull-to-refresh gesture (mobile)

#### Primary Actions
- Scan entry tap: Navigate to `/kanban/cards/{cardId}`
- Pull-to-refresh: Reload list

#### Data Displayed
- `card_stage_transitions WHERE transitionedByUserId = currentUser AND method = 'qr_scan'` ordered by date DESC
- Limited to last 100 entries

#### States
- **Empty**: "No scan history yet. Scan a Kanban card QR code to get started."
- **Loading**: Skeleton list
- **Error**: Error banner

#### Modals / Drawers
- None

---

### Screen: Mobile Receiving

**Route**: `/mobile/receiving`
**Roles**: tenant_admin (F), procurement_manager (W), receiving_manager (F) | **Access**: Write

#### Purpose
Simplified receiving interface for warehouse floor use on mobile devices.

#### Layout
- **Mobile-optimized** (designed for phone/tablet on warehouse floor):
  - **Header**: "Receiving" title, facility selector (if user has access to multiple)
  - **Pending Receipts section**: Cards for each PO/TO awaiting receipt at selected facility:
    - PO/TO Number, Supplier/Source, Expected Date, # Lines, "Start Receiving" button
  - **Active Receipt section** (when a PO/TO is selected for receiving):
    - Order info header bar
    - Line item list: Each line as a card with Part Number, Part Name, Qty Ordered, Qty Received, large "+" and "-" buttons for quantity input, "Done" checkmark button per line
    - Running total: "X of Y lines complete"
    - "Complete Receipt" button (full width, bottom fixed, enabled when at least 1 line has qty > 0)
  - **Barcode scanner integration**: Camera icon button to scan part UPC, auto-selects matching line item

#### Primary Actions
- "Start Receiving" per order: Loads line items for that order
- +/- quantity buttons: Increment/decrement received quantity
- "Done" per line: Marks line as fully received (fills remaining qty)
- "Complete Receipt": PATCH receipt, returns to pending list with success toast
- Barcode scan: Opens camera, reads UPC, highlights matching line

#### Data Displayed
- Pending receivable orders (POs with status sent/acknowledged/partially_received, TOs with status shipped/in_transit) filtered by selected facility
- Line items for active order

#### States
- **Empty**: "No pending receipts at {facility}. All caught up!" with illustration
- **Loading**: Skeleton cards
- **Error**: Toast for errors (non-blocking, mobile-friendly)
- **Offline capability** (future): Queue receipts locally, sync when online

#### Modals / Drawers
- None (designed for single-flow mobile interaction)

---

### Screen: Cycle Count

**Route**: `/mobile/cycle-count`
**Roles**: tenant_admin (F), inventory_manager (F), receiving_manager (F) | **Access**: Write

#### Purpose
Scan-driven cycle count workflow for inventory accuracy verification.

#### Layout
- **Mobile-optimized**:
  - **Header**: "Cycle Count" title, Facility selector, "Start New Count" primary button
  - **Active count session** (when started):
    - Scan zone: Large camera viewfinder area for barcode/QR scanning
    - Scanned items list: Part Number, Part Name, System Qty (expected), Counted Qty (editable number input), Variance (computed, color-coded: green if match, red if mismatch)
    - Manual add: Search field to find parts without scanning
    - Running totals: Items counted, items with variance
    - "Complete Count" button (bottom fixed)
  - **Count history section** (when no active count): List of previous counts with date, facility, item count, variance summary

#### Primary Actions
- "Start New Count": Begins new session, activates scanner
- Scan part: Adds to list with system qty pre-filled, cursor on counted qty input
- Manual qty entry: Tap counted qty, enter number
- "Complete Count": Saves count results, calculates variances, submits for review
- "Discard Count": Cancels active session (with confirmation)

#### Data Displayed
- System inventory quantities (placeholder for MVP -- will need inventory service)
- Previous count results

#### States
- **Empty (history)**: "No cycle counts performed yet."
- **Active session**: Scanner active, count in progress
- **Loading**: Skeleton
- **Error**: Toast
- **Camera permission**: Prompt for camera access if not granted

#### Modals / Drawers
- None (single-flow mobile)
