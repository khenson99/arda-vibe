# Arda V2 -- Kanban System Screens

> Wireframe-level behavior specs for all Kanban system screens.
> Covers loops, cards, velocity analytics, and ReLoWiSa recommendations.

---

## Screen: Kanban Overview

**Route**: `/kanban`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: Read minimum

### Purpose
Provide a summary dashboard of the entire Kanban system: loop counts by type, card stage distribution, and key health metrics.

### Layout
- **Header**: "Kanban Overview" title, no primary action button
- **Metric cards row** (4 cards): Total Active Loops, Total Active Cards, Cards in Triggered Stage, Avg Cycle Time (days)
- **Loop Type Distribution**: Horizontal bar chart showing procurement / production / transfer loop counts
- **Card Stage Funnel**: Stacked bar or funnel chart showing card counts per stage (created, triggered, ordered, in_transit, received, restocked)
- **Recent Activity Feed**: Last 10 card transitions with timestamp, card ID, loop name, from/to stage
- **Quick Links**: "View All Loops" | "View All Cards" | "Velocity Dashboard"

### Primary Actions
- Click metric card: Navigates to filtered Loop List or Card List
- Click loop type bar segment: Navigates to `/kanban/loops?loopType={type}`
- Click card stage segment: Navigates to `/kanban/cards?stage={stage}`
- Click activity row: Navigates to `/kanban/cards/{cardId}`

### Data Displayed
- `totalActiveLoops`: count from `kanban_loops WHERE isActive = true`
- `totalActiveCards`: count from `kanban_cards WHERE isActive = true`
- `triggeredCardCount`: count from `kanban_cards WHERE currentStage = 'triggered'`
- `avgCycleTimeDays`: computed from `card_stage_transitions` (restocked - triggered, last 30 days)
- `loopsByType`: grouped count of loops by `loopType`
- `cardsByStage`: grouped count of cards by `currentStage`
- `recentTransitions`: last 10 `card_stage_transitions` with joined card/loop names

### States
- **Empty**: "No Kanban loops configured yet. Create your first loop to get started." with "Create Loop" CTA button
- **Loading**: 4 skeleton metric cards, skeleton chart placeholders, skeleton activity rows
- **Error**: Error banner: "Failed to load Kanban overview. Retry." with retry button

### Modals / Drawers
- None

---

## Screen: Loop List

**Route**: `/kanban/loops`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: Read minimum

### Purpose
Display a filterable, sortable table of all Kanban loops for the tenant.

### Layout
- **Header bar**: "Kanban Loops" title (left), "+ Create Loop" primary button (right, hidden for R roles)
- **Filter row**: Loop Type dropdown (All/Procurement/Production/Transfer), Facility dropdown, Active toggle (Yes/No/All), search by part name/number
- **Table columns**: Loop ID (hidden), Part Number, Part Name, Loop Type (badge), Facility, Card Mode, Min Qty, Order Qty, # Cards, Active (badge), Primary Supplier / Source, Actions
- **Pagination**: Bottom row with "Showing X-Y of Z" and page controls

### Primary Actions
- "+ Create Loop": Navigates to `/kanban/loops/new`
- Row click: Navigates to `/kanban/loops/{id}`
- Actions column: Kebab menu with "Edit", "View Cards", "Deactivate"

### Data Displayed
- `partNumber`, `partName`: joined from `parts` via `partId`
- `loopType`: enum badge (procurement=blue, production=purple, transfer=green)
- `facilityName`: joined from `facilities` via `facilityId`
- `cardMode`: "Single" | "Multi"
- `minQuantity`, `orderQuantity`, `numberOfCards`: direct fields
- `isActive`: badge (active=green, inactive=gray)
- `primarySupplierName` or `sourceFacilityName`: conditional on `loopType`

### States
- **Empty**: "No Kanban loops found. Create your first loop to start managing inventory with Kanban." with "Create Loop" CTA
- **Empty (filtered)**: "No loops match your filters." with "Clear Filters" link
- **Loading**: Table skeleton with 8 shimmer rows
- **Error**: Error banner above table with retry button

