# Arda V2 -- Order Queue, PO, WO, TO Screens

> Wireframe-level behavior specs for Order Queue, Purchase Orders, Work Orders,
> Work Centers, and Transfer Orders.

---

## 1. Order Queue

---

### Screen: Order Queue

**Route**: `/orders/queue`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (F), receiving_manager (R), executive (R) | **Access**: F = create orders from queue

#### Purpose
Display all Kanban cards in the "triggered" stage that are awaiting order creation, grouped by loop type (procurement, production, transfer).

#### Layout
- **Header bar**: "Order Queue" title (left), summary pills: "{N} Procurement" | "{N} Production" | "{N} Transfer" (center), "Queue Summary" + "Risk Scanner" links (right)
- **Tab bar**: All | Procurement | Production | Transfer
- **Filter row**: Facility dropdown, Part search, Oldest First / Newest First sort toggle, date range (triggered since)
- **Table columns**: Card # (link), Part Number, Part Name, Loop Type (badge), Facility, Triggered At, Time in Queue (human-readable), Min Qty, Order Qty, Supplier / Source, Select (checkbox)
- **Bulk action bar** (appears when 1+ rows selected, F roles only): "Create PO ({N} items)" | "Create WO ({N} items)" | "Create TO ({N} items)" -- only the relevant button shows based on selected cards' loop types. Mixed loop types show warning.
- **Pagination**: Bottom

#### Primary Actions
- "Create PO" (bulk): Opens Create PO from Queue modal with selected procurement cards
- "Create WO" (bulk): Opens Create WO from Queue modal with selected production cards
- "Create TO" (bulk): Opens Create TO from Queue modal with selected transfer cards
- Card # click: Navigates to `/kanban/cards/{cardId}`
- Part Number click: Navigates to `/catalog/parts/{partId}`
- Tab switch: Filters table by loop type

#### Data Displayed
- Cards with `currentStage = 'triggered'` joined with loop, part, facility, supplier data
- `timeInQueue`: computed from `currentStageEnteredAt` to now
- Queue counts per loop type for tab badges

#### States
- **Empty**: "The order queue is empty. No Kanban cards are waiting for orders." with illustration of checkmark
- **Empty (filtered)**: "No triggered cards match your filters."
- **Loading**: Table skeleton
- **Error**: Error banner with retry

#### Modals / Drawers
- **Create PO from Queue**: Shows selected cards grouped by supplier. If cards share the same supplier, they can be consolidated into one PO. Fields: Supplier (pre-filled, read-only if all cards share supplier), Facility (pre-filled), Expected Delivery Date (date picker, optional), Notes (textarea). Line items auto-populated from card order quantities. Actions: "Cancel", "Create Purchase Order" (primary). POST `/api/orders/queue/create-po` with card IDs. On success: navigate to new PO detail, cards move to "ordered" stage.
- **Create WO from Queue**: Shows selected cards. Fields: Facility (pre-filled), Scheduled Start Date (date picker), Priority (number input, 0-10), Notes. Lines auto-populated. Actions: "Cancel", "Create Work Order" (primary). POST `/api/orders/queue/create-wo`.
- **Create TO from Queue**: Shows selected cards grouped by source facility. Fields: Source Facility (pre-filled from loop), Destination Facility (pre-filled from loop), Requested Date (date picker), Notes. Lines auto-populated. Actions: "Cancel", "Create Transfer Order" (primary). POST `/api/orders/queue/create-to`.

---

### Screen: Queue Summary

**Route**: `/orders/queue/summary`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (F), receiving_manager (R), executive (R) | **Access**: Read

#### Purpose
Provide aggregate analytics about the current order queue: counts, aging, and trends.

#### Layout
- **Header**: "Queue Summary" title, "Back to Queue" link
- **Metric cards** (6):
  - Total Triggered Cards
  - Procurement Queue
  - Production Queue
  - Transfer Queue
  - Oldest Card Age (days)
  - Avg Queue Time (hours)
- **Charts**:
  - Queue Aging Distribution: Bar chart, X = age buckets (< 1h, 1-4h, 4-24h, 1-3d, 3-7d, 7d+), Y = count
  - Queue Trend (7d): Line chart showing daily triggered card count vs. daily orders created
  - Queue by Facility: Horizontal bar chart, one bar per facility with count
  - Queue by Supplier: Horizontal bar chart for procurement cards, showing supplier concentration

#### Primary Actions
- Metric card click: Navigates to `/orders/queue` with corresponding filter
- Chart bar/segment click: Navigates to filtered queue view
- "Back to Queue": Navigates to `/orders/queue`

#### Data Displayed
- Aggregations from triggered cards in `kanban_cards`
- Trend data: daily snapshots from card transitions and order creation events

#### States
- **Empty**: "No data to summarize. The order queue is currently empty."
- **Loading**: Skeleton metrics and chart placeholders
- **Error**: Error banner with retry

#### Modals / Drawers
- None

---

### Screen: Queue Risk Scanner

**Route**: `/orders/queue/risk`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (F), executive (R) | **Access**: Read

#### Purpose
Analyze stockout risk by evaluating triggered card age relative to lead time and days-of-supply remaining.

#### Layout
- **Header**: "Queue Risk Scanner" title, "Back to Queue" link
- **Risk summary banner**: "{ N } items at HIGH risk of stockout" (red if > 0)
- **Risk table columns**: Risk Level (badge: High/Medium/Low), Part Number, Part Name, Facility, Days in Queue, Stated Lead Time (days), Estimated Days of Supply, Risk Score (0-100), Supplier, Actions
- **Risk level badges**: High = red (score >= 75), Medium = yellow (50-74), Low = green (< 50)
- **Sort**: Default sorted by Risk Score descending (highest risk first)
- **Filter**: Risk Level multi-select, Facility dropdown

#### Primary Actions
- Row click: Navigates to `/kanban/cards/{cardId}`
- "Create Order" per-row action (F roles): Opens the appropriate create-order modal (PO/WO/TO based on loop type)
- Part Number click: Navigates to part detail
- Risk score calculation: `riskScore = min(100, (daysInQueue / statedLeadTimeDays) * 50 + max(0, (statedLeadTimeDays - estimatedDaysOfSupply) / statedLeadTimeDays) * 50)`

#### Data Displayed
- Triggered cards with computed risk metrics
- `daysInQueue`: from `currentStageEnteredAt`
- `statedLeadTimeDays`: from loop or supplier
- `estimatedDaysOfSupply`: from current inventory levels / daily usage rate (if available)

#### States
- **Empty**: "No triggered cards in the queue. Risk scanner has nothing to analyze."
- **Loading**: Table skeleton
- **Error**: Error banner with retry

#### Modals / Drawers
- Same create-order modals as Order Queue screen (contextual to single card)

---

## 2. Purchase Orders

---

### Screen: PO List

**Route**: `/orders/purchase`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (F), receiving_manager (R), executive (R) | **Access**: Read minimum

#### Purpose
Display a filterable table of all purchase orders.

#### Layout
- **Header bar**: "Purchase Orders" title (left), "+ Create PO" primary button (right, F roles only)
- **Filter row**: Status multi-select (draft, pending_approval, approved, sent, acknowledged, partially_received, received, closed, cancelled), Supplier dropdown, Facility dropdown, Date range picker (order date), search by PO number
- **Table columns**: PO Number (link), Supplier, Facility, Status (badge), Order Date, Expected Delivery, Total Amount (formatted currency), # Lines, Created By, Actions
- **Status badge colors**: draft=gray, pending_approval=yellow, approved=blue, sent=purple, acknowledged=indigo, partially_received=orange, received=green, closed=slate, cancelled=red
- **Pagination**: Bottom

#### Primary Actions
- "+ Create PO": Navigates to `/orders/purchase/new`
- Row click / PO Number click: Navigates to `/orders/purchase/{id}`
- Actions kebab (F roles): "Approve" (if pending_approval), "Send" (if approved), "Receive" (if sent/acknowledged/partially_received), "Cancel" (if not closed/cancelled/received)