### Modals / Drawers
- **Deactivate Loop Confirm**: Triggered from kebab menu. "Deactivate Loop for {Part Name}? All cards in this loop will be deactivated. This can be reversed." Actions: "Cancel" (outline), "Deactivate" (destructive red)

---

## Screen: Create Loop

**Route**: `/kanban/loops/new`
**Roles**: tenant_admin (F), inventory_manager (F) | **Access**: Write

### Purpose
Form to create a new Kanban loop, defining the part, facility, loop type, and replenishment parameters.

### Layout
- **Header**: "Create Kanban Loop" title with breadcrumbs: Kanban > Loops > New Loop
- **Form body** (single column, card container):
  - Section 1: "Basic Information"
    - Part (searchable select, required)
    - Facility (select, required)
    - Storage Location (select, optional, filtered by facility)
    - Loop Type (radio group: Procurement / Production / Transfer, required)
  - Section 2: "Parameters"
    - Min Quantity / Reorder Point (number input, required)
    - Order Quantity (number input, required)
    - Number of Cards (number input, required, default 1)
    - Card Mode (radio: Single / Multi, default Single)
    - Safety Stock Days (number input, optional, default 0)
    - Stated Lead Time Days (number input, optional)
  - Section 3: "Source Assignment" (conditional on loop type)
    - If Procurement: Primary Supplier (searchable select from suppliers linked to chosen part)
    - If Transfer: Source Facility (select, required, must differ from destination facility)
    - If Production: No additional fields
  - Section 4: "Notes" (optional textarea)
- **Footer**: "Cancel" (left, navigates back), "Create Loop" (right, primary button)

### Primary Actions
- "Create Loop": POST to `/api/kanban/loops`, on success navigate to `/kanban/loops/{newId}`
- "Cancel": Navigate to `/kanban/loops` with unsaved-changes prompt if dirty

### Data Displayed
- Part select options: from `GET /api/catalog/parts?isActive=true`
- Facility options: from `GET /api/catalog/facilities?isActive=true`
- Storage locations: from `GET /api/catalog/facilities/{id}/locations`
- Supplier options: from `GET /api/catalog/parts/{partId}/suppliers`

### States
- **Loading**: Skeleton form while initial select options load
- **Error**: Inline field errors for validation failures, toast for server error
- **Validation**:
  - `partId`: Required. "Select a part."
  - `facilityId`: Required. "Select a facility."
  - `loopType`: Required. "Select a loop type."
  - `minQuantity`: Required, integer > 0. "Min quantity must be at least 1."
  - `orderQuantity`: Required, integer > 0. "Order quantity must be at least 1."
  - `numberOfCards`: Required, integer >= 1, <= 99. "Number of cards must be 1-99."
  - `safetyStockDays`: Optional, numeric >= 0. "Safety stock must be 0 or greater."
  - `statedLeadTimeDays`: Optional, integer >= 0. "Lead time must be 0 or greater."
  - `primarySupplierId`: Required if loopType = procurement. "Select a supplier for procurement loops."
  - `sourceFacilityId`: Required if loopType = transfer, must not equal facilityId. "Source must differ from destination."
  - **Uniqueness**: One loop per (tenant, part, facility, loopType). Server returns 409 if duplicate.

### Modals / Drawers
- None (unsaved-changes dialog is browser-native `beforeunload`)

---

## Screen: Loop Detail

**Route**: `/kanban/loops/:id`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: Read minimum

### Purpose
Display comprehensive information about a single Kanban loop: its configuration, cards, parameter history, and ReLoWiSa recommendations.

### Layout
- **Header**: Part Number + Part Name (large), Loop Type badge, Active/Inactive badge, action buttons row
  - Action buttons (F roles): "Edit Loop", "Add Card", "Deactivate" (if active) / "Activate" (if inactive)
- **Tab navigation**: Overview | Cards | Parameter History | Recommendations
- **Overview tab**:
  - Left column: Key-value pairs: Part, Facility, Storage Location, Loop Type, Card Mode, Min Qty, Order Qty, # Cards, Safety Stock Days, Stated Lead Time, Primary Supplier / Source Facility, Notes
  - Right column: Mini velocity chart (last 30 days avg cycle time trend), current card stage distribution pie chart