#### Data Displayed
- All `purchase_orders` with joined supplier and facility names
- `createdByName`: joined from users table
- Line count from `purchase_order_lines` count

#### States
- **Empty**: "No purchase orders yet. Create your first PO manually or from the order queue."
- **Empty (filtered)**: "No purchase orders match your filters."
- **Loading**: Table skeleton
- **Error**: Error banner with retry

#### Modals / Drawers
- None (actions navigate to detail or use detail page modals)

---

### Screen: Create PO

**Route**: `/orders/purchase/new`
**Roles**: tenant_admin (F), procurement_manager (F) | **Access**: Write

#### Purpose
Create a new purchase order manually (not from the order queue).

#### Layout
- **Header**: "Create Purchase Order" with breadcrumbs: Orders > Purchase Orders > New
- **Form body** (two sections):
  - Section 1: "PO Header"
    - PO Number (text input, auto-generated but overridable, required)
    - Supplier (searchable select, required)
    - Facility (select, required)
    - Order Date (date picker, defaults to today)
    - Expected Delivery Date (date picker, optional)
    - Currency (select, default USD, optional)
    - Notes (textarea, optional)
    - Internal Notes (textarea, optional, not visible on sent PO)
  - Section 2: "Line Items"
    - Table: Line #, Part (searchable select), Quantity (number), Unit Cost (currency input), Line Total (computed, read-only)
    - "+ Add Line" button below table
    - Per-row actions: Remove line (trash icon)
    - Subtotal, Tax Amount (input), Shipping Amount (input), Total Amount (computed) below table
- **Footer**: "Cancel" (left), "Save as Draft" (outline, right), "Submit for Approval" (primary, right)

#### Primary Actions
- "Save as Draft": POST with `status = 'draft'`, navigate to PO detail
- "Submit for Approval": POST with `status = 'pending_approval'`, navigate to PO detail
- "+ Add Line": Adds empty line row
- "Cancel": Navigate to `/orders/purchase` with unsaved prompt

#### Data Displayed
- Supplier options: `GET /api/catalog/suppliers?isActive=true`
- Part options: `GET /api/catalog/parts?isActive=true`
- Unit cost auto-fills from `supplier_parts` link when supplier + part both selected

#### States
- **Loading**: Skeleton form
- **Error**: Inline errors + toast
- **Validation**:
  - `poNumber`: Required, max 50 chars, unique per tenant. "PO number is required." / "PO number already exists."
  - `supplierId`: Required. "Select a supplier."
  - `facilityId`: Required. "Select a receiving facility."
  - Line items: At least 1 line required. "Add at least one line item."
  - Per line:
    - `partId`: Required. "Select a part."
    - `quantityOrdered`: Required, integer > 0. "Quantity must be at least 1."
    - `unitCost`: Required, numeric >= 0. "Enter a valid unit cost."
  - `taxAmount`: Optional, numeric >= 0
  - `shippingAmount`: Optional, numeric >= 0

#### Modals / Drawers
- **Add PO Line Modal** (alternative to inline add): Part search with supplier-specific pricing info, quantity, unit cost. Used on mobile where inline table editing is impractical.

---

### Screen: PO Detail

**Route**: `/orders/purchase/:id`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (F), receiving_manager (R), executive (R) | **Access**: Read minimum

#### Purpose
Display complete purchase order information with status workflow actions.

#### Layout
- **Header**: PO Number (large), Status badge (large), action buttons row
  - Action buttons vary by status and role:
    - Draft (F): "Edit", "Submit for Approval", "Delete"
    - Pending Approval (F): "Approve", "Reject", "Edit"
    - Approved (F): "Send to Supplier", "Cancel"
    - Sent (F): "Mark Acknowledged", "Cancel"
    - Acknowledged/Partially Received (F): "Receive", "Cancel"
    - Received (F): "Close"
    - Closed/Cancelled: No actions