- **Cards tab**: Table of cards in this loop with columns: Card #, Current Stage (badge), Stage Entered At, Linked Order, Completed Cycles, Last Printed, Active
- **Parameter History tab**: Timeline list of parameter changes: date, change type, old values, new values, changed by, reason
- **Recommendations tab**: List of ReLoWiSa recommendations for this loop: status badge, recommended values, confidence, reasoning, actions

### Primary Actions
- "Edit Loop": Navigates to `/kanban/loops/{id}/edit`
- "Add Card": Opens Add Card modal
- "Deactivate" / "Activate": Opens confirmation modal then PATCH `/api/kanban/loops/{id}`
- Card row click: Navigates to `/kanban/cards/{cardId}`
- Recommendation "Review": Opens ReLoWiSa Review drawer

### Data Displayed
- Loop fields: all columns from `kanban_loops` with joined part, facility, supplier, source facility names
- Cards: from `kanban_cards WHERE loopId = :id` with joined order numbers
- Parameter history: from `kanban_parameter_history WHERE loopId = :id` ordered by createdAt DESC
- Recommendations: from `relowisa_recommendations WHERE loopId = :id` ordered by createdAt DESC

### States
- **Empty (Cards tab)**: "No cards in this loop yet. Add a card to begin the Kanban cycle." with "Add Card" button
- **Empty (History tab)**: "No parameter changes recorded yet."
- **Empty (Recommendations tab)**: "No ReLoWiSa recommendations yet. Recommendations are generated after sufficient cycle data is collected."
- **Loading**: Skeleton layout for header and active tab content
- **Error**: Error banner with retry
- **404**: "Loop not found" with back link to `/kanban/loops`

### Modals / Drawers
- **Deactivate Loop Confirm**: "Deactivate this loop? All cards will be deactivated. Active orders linked to cards will not be affected." Actions: "Cancel", "Deactivate" (red)
- **Add Card to Loop**: "Add Card to Loop". Shows current card count, next card number. Actions: "Cancel", "Add Card" (primary). POST `/api/kanban/loops/{id}/cards`
- **Card Quick View Drawer**: Triggered by clicking card row in cards tab with detail icon. Shows card detail preview in right drawer: card number, stage, stage timeline, linked order link, print button. Width: 400px.
- **ReLoWiSa Review Drawer**: Shows recommendation details, current vs. recommended values side-by-side, confidence score bar, reasoning text, projected impact metrics. Actions: "Reject" (outline) with required reason textarea, "Approve" (primary). Width: 500px.

---

## Screen: Edit Loop

**Route**: `/kanban/loops/:id/edit`
**Roles**: tenant_admin (F), inventory_manager (F) | **Access**: Write

### Purpose
Modify the parameters of an existing Kanban loop. Changes are recorded in parameter history.

### Layout
Identical to Create Loop form, but pre-populated with current values. The following fields are **read-only** after creation:
- Part (displayed as text, not editable)
- Facility (displayed as text, not editable)
- Loop Type (displayed as badge, not editable)

Editable fields:
- Storage Location, Card Mode, Min Quantity, Order Quantity, Number of Cards, Safety Stock Days, Stated Lead Time Days, Primary Supplier / Source Facility, Notes

Additional element:
- **Change reason** (textarea, required): "Describe why you are changing these parameters." This is stored in `kanban_parameter_history.reason`.

### Primary Actions
- "Save Changes": PATCH to `/api/kanban/loops/{id}` with changed fields + reason. Redirects to loop detail on success.
- "Cancel": Navigate to `/kanban/loops/{id}` with unsaved-changes prompt if dirty

### Data Displayed
- Pre-populated from GET `/api/kanban/loops/{id}`

### States
- **Loading**: Skeleton form
- **Error**: Inline field errors, toast for server error
- **Validation**: Same as Create Loop, plus:
  - `reason`: Required. "Provide a reason for this change."
  - `numberOfCards`: If decreased below current active card count, show warning: "Reducing cards below current count will deactivate excess cards."