- **Tab navigation**: Overview | Line Items | Status Timeline | Audit Trail
- **Overview tab**:
  - Left column: Supplier name (link), Facility, Order Date, Expected Delivery, Actual Delivery, Currency, Notes
  - Right column: Financial summary card: Subtotal, Tax, Shipping, Total Amount. Created By, Approved By (if applicable), Sent At.
- **Line Items tab**: Table: Line #, Part Number (link), Part Name, Qty Ordered, Qty Received, Unit Cost, Line Total, Kanban Card (link if linked), Status (fully received / partially / none)
- **Status Timeline tab**: Vertical timeline of all status changes with timestamps and user who made the change
- **Audit Trail tab**: Filtered audit log for this entity from `audit_log WHERE entityType = 'purchase_order' AND entityId = :id`

#### Primary Actions
- "Approve": Opens Approve PO modal
- "Send to Supplier": Opens Send PO modal
- "Receive": Navigates to `/orders/purchase/{id}/receive`
- "Cancel": Opens Cancel PO Confirm modal
- Part Number links: Navigate to part detail
- Kanban Card links: Navigate to card detail
- Supplier name link: Navigate to supplier detail

#### Data Displayed
- Full `purchase_orders` record with all relations
- Line items from `purchase_order_lines`
- Status changes from `audit_log`

#### States
- **Loading**: Skeleton layout
- **Error**: Error banner with retry
- **404**: "Purchase order not found."

#### Modals / Drawers
- **Approve PO Modal**: "Approve PO {poNumber}? This will allow it to be sent to the supplier." Optional notes. Actions: "Cancel", "Approve" (primary). PATCH status to `approved`.
- **Send PO Modal**: "Send PO {poNumber} to {supplierName}?" Email field pre-filled from supplier contact email (editable). Checkbox: "Include line items in email body." Actions: "Cancel", "Send" (primary). PATCH status to `sent`, records `sentAt` and `sentToEmail`.
- **Cancel PO Confirm**: "Cancel PO {poNumber}? This cannot be undone." Required reason textarea. Actions: "Cancel" (outline), "Cancel PO" (destructive red). PATCH status to `cancelled`, records `cancelReason`.

---

### Screen: Receive PO

**Route**: `/orders/purchase/:id/receive`
**Roles**: tenant_admin (F), procurement_manager (F), receiving_manager (W) | **Access**: Write

#### Purpose
Record line-by-line receipt of goods against a purchase order.

#### Layout
- **Header**: "Receive -- PO {poNumber}" title, Supplier name, Status badge
- **PO summary bar**: Order Date, Expected Delivery, Total Lines, Lines Fully Received / Partially / Pending
- **Line items table**: Line #, Part Number, Part Name, Qty Ordered, Qty Previously Received, Qty This Receipt (editable number input), Remaining (computed), Notes (inline text input)
- **Batch actions bar**: "Receive All Remaining" button (fills all qty inputs with remaining amounts)
- **Footer**: "Cancel" (left), "Record Receipt" (primary, right)

#### Primary Actions
- "Receive All Remaining": Auto-fills each line qty input with `qtyOrdered - qtyReceived`
- "Record Receipt": PATCH `/api/orders/purchase-orders/{id}/receive` with line quantities. Updates `quantityReceived` on each line. If all lines fully received, status moves to `received`. If some remaining, status moves to `partially_received`. On success, navigate to PO detail with success toast.
- "Cancel": Navigate to PO detail

#### Data Displayed
- PO header + line items with current received quantities

#### States
- **Loading**: Skeleton
- **Error**: Inline errors + toast
- **Validation**:
  - Per line `qtyThisReceipt`: Integer >= 0, <= (qtyOrdered - qtyReceived). "Cannot receive more than ordered."
  - At least one line must have qty > 0. "Enter a quantity for at least one line."
- **Already fully received**: If PO is already status `received`, redirect to PO detail with info toast.

#### Modals / Drawers
- **Receive Line Item Modal** (mobile): On small screens, tapping a line opens a focused modal with part info, ordered vs. received, and quantity input. Actions: "Done", "Cancel".

---

## 3. Work Orders

---

### Screen: WO List

**Route**: `/orders/work`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: R = read only, F = full

#### Purpose
Display a filterable table of all work orders.

#### Layout
- **Header bar**: "Work Orders" title (left), "+ Create WO" primary button (right, F roles only)
- **Filter row**: Status multi-select (draft, scheduled, in_progress, on_hold, completed, cancelled), Facility dropdown, Part search, Priority range, Date range (scheduled start)
- **Table columns**: WO Number (link), Part Number, Part Name, Facility, Status (badge), Priority (numeric badge), Qty to Produce, Qty Produced, Qty Rejected, Scheduled Start, Scheduled End, Created By
- **Status badge colors**: draft=gray, scheduled=blue, in_progress=orange, on_hold=yellow, completed=green, cancelled=red
- **Pagination**: Bottom

#### Primary Actions
- "+ Create WO": Navigates to `/orders/work/new`
- Row click: Navigates to `/orders/work/{id}`

#### Data Displayed
- All `work_orders` with joined part, facility, user data

#### States
- **Empty**: "No work orders yet. Create a work order to track production."
- **Empty (filtered)**: "No work orders match your filters."
- **Loading**: Table skeleton
- **Error**: Error banner with retry

#### Modals / Drawers
- None

---

### Screen: Create WO

**Route**: `/orders/work/new`
**Roles**: tenant_admin (F), inventory_manager (F) | **Access**: Write

#### Purpose
Create a new work order for production.

#### Layout
- **Header**: "Create Work Order" with breadcrumbs
- **Form body**:
  - Section 1: "WO Header"
    - WO Number (text, auto-generated but overridable, required)
    - Part to Produce (searchable select, required, filtered to subassembly/finished_good types)
    - Facility (select, required)
    - Quantity to Produce (number, required)
    - Priority (number input 0-10, default 0)
    - Scheduled Start Date (datetime picker, optional)
    - Scheduled End Date (datetime picker, optional)
    - Notes (textarea, optional)
  - Section 2: "Routing Steps" (optional, can add after creation)
    - Table: Step #, Operation Name (text input), Work Center (select), Estimated Minutes (number), Notes
    - "+ Add Step" button
    - Per-row: Remove step (trash icon), drag handle for reordering
- **Footer**: "Cancel" (left), "Save as Draft" (outline), "Schedule" (primary, sets status to scheduled)

#### Primary Actions
- "Save as Draft": POST with `status = 'draft'`
- "Schedule": POST with `status = 'scheduled'`
- "Cancel": Navigate to `/orders/work`

#### Data Displayed
- Part options: `GET /api/catalog/parts?isActive=true`
- Facility options
- Work center options: `GET /api/orders/work-centers?isActive=true`

#### States
- **Loading**: Skeleton form
- **Error**: Inline errors + toast
- **Validation**:
  - `woNumber`: Required, max 50 chars, unique per tenant. "WO number is required."
  - `partId`: Required. "Select a part to produce."
  - `facilityId`: Required. "Select a facility."
  - `quantityToProduce`: Required, integer > 0. "Quantity must be at least 1."
  - `priority`: Integer 0-10. "Priority must be between 0 and 10."
  - `scheduledEndDate`: Must be after `scheduledStartDate` if both set. "End date must be after start date."
  - Routing steps (if added):
    - `operationName`: Required. "Enter an operation name."
    - `workCenterId`: Required. "Select a work center."
    - `estimatedMinutes`: Optional, integer > 0. "Must be a positive number."

#### Modals / Drawers
- **Add Routing Step Modal** (mobile alternative to inline): Operation Name, Work Center select, Est. Minutes, Notes. Actions: "Cancel", "Add Step".

---

### Screen: WO Detail

**Route**: `/orders/work/:id`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: F = manage, R = view

#### Purpose
Display work order details including routing steps with status tracking.

#### Layout
- **Header**: WO Number (large), Status badge, Priority badge, Action buttons:
  - Draft (F): "Edit", "Schedule", "Cancel"
  - Scheduled (F): "Start", "Cancel"
  - In Progress (F): "Put on Hold", "Complete", "Cancel"
  - On Hold (F): "Resume"
  - Completed/Cancelled: No actions