### Modals / Drawers
- None (browser `beforeunload` for unsaved changes)

---

## Screen: Card List

**Route**: `/kanban/cards`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: Read minimum

### Purpose
Display all Kanban cards across all loops with filtering by stage, loop type, and facility.

### Layout
- **Header bar**: "Kanban Cards" title (left), no primary create button (cards are created from loops)
- **Filter row**: Stage multi-select (created, triggered, ordered, in_transit, received, restocked), Loop Type dropdown, Facility dropdown, Active toggle, search by card ID or part name
- **Table columns**: Card UUID (truncated), Card # ("Card X of Y"), Part Number, Part Name, Loop Type (badge), Facility, Current Stage (badge), Stage Duration (human-readable time since stage entered), Linked Order, Completed Cycles, Active
- **Pagination**: Bottom row

### Primary Actions
- Row click: Navigates to `/kanban/cards/{id}`
- Stage badge click: Filters table by that stage
- Linked Order click: Navigates to the linked PO/WO/TO detail page
- Bulk actions (F roles): Select multiple cards via checkboxes, "Bulk Transition" dropdown appears in header

### Data Displayed
- All cards from `kanban_cards` with joined loop, part, facility data
- `stageDuration`: computed from `currentStageEnteredAt` to now
- `linkedOrder`: conditional display of PO/WO/TO number with link

### States
- **Empty**: "No Kanban cards exist yet. Create cards from the Loop Detail page."
- **Empty (filtered)**: "No cards match your filters." with "Clear Filters" link
- **Loading**: Table skeleton
- **Error**: Error banner with retry

### Modals / Drawers
- **Card Quick View Drawer**: Same as Loop Detail card quick view. Triggered by detail icon on row.

---

## Screen: Card Detail

**Route**: `/kanban/cards/:id`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: Read minimum

### Purpose
Show complete information about a single Kanban card: its current stage, QR code, full transition history, and linked order.

### Layout
- **Header**: "Card #{cardNumber}" + card UUID (truncated, copyable), Loop name subtitle, Current Stage badge (large), Action buttons
  - Action buttons (F roles): "Transition" (primary, dropdown with valid next stages), "Print Card", "Deactivate"
  - Action buttons (R roles): "Print Card" only (if allowed)
- **Two-column layout**:
  - **Left column (60%)**:
    - Card Info panel: Part Number, Part Name, Loop Type, Facility, Storage Location, Card Mode, Completed Cycles, Active status
    - Transition History: Vertical timeline of all stage transitions for current cycle. Each entry shows: from/to stage, timestamp, transitioned by (user name), method (QR scan / manual / system), notes
    - Previous Cycles: Expandable accordion showing transition history for completed cycles
  - **Right column (40%)**:
    - QR Code panel: Large QR code rendering of card UUID, "Print" button, "Copy UUID" button
    - Linked Order panel (if ordered/in_transit): Order type badge, order number link, order status, expected delivery
    - Loop Parameters panel: Min Qty, Order Qty, current loop values for context

### Primary Actions
- "Transition" dropdown: Opens Transition Card Confirm modal with selected next stage
- "Print Card": Navigates to `/kanban/cards/{id}/print`
- "Deactivate": Confirmation modal, then PATCH card
- Linked order number click: Navigates to PO/WO/TO detail
- Loop name in subtitle: Navigates to `/kanban/loops/{loopId}`

### Data Displayed
- Card: all fields from `kanban_cards` with joined loop, part, facility
- Transitions: from `card_stage_transitions WHERE cardId = :id` ordered by `transitionedAt ASC`, grouped by `cycleNumber`
- Linked order: conditional join to purchase_orders / work_orders / transfer_orders
- Valid next stages: computed from current stage according to allowed transitions:
  - created -> triggered
  - triggered -> ordered
  - ordered -> in_transit
  - in_transit -> received
  - received -> restocked
  - restocked -> triggered (new cycle)