- **Tab navigation**: Overview | Routing Steps | Production Log | Audit Trail
- **Overview tab**:
  - Left: Part (link), Facility, Scheduled Start/End, Actual Start/End, Kanban Card (link if linked)
  - Right: Production progress card: Qty to Produce, Qty Produced (with progress bar), Qty Rejected, Yield % = (produced / (produced + rejected)) * 100
  - Notes
- **Routing Steps tab**: Ordered list of routing steps as cards:
  - Each card: Step # badge, Operation Name, Work Center (link), Status badge, Estimated Minutes, Actual Minutes, Started At, Completed At
  - Action buttons per step (F roles): "Start" (if pending), "Complete" (if in_progress), "Put on Hold", "Skip"
- **Production Log tab**: Manual log entries for quantity produced/rejected per session. Table: Date, Qty Produced, Qty Rejected, User, Notes. "+ Log Production" button.
- **Audit Trail tab**: Filtered audit log for this WO

#### Primary Actions
- Status transitions: PATCH `/api/orders/work-orders/{id}` with new status
- Routing step status update: Opens Update Step Status modal
- "Log Production": Opens inline form or modal to record qty produced/rejected

#### Data Displayed
- Full `work_orders` record with routing steps, linked card, part, facility
- Routing steps from `work_order_routings` ordered by `stepNumber`

#### States
- **Loading**: Skeleton
- **Error**: Error banner
- **404**: "Work order not found."

#### Modals / Drawers
- **Cancel WO Confirm**: "Cancel WO {woNumber}? In-progress routing steps will be marked as skipped." Actions: "Cancel", "Cancel WO" (red).
- **Update Step Status Modal**: Shows step name and current status. Select new status from allowed transitions. Optional notes. Actions: "Cancel", "Update" (primary).
- **Log Production Modal**: Qty Produced (number), Qty Rejected (number), Notes. Both optional but at least one must be > 0. Actions: "Cancel", "Log" (primary).

---

## 4. Work Centers

---

### Screen: Work Center List

**Route**: `/orders/work-centers`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: F = manage, R = view

#### Purpose
Display all work centers with capacity and cost information.

#### Layout
- **Header bar**: "Work Centers" title (left), "+ Create Work Center" button (right, F roles)
- **Filter row**: Facility dropdown, Active toggle, search by name/code
- **Table columns**: Name, Code, Facility, Capacity/Hour, Cost/Hour, Active (badge), # Active WOs, Actions
- **Pagination**: Bottom

#### Primary Actions
- "+ Create Work Center": Navigates to `/orders/work-centers/new`
- Row click: Navigates to `/orders/work-centers/{id}`
- Actions kebab (F roles): "Edit", "Deactivate"

#### Data Displayed
- All `work_centers` with joined facility, count of active work order routings

#### States
- **Empty**: "No work centers configured. Create a work center to define production capacity."
- **Loading**: Table skeleton
- **Error**: Error banner

#### Modals / Drawers
- None

---

### Screen: Create Work Center

**Route**: `/orders/work-centers/new`
**Roles**: tenant_admin (F), inventory_manager (F) | **Access**: Write

#### Purpose
Create a new work center.

#### Layout
- **Header**: "Create Work Center" with breadcrumbs
- **Form body** (single column):
  - Name (text, required)
  - Code (text, required, uppercase auto-format)
  - Facility (select, required)
  - Description (textarea, optional)
  - Capacity per Hour (decimal input, optional)
  - Cost per Hour (currency input, optional)
- **Footer**: "Cancel", "Create Work Center" (primary)

#### Primary Actions
- "Create Work Center": POST, navigate to work center detail
- "Cancel": Navigate to `/orders/work-centers`

#### Data Displayed
- Facility options