### States
- **Loading**: Skeleton for header, QR placeholder, timeline skeleton
- **Error**: Error banner with retry
- **404**: "Card not found" with back link

### Modals / Drawers
- **Transition Card Confirm**: "Move card from {currentStage} to {targetStage}?" Shows card number, part name. Optional notes textarea. Method auto-set to "manual". Actions: "Cancel", "Confirm Transition" (primary). POST `/api/kanban/cards/{id}/transition`
- **Print Options Modal**: Format selector (3x5, 4x6, label), quantity input. Actions: "Cancel", "Print" (triggers `/kanban/cards/{id}/print` with params)

---

## Screen: Card Print

**Route**: `/kanban/cards/:id/print`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R) | **Access**: Read minimum

### Purpose
Render a print-ready card layout with QR code for physical Kanban card production.

### Layout
- **Print toolbar** (screen only, hidden in print): Format selector (3x5 inches, 4x6 inches, Label 2x1 inches), "Print" button, "Back to Card" link
- **Print preview area**: Centered card preview at actual size within a dotted border
- **Card layout** (inside print area):
  - QR code (large, centered)
  - Card UUID text (small, below QR)
  - Part Number + Part Name
  - "Card {X} of {Y}"
  - Loop Type badge
  - Facility name
  - Min Qty / Order Qty
  - Tenant logo (if configured)

### Primary Actions
- "Print": Triggers `window.print()` with CSS `@media print` rules hiding toolbar
- Format selector: Changes card dimensions and font sizes in preview
- "Back to Card": Navigates to `/kanban/cards/{id}`

### Data Displayed
- All card and loop fields needed for the physical card
- QR code generated client-side from card UUID

### States
- **Loading**: Skeleton card preview
- **Error**: "Failed to load card data" with retry

### Modals / Drawers
- None

---

## Screen: Velocity Dashboard

**Route**: `/kanban/velocity`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), executive (R) | **Access**: Read minimum

### Purpose
Display cycle time analytics and throughput metrics across all Kanban loops.

### Layout
- **Header**: "Kanban Velocity" title
- **Date range selector**: Preset buttons (7d, 30d, 90d, YTD, Custom) with date picker
- **Summary metric cards** (4):
  - Avg Cycle Time (all loops)
  - Median Cycle Time
  - Throughput (cycles completed in period)
  - Loops Analyzed
- **Charts section**:
  - Cycle Time Trend: Line chart, X = date, Y = avg cycle time in days, one line per loop type
  - Stage Duration Breakdown: Stacked bar chart showing avg time spent in each stage
  - Top 10 Slowest Loops: Horizontal bar chart ranking by avg cycle time
  - Top 10 Fastest Loops: Horizontal bar chart
- **Loop table**: All loops with velocity metrics: Loop Name, Part, Loop Type, Avg Cycle Time, Median, P90, # Cycles, Trend (sparkline)

### Primary Actions
- Loop row click: Navigates to `/kanban/velocity/{loopId}`
- Date range change: Refreshes all metrics and charts
- Chart bar/point click: Drills into specific loop or time period

### Data Displayed
- Metrics computed from `card_stage_transitions` aggregated by loop and date range
- `avgCycleTime`: mean(restocked_at - triggered_at) for completed cycles
- `medianCycleTime`: median of the same
- `throughput`: count of completed cycles in period
- Stage durations: avg time between consecutive stage transitions

### States
- **Empty**: "No velocity data yet. Velocity metrics are calculated from completed Kanban cycles."
- **Loading**: Skeleton metric cards, chart placeholders
- **Error**: Error banner with retry

### Modals / Drawers
- None

---

## Screen: Loop Velocity Detail

**Route**: `/kanban/velocity/:loopId`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), executive (R) | **Access**: Read minimum

### Purpose
Show detailed velocity analytics for a single Kanban loop over time.

### Layout
- **Header**: "{Part Name} -- Velocity" title, Loop Type badge, "View Loop" link
- **Date range selector**: Same as Velocity Dashboard
- **Summary metrics** (6 cards):
  - Avg Cycle Time, Median Cycle Time, P90 Cycle Time, Total Cycles, Active Cards, Current Throughput Rate