#### States
- **Loading**: Skeleton form
- **Error**: Inline errors + toast
- **Validation**:
  - `name`: Required, max 255 chars. "Name is required."
  - `code`: Required, max 50 chars, unique per tenant. "Code is required." / "Code already exists."
  - `facilityId`: Required. "Select a facility."
  - `capacityPerHour`: Optional, numeric > 0. "Must be a positive number."
  - `costPerHour`: Optional, numeric >= 0. "Must be zero or positive."

#### Modals / Drawers
- None

---

### Screen: Work Center Detail

**Route**: `/orders/work-centers/:id`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: F = edit, R = view

#### Purpose
Display work center information, utilization, and assigned routing steps.

#### Layout
- **Header**: Work Center Name (large), Code badge, Active badge, Action buttons (F roles): "Edit", "Deactivate"/"Activate"
- **Info panel**: Facility, Description, Capacity/Hour, Cost/Hour
- **Tab navigation**: Current Routings | Utilization
- **Current Routings tab**: Table of active `work_order_routings` assigned to this work center: WO Number (link), Operation Name, Step Status, Est. Minutes, Actual Minutes
- **Utilization tab** (future): Charts showing utilization over time (placeholder for MVP)

#### Primary Actions
- "Edit": Opens Edit Work Center modal (inline edit in drawer)
- "Deactivate": Opens confirmation modal
- WO Number link: Navigates to WO detail

#### Data Displayed
- Work center record with facility join
- Active routing steps from `work_order_routings WHERE workCenterId = :id`

#### States
- **Loading**: Skeleton
- **Error**: Error banner
- **404**: "Work center not found."

#### Modals / Drawers
- **Edit Work Center Modal**: Same fields as create form, pre-populated. Actions: "Cancel", "Save" (primary). PATCH `/api/orders/work-centers/{id}`.
- **Deactivate Work Center Confirm**: "Deactivate {name}? It will no longer be available for new routing steps." Actions: "Cancel", "Deactivate" (red). Fails if active in-progress routings exist.

---

## 5. Transfer Orders

---

### Screen: TO List

**Route**: `/orders/transfer`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), receiving_manager (F), executive (R) | **Access**: F = full, R = view

#### Purpose
Display a filterable table of all transfer orders.

#### Layout
- **Header bar**: "Transfer Orders" title (left), "+ Create TO" button (right, F roles)
- **Filter row**: Status multi-select (draft, requested, approved, picking, shipped, in_transit, received, closed, cancelled), Source Facility dropdown, Destination Facility dropdown, Date range (requested date)
- **Table columns**: TO Number (link), Source Facility, Destination Facility, Status (badge), Requested Date, Shipped Date, Received Date, # Lines, Created By
- **Status badge colors**: draft=gray, requested=blue, approved=indigo, picking=purple, shipped=orange, in_transit=yellow, received=green, closed=slate, cancelled=red
- **Pagination**: Bottom

#### Primary Actions
- "+ Create TO": Navigates to `/orders/transfer/new`
- Row click: Navigates to `/orders/transfer/{id}`

#### Data Displayed
- All `transfer_orders` with joined facility names, user name, line count

#### States
- **Empty**: "No transfer orders yet. Create a transfer order to move inventory between facilities."
- **Empty (filtered)**: "No transfer orders match your filters."
- **Loading**: Table skeleton
- **Error**: Error banner with retry

#### Modals / Drawers
- None

---

### Screen: Create TO

**Route**: `/orders/transfer/new`
**Roles**: tenant_admin (F), inventory_manager (R), receiving_manager (F) | **Access**: Write

#### Purpose
Create a new inter-facility transfer order.

#### Layout
- **Header**: "Create Transfer Order" with breadcrumbs
- **Form body**:
  - Section 1: "TO Header"
    - TO Number (text, auto-generated, overridable, required)
    - Source Facility (select, required)
    - Destination Facility (select, required, must differ from source)
    - Requested Date (date picker, optional)
    - Notes (textarea, optional)
  - Section 2: "Line Items"
    - Table: Part (searchable select), Qty Requested (number), Notes
    - "+ Add Line"
    - Per-row: Remove
- **Footer**: "Cancel", "Save as Draft" (outline), "Submit Request" (primary, status = requested)