- **Charts**:
  - Individual Cycle Times: Scatter plot, each point is one cycle completion, X = date, Y = days
  - Stage Duration Waterfall: Waterfall chart showing avg contribution of each stage to total cycle time
  - Cycle Time Control Chart: Line with upper/lower control limits, mean line, individual data points
  - Trend Analysis: Moving average line chart (7-cycle window)
- **Cycle History Table**: Each completed cycle with: Cycle #, Card #, Started (triggered_at), Completed (restocked_at), Duration, each stage duration breakdown

### Primary Actions
- Date range change: Refreshes all data
- Cycle row click: Expands to show all transitions for that cycle
- "View Loop" link: Navigates to `/kanban/loops/{loopId}`

### Data Displayed
- All `card_stage_transitions` for this loop, grouped by `cycleNumber`
- Statistical calculations: mean, median, P90, standard deviation, control limits (mean +/- 3 sigma)

### States
- **Empty**: "Not enough cycle data for velocity analysis. At least 3 completed cycles are needed."
- **Loading**: Skeleton metrics and chart placeholders
- **Error**: Error banner with retry

### Modals / Drawers
- None

---

## Screen: ReLoWiSa Recommendations

**Route**: `/kanban/relowisa`
**Roles**: tenant_admin (F), inventory_manager (F), executive (R) | **Access**: F = approve/reject, R = view only

### Purpose
List all pending and recent ReLoWiSa (Reorder Level, Reorder Width, Safety Stock) recommendations for review, approval, or rejection.

### Layout
- **Header**: "ReLoWiSa Recommendations" title
- **Tab bar**: Pending | Approved | Rejected | Expired
- **Summary banner** (Pending tab): "{N} recommendations awaiting review. Estimated impact: {X}% stockout reduction."
- **Recommendation cards** (card list, not table): Each card shows:
  - Loop name (part + facility) with link
  - Current values vs. Recommended values (side-by-side comparison):
    - Min Quantity: {current} -> {recommended}
    - Order Quantity: {current} -> {recommended}
    - Number of Cards: {current} -> {recommended}
  - Confidence score: Progress bar (0-100%) with color coding (red < 50, yellow 50-75, green > 75)
  - Data points used: "{N} cycles analyzed"
  - Projected impact pills: Stockout reduction, carrying cost change, turn improvement
  - Created timestamp
  - Action buttons (F roles, Pending tab only): "Review" (opens drawer)

### Primary Actions
- "Review" button: Opens ReLoWiSa Review drawer
- Loop name click: Navigates to `/kanban/loops/{loopId}`
- Tab switch: Filters list by status
- Approved/Rejected tabs show reviewer name, review date, reason (if rejected)

### Data Displayed
- From `relowisa_recommendations` with joined loop, part, facility data
- Current loop parameters from `kanban_loops`
- Projected impact from `projectedImpact` JSONB field

### States
- **Empty (Pending)**: "No pending recommendations. Recommendations are generated automatically when enough cycle data is available."
- **Empty (other tabs)**: "No {status} recommendations."
- **Loading**: Skeleton recommendation cards
- **Error**: Error banner with retry

### Modals / Drawers
- **ReLoWiSa Review Drawer** (right, 500px):
  - Header: "Review Recommendation for {Part Name}"
  - Current vs. Recommended values comparison panel
  - Confidence Score: large progress bar with numeric label
  - Reasoning: AI/algorithm explanation text block
  - Projected Impact: 3 metric cards (stockout reduction, cost change, turn improvement)
  - Data Points: "{N} cycles over {timespan}"
  - Decision section:
    - "Approve" (primary button): Applies recommended values to loop, creates parameter history entry
    - "Reject" (outline button): Requires reason textarea (min 10 chars). Reason stored in `kanban_parameter_history`
  - POST `/api/kanban/relowisa/{id}/approve` or `/api/kanban/relowisa/{id}/reject`
  - On success: Card moves to Approved/Rejected tab, toast confirmation