#### Primary Actions
- "Save as Draft": POST with `status = 'draft'`
- "Submit Request": POST with `status = 'requested'`
- "Cancel": Navigate to `/orders/transfer`

#### Data Displayed
- Facility options, part options

#### States
- **Loading**: Skeleton
- **Error**: Inline errors + toast
- **Validation**:
  - `toNumber`: Required, max 50, unique per tenant.
  - `sourceFacilityId`: Required. "Select a source facility."
  - `destinationFacilityId`: Required, must differ from source. "Destination must differ from source."
  - At least 1 line item required.
  - Per line:
    - `partId`: Required. "Select a part."
    - `quantityRequested`: Required, integer > 0. "Quantity must be at least 1."

#### Modals / Drawers
- None

---

### Screen: TO Detail

**Route**: `/orders/transfer/:id`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (R), receiving_manager (F), executive (R) | **Access**: F = manage, R = view

#### Purpose
Display transfer order details with status workflow.

#### Layout
- **Header**: TO Number (large), Status badge, Action buttons:
  - Draft (F): "Edit", "Submit Request", "Delete"
  - Requested (F): "Approve", "Cancel"
  - Approved (F): "Start Picking", "Cancel"
  - Picking (F): "Ship", "Cancel"
  - Shipped (F): "Mark In Transit"
  - In Transit (F): "Receive" (navigates to receive page)
  - Received (F): "Close"
  - Closed/Cancelled: No actions
- **Tab navigation**: Overview | Line Items | Status Timeline | Audit Trail
- **Overview tab**: Source Facility, Destination Facility, Requested/Shipped/Received Dates, Notes, Kanban Card (if linked), Created By
- **Line Items tab**: Table: Part Number (link), Part Name, Qty Requested, Qty Shipped, Qty Received, Status
- **Status Timeline tab**: Vertical timeline of all transitions
- **Audit Trail tab**: Entity-filtered audit log

#### Primary Actions
- Status transitions: Various PATCH endpoints
- "Receive": Navigates to `/orders/transfer/{id}/receive`
- "Ship": Opens Ship TO Confirm modal

#### Data Displayed
- Full `transfer_orders` record with lines, facilities, card

#### States
- **Loading**: Skeleton
- **Error**: Error banner
- **404**: "Transfer order not found."

#### Modals / Drawers
- **Cancel TO Confirm**: "Cancel TO {toNumber}?" Required reason. Actions: "Cancel", "Cancel TO" (red).
- **Ship TO Confirm**: "Mark TO {toNumber} as shipped?" Optional tracking number field, shipped date (defaults to now). Per-line shipped quantity inputs (default to requested). Actions: "Cancel", "Confirm Shipment" (primary). Updates line shipped quantities and status.

---

### Screen: Receive TO

**Route**: `/orders/transfer/:id/receive`
**Roles**: tenant_admin (F), receiving_manager (W) | **Access**: Write

#### Purpose
Record line-by-line receipt of transferred goods at the destination facility.

#### Layout
- **Header**: "Receive -- TO {toNumber}", Source -> Destination facility names, Status badge
- **Summary bar**: Total Lines, Lines Fully Received / Partially / Pending
- **Line items table**: Part Number, Part Name, Qty Requested, Qty Shipped, Qty Previously Received, Qty This Receipt (editable), Remaining, Notes
- **Batch actions**: "Receive All Shipped" (fills with shipped - received)
- **Footer**: "Cancel", "Record Receipt" (primary)

#### Primary Actions
- "Receive All Shipped": Auto-fills quantities
- "Record Receipt": PATCH with line quantities. Updates status.
- "Cancel": Navigate to TO detail

#### Data Displayed
- TO header + line items

#### States
- **Loading**: Skeleton
- **Error**: Inline errors + toast
- **Validation**:
  - Per line `qtyThisReceipt`: Integer >= 0, <= (qtyShipped - qtyReceived). "Cannot receive more than shipped."
  - At least one line must have qty > 0.

#### Modals / Drawers
- **Receive TO Line Item Modal** (mobile): Same pattern as PO receive line modal.
