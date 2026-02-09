# Arda V2 -- Catalog Screens

> Wireframe-level behavior specs for Parts, Categories, Suppliers, and BOM screens.

---

## 1. Parts

---

### Screen: Part List

**Route**: `/catalog/parts`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), ecommerce_director (R), salesperson (R), executive (R) | **Access**: F = CRUD, R = read only

#### Purpose
Display the master parts catalog with filtering by type, category, active status, and sellable flag.

#### Layout
- **Header bar**: "Parts Catalog" title (left), "+ Create Part" primary button (right, F roles only)
- **Filter row**: Part Type multi-select (raw_material, component, subassembly, finished_good, consumable, packaging, other), Category dropdown (hierarchical), Active toggle, Sellable toggle, search by part number / name / UPC
- **Density toggle**: Comfortable / Compact / Dense (top-right of table area)
- **Table columns**: Part Number (link), Name, Type (badge), Category, UOM, Unit Cost, Unit Price, Active (badge), Sellable (badge), Actions
- **Type badge colors**: raw_material=amber, component=blue, subassembly=purple, finished_good=green, consumable=gray, packaging=cyan, other=slate
- **Pagination**: Bottom with page size selector (25, 50, 100)

#### Primary Actions
- "+ Create Part": Navigates to `/catalog/parts/new`
- Row click / Part Number click: Navigates to `/catalog/parts/{id}`
- Actions kebab (F roles): "Edit", "Deactivate"
- Bulk export: "Export CSV" button in header (R+ roles)

#### Data Displayed
- All `parts` with joined category name
- Cost/Price formatted with tenant currency
- Counts for result summary

#### States
- **Empty**: "No parts in the catalog yet. Add your first part to get started." with "Create Part" CTA
- **Empty (filtered)**: "No parts match your filters." with "Clear Filters"
- **Loading**: Table skeleton with density-appropriate row heights
- **Error**: Error banner with retry

#### Modals / Drawers
- None

---

### Screen: Create Part

**Route**: `/catalog/parts/new`
**Roles**: tenant_admin (F), inventory_manager (F) | **Access**: Write

#### Purpose
Create a new part in the master catalog.

#### Layout
- **Header**: "Create Part" with breadcrumbs: Catalog > Parts > New Part
- **Form body** (two-column layout on desktop, single column on mobile):
  - **Left column**: "Basic Information"
    - Part Number (text, required)
    - Name (text, required)
    - Description (textarea, optional)
    - Category (searchable select with hierarchy, optional)
    - Type (select from part_type enum, required)
    - Unit of Measure (select from uom enum, required, default "each")
  - **Right column**: "Pricing & Specs"
    - Unit Cost (currency input, optional)
    - Unit Price (currency input, optional)
    - Weight (decimal input, optional, with unit label from tenant settings)
    - UPC Barcode (text, optional)
    - Manufacturer Part Number (text, optional)
    - Image URL (text input + preview, optional) -- or Upload button
    - Is Sellable (toggle, default off)
  - **Bottom section**: "Custom Specifications" (dynamic key-value pairs)
    - Table: Key (text), Value (text), Remove button
    - "+ Add Specification" button
- **Footer**: "Cancel" (left), "Create Part" (primary, right)

#### Primary Actions
- "Create Part": POST `/api/catalog/parts`, navigate to part detail on success
- "Cancel": Navigate to `/catalog/parts` with unsaved prompt
- "Upload Image": Opens Upload Part Image modal

#### Data Displayed
- Category options: hierarchical list from `part_categories`
- Type options: `part_type` enum values
- UOM options: `unit_of_measure` enum values

#### States
- **Loading**: Skeleton form while options load
- **Error**: Inline field errors + toast for server errors
- **Validation**:
  - `partNumber`: Required, max 100 chars, unique per tenant. "Part number is required." / "Part number already exists."
  - `name`: Required, max 255 chars. "Name is required."
  - `type`: Required. "Select a part type."
  - `uom`: Required. "Select a unit of measure."
  - `unitCost`: Optional, numeric >= 0, max 4 decimal places. "Enter a valid cost."
  - `unitPrice`: Optional, numeric >= 0, max 4 decimal places. "Enter a valid price."
  - `weight`: Optional, numeric >= 0. "Weight must be zero or positive."
  - `upcBarcode`: Optional, max 50 chars. Regex: `/^[0-9]{8,14}$/` if provided. "Enter a valid UPC."
  - `manufacturerPartNumber`: Optional, max 100 chars.
  - `specifications`: Each key must be non-empty, max 100 chars. Each value max 500 chars.

#### Modals / Drawers
- **Upload Part Image Modal**: Drag-and-drop zone or file picker. Accepted formats: JPG, PNG, WebP. Max size: 5MB. Preview before upload. Actions: "Cancel", "Upload" (primary). Returns URL to populate `imageUrl` field.

---

### Screen: Part Detail

**Route**: `/catalog/parts/:id`
**Roles**: All roles | **Access**: F (admin, inventory_manager), R (all others)

#### Purpose
Display comprehensive part information including supplier links, BOM, Kanban loops, and order history.

#### Layout
- **Header**: Part Number (large), Name, Type badge, Active/Inactive badge, action buttons
  - F roles: "Edit", "Deactivate"/"Activate"
  - Image thumbnail (if exists) to the right of header
- **Tab navigation**: Overview | Suppliers | BOM | Kanban Loops | Order History
- **Overview tab**:
  - Left column: Part Number, Name, Description, Category (link), Type, UOM, Weight, UPC, Manufacturer Part Number, Is Sellable badge
  - Right column: Pricing card (Unit Cost, Unit Price, Margin %), Image (large, or placeholder), Custom specifications list
- **Suppliers tab**: Table of linked suppliers from `supplier_parts`: Supplier Name (link), Supplier Part Number, Unit Cost, Min Order Qty, Lead Time (days), Is Primary (badge), Active (badge). Actions (F roles): "Add Supplier Link", "Edit Link", "Remove Link"
- **BOM tab** (if part has BOM children): Table of BOM items: Child Part Number (link), Child Part Name, Qty Per, Notes. "View Full BOM" link -> `/catalog/bom/{partId}`. Actions (F roles): "Add BOM Line", "Remove Line"
- **Kanban Loops tab**: Table of loops using this part: Loop Type (badge), Facility, Min Qty, Order Qty, # Cards, Active. Link to each loop.
- **Order History tab**: Combined list of POs, WOs, TOs referencing this part. Table: Order Type badge, Order Number (link), Status badge, Qty, Date, Facility. Sorted by date descending.

#### Primary Actions
- "Edit": Navigates to `/catalog/parts/{id}/edit`
- "Deactivate": Confirmation modal. Checks for active loops/orders referencing this part.
- Supplier link click: `/catalog/suppliers/{supplierId}`
- Category link click: `/catalog/categories/{categoryId}`
- BOM part link click: `/catalog/parts/{childPartId}`
- Loop row click: `/kanban/loops/{loopId}`
- Order row click: Navigates to PO/WO/TO detail

#### Data Displayed
- Full `parts` record
- Supplier links: `supplier_parts WHERE partId = :id`
- BOM children: `bom_items WHERE parentPartId = :id`
- Kanban loops: `kanban_loops WHERE partId = :id`
- Order history: Aggregated from PO lines, WO records, TO lines where partId matches

#### States
- **Empty (Suppliers tab)**: "No suppliers linked to this part yet." + "Add Supplier Link" button
- **Empty (BOM tab)**: "No bill of materials defined for this part." + "Add BOM Line" button
- **Empty (Loops tab)**: "No Kanban loops configured for this part."
- **Empty (Order History tab)**: "No orders reference this part yet."
- **Loading**: Skeleton layout per tab
- **Error**: Error banner
- **404**: "Part not found."

#### Modals / Drawers
- **Link Supplier to Part Modal**: Supplier searchable select, Supplier Part Number (text), Unit Cost (currency), Min Order Qty (number), Lead Time (days, number), Is Primary (toggle). Validation: Supplier required, unique supplier-part pair per tenant. Actions: "Cancel", "Link Supplier" (primary). POST `/api/catalog/parts/{id}/suppliers`.
- **Deactivate Part Confirm**: "Deactivate {partNumber}? Active Kanban loops using this part will NOT be deactivated automatically." Warns if active loops exist. Actions: "Cancel", "Deactivate" (red).

---

### Screen: Edit Part

**Route**: `/catalog/parts/:id/edit`
**Roles**: tenant_admin (F), inventory_manager (F) | **Access**: Write

#### Purpose
Modify an existing part's details.

#### Layout
- Identical to Create Part form, pre-populated with current values.
- Part Number field is **read-only** after creation (displayed as text, not input).
- All other fields are editable.

#### Primary Actions
- "Save Changes": PATCH `/api/catalog/parts/{id}`, navigate to part detail on success
- "Cancel": Navigate to `/catalog/parts/{id}` with unsaved prompt

#### Data Displayed
- Pre-populated from GET `/api/catalog/parts/{id}`

#### States
- Same as Create Part + pre-population loading state
- **Validation**: Same as Create Part (excluding partNumber uniqueness check since it's read-only)

#### Modals / Drawers
- **Upload Part Image Modal**: Same as Create Part

---

## 2. Categories

---

### Screen: Category List

**Route**: `/catalog/categories`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), ecommerce_director (R), salesperson (R), executive (R) | **Access**: F = CRUD, R = read

#### Purpose
Display the hierarchical category tree for part organization.

#### Layout
- **Header bar**: "Part Categories" title (left), "+ Create Category" button (right, F roles)
- **View toggle**: Tree View | List View
- **Tree View** (default): Nested expandable tree structure. Each node shows: Category Name, # Parts, description preview. Click node to select. Expand/collapse arrows for parents.
- **List View**: Flat table: Name, Parent Category, # Parts, Sort Order, Actions
- **Search**: Search by category name, highlights matching nodes in tree

#### Primary Actions
- "+ Create Category": Navigates to `/catalog/categories/new`
- Category name click (tree): Navigates to `/catalog/categories/{id}`
- Row click (list): Navigates to `/catalog/categories/{id}`
- Actions kebab (F roles): "Edit", "Delete"

#### Data Displayed
- All `part_categories` with part counts (from `parts WHERE categoryId = :id`)
- Hierarchical nesting via `parentCategoryId`

#### States
- **Empty**: "No categories defined yet. Create categories to organize your parts catalog."
- **Loading**: Skeleton tree or table
- **Error**: Error banner

#### Modals / Drawers
- None

---

### Screen: Create Category

**Route**: `/catalog/categories/new`
**Roles**: tenant_admin (F), inventory_manager (F) | **Access**: Write

#### Purpose
Create a new part category, optionally nested under a parent.

#### Layout
- **Header**: "Create Category" with breadcrumbs
- **Form body** (single column):
  - Name (text, required)
  - Parent Category (searchable select from existing categories, optional -- null = root level)
  - Description (textarea, optional)
  - Sort Order (number, optional, default 0)
- **Footer**: "Cancel", "Create Category" (primary)

#### Primary Actions
- "Create Category": POST `/api/catalog/categories`, navigate to category detail
- "Cancel": Navigate to `/catalog/categories`

#### Data Displayed
- Parent category options from `part_categories`

#### States
- **Loading**: Skeleton form
- **Error**: Inline errors + toast
- **Validation**:
  - `name`: Required, max 255 chars, unique per tenant. "Category name is required." / "Category name already exists."
  - `sortOrder`: Optional, integer >= 0.
  - Cannot create circular parent reference (server-side validation).

#### Modals / Drawers
- None

---

### Screen: Category Detail

**Route**: `/catalog/categories/:id`
**Roles**: All roles | **Access**: F (admin, inventory_manager), R (all others)

#### Purpose
Display category information, child categories, and parts assigned to this category.

#### Layout
- **Header**: Category Name (large), Parent breadcrumb trail (e.g., "Root > Electronics > Boards"), action buttons
  - F roles: "Edit" (inline), "Delete"
- **Two-column layout**:
  - **Left (40%)**: Category info card: Name (inline editable for F), Description (inline editable), Sort Order, Parent Category (link)
  - **Right (60%)**:
    - Child Categories section: List of immediate children. Each clickable to navigate.
    - Parts in Category section: Table of parts with this categoryId: Part Number (link), Name, Type badge, Active badge. Pagination.
- **Bottom**: "Move Parts" action (F roles): Reassign selected parts to a different category.

#### Primary Actions
- "Edit" (inline): Toggle fields to editable, show "Save" / "Cancel" buttons
- "Delete": Opens Delete Category Confirm modal
- Child category click: Navigates to `/catalog/categories/{childId}`
- Part row click: Navigates to `/catalog/parts/{partId}`
- "Move Parts": Opens Move Parts to Category modal

#### Data Displayed
- Category record with parent chain
- Child categories: `part_categories WHERE parentCategoryId = :id`
- Parts: `parts WHERE categoryId = :id`

#### States
- **Empty (children)**: "No subcategories."
- **Empty (parts)**: "No parts assigned to this category."
- **Loading**: Skeleton
- **Error**: Error banner
- **404**: "Category not found."

#### Modals / Drawers
- **Delete Category Confirm**: "Delete category '{name}'? Parts in this category will be set to uncategorized. {N} parts will be affected." Blocks if child categories exist: "Remove or reassign child categories first." Actions: "Cancel", "Delete" (red).
- **Move Parts to Category Modal**: Target Category searchable select, shows count of selected parts. Actions: "Cancel", "Move {N} Parts" (primary). PATCH parts with new categoryId.

---

## 3. Suppliers

---

### Screen: Supplier List

**Route**: `/catalog/suppliers`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (F), receiving_manager (R), executive (R) | **Access**: F = CRUD, R = read

#### Purpose
Display all suppliers with contact information and key metrics.

#### Layout
- **Header bar**: "Suppliers" title (left), "+ Create Supplier" button (right, F roles)
- **Filter row**: Active toggle, search by name/code/contact name
- **Table columns**: Name (link), Code, Contact Name, Contact Email, Contact Phone, Payment Terms, Lead Time (days), # Linked Parts, Active (badge), Actions
- **Pagination**: Bottom

#### Primary Actions
- "+ Create Supplier": Navigates to `/catalog/suppliers/new`
- Row click / Name click: Navigates to `/catalog/suppliers/{id}`
- Actions kebab (F roles): "Edit", "Deactivate"

#### Data Displayed
- All `suppliers` with linked part count from `supplier_parts`

#### States
- **Empty**: "No suppliers in the system. Add your first supplier to start managing procurement."
- **Empty (filtered)**: "No suppliers match your filters."
- **Loading**: Table skeleton
- **Error**: Error banner

#### Modals / Drawers
- None

---

### Screen: Create Supplier

**Route**: `/catalog/suppliers/new`
**Roles**: tenant_admin (F), procurement_manager (F) | **Access**: Write

#### Purpose
Create a new supplier record.

#### Layout
- **Header**: "Create Supplier" with breadcrumbs
- **Form body** (two-column on desktop):
  - **Left column**: "Supplier Information"
    - Name (text, required)
    - Code (text, required, uppercase auto-format)
    - Contact Name (text, optional)
    - Contact Email (email input, optional)
    - Contact Phone (tel input, optional)
    - Website (URL input, optional)
    - Notes (textarea, optional)
  - **Right column**: "Address & Terms"
    - Address Line 1 (text, optional)
    - Address Line 2 (text, optional)
    - City (text, optional)
    - State (text, optional)
    - Postal Code (text, optional)
    - Country (select, default "US")
    - Stated Lead Time Days (number, optional)
    - Payment Terms (text, optional, placeholder "Net 30")
- **Footer**: "Cancel", "Create Supplier" (primary)

#### Primary Actions
- "Create Supplier": POST `/api/catalog/suppliers`, navigate to supplier detail
- "Cancel": Navigate to `/catalog/suppliers`

#### Data Displayed
- Country options list

#### States
- **Loading**: Skeleton form
- **Error**: Inline errors + toast
- **Validation**:
  - `name`: Required, max 255 chars. "Supplier name is required."
  - `code`: Required, max 50 chars, unique per tenant. "Supplier code is required." / "Code already exists."
  - `contactEmail`: Optional, valid email format. "Enter a valid email address."
  - `contactPhone`: Optional, valid phone format. "Enter a valid phone number."
  - `website`: Optional, valid URL format. "Enter a valid URL."
  - `postalCode`: Optional, max 20 chars.
  - `statedLeadTimeDays`: Optional, integer >= 0. "Lead time must be zero or positive."
  - `paymentTerms`: Optional, max 100 chars.

#### Modals / Drawers
- None

---

### Screen: Supplier Detail

**Route**: `/catalog/suppliers/:id`
**Roles**: tenant_admin (F), inventory_manager (R), procurement_manager (F), receiving_manager (R), executive (R) | **Access**: F = manage, R = view

#### Purpose
Display supplier information, linked parts, PO history, and performance metrics.

#### Layout
- **Header**: Supplier Name (large), Code badge, Active badge, action buttons
  - F roles: "Edit", "Deactivate"/"Activate"
- **Tab navigation**: Overview | Linked Parts | PO History | Performance
- **Overview tab**:
  - Left: Contact info card (Name, Email, Phone, Website), Address card
  - Right: Terms card (Payment Terms, Stated Lead Time), Notes
- **Linked Parts tab**: Table of `supplier_parts` for this supplier: Part Number (link), Part Name, Supplier Part Number, Unit Cost, Min Order Qty, Lead Time, Is Primary. Actions (F): "Edit Link", "Remove Link"
- **PO History tab**: Table of purchase orders for this supplier: PO Number (link), Status badge, Order Date, Expected Delivery, Actual Delivery, Total Amount. Sorted date DESC.
- **Performance tab** (metrics computed from PO history):
  - On-Time Delivery Rate: % of POs delivered on or before expected date
  - Avg Lead Time: Mean days from order date to actual delivery
  - Quality metrics: (placeholder for MVP, needs receiving quality data)
  - Total PO Value (lifetime)
  - Total PO Count

#### Primary Actions
- "Edit": Navigates to `/catalog/suppliers/{id}/edit`
- "Deactivate": Confirmation modal
- Part link click: `/catalog/parts/{partId}`
- PO Number click: `/orders/purchase/{poId}`

#### Data Displayed
- Full `suppliers` record
- Linked parts from `supplier_parts`
- PO history from `purchase_orders WHERE supplierId = :id`
- Performance metrics computed from PO data

#### States
- **Empty (Linked Parts)**: "No parts linked to this supplier yet." + "Link Part" button
- **Empty (PO History)**: "No purchase orders for this supplier."
- **Empty (Performance)**: "Not enough data for performance analysis. At least 3 completed POs needed."
- **Loading**: Skeleton
- **Error**: Error banner
- **404**: "Supplier not found."

#### Modals / Drawers
- **Edit Supplier Part Link Modal**: Supplier Part Number, Unit Cost, Min Order Qty, Lead Time, Is Primary toggle. Pre-populated. Actions: "Cancel", "Save" (primary). PATCH link.
- **Deactivate Supplier Confirm**: "Deactivate {name}? Active Kanban loops with this supplier will NOT be affected." Actions: "Cancel", "Deactivate" (red).

---

### Screen: Edit Supplier

**Route**: `/catalog/suppliers/:id/edit`
**Roles**: tenant_admin (F), procurement_manager (F) | **Access**: Write

#### Purpose
Modify supplier details.

#### Layout
- Identical to Create Supplier form, pre-populated.
- Code field is **read-only** after creation.

#### Primary Actions
- "Save Changes": PATCH, navigate to supplier detail
- "Cancel": Navigate to supplier detail with unsaved prompt

#### States
- Same as Create Supplier + pre-population loading

#### Modals / Drawers
- None

---

## 4. Bill of Materials

---

### Screen: BOM Explorer

**Route**: `/catalog/bom`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: F = edit BOM, R = view

#### Purpose
Navigate and explore Bill of Materials structures across all parts via a visual tree interface.

#### Layout
- **Header**: "BOM Explorer" title
- **Part selector**: Searchable select to choose a parent part. Only shows parts that have BOM children OR are of type subassembly/finished_good.
- **View toggle**: Tree View | Indented Table View
- **Tree View**: Interactive tree visualization of the selected part's multi-level BOM. Each node shows: Part Number, Part Name, Qty Per, total required qty (computed through levels). Nodes are expandable. Click a node to select it and show detail in a side panel.
- **Indented Table View**: Flat table with indentation showing hierarchy: Level, Part Number (link), Part Name, Qty Per (this level), Total Qty (exploded), Type badge, UOM
- **Side panel** (when node selected): Part quick info, Qty Per, suppliers list, Kanban loop status

#### Primary Actions
- Part selector change: Loads BOM tree for selected part, navigates URL to `/catalog/bom/{partId}`
- Node click (tree): Selects node, loads side panel
- Part Number click (table): Navigates to `/catalog/parts/{partId}`
- "View BOM for this Part" (in side panel): Navigates to `/catalog/bom/{selectedPartId}`, making selected part the root

#### Data Displayed
- BOM hierarchy from recursive `bom_items` queries starting from root `parentPartId`
- Part details for each node
- Exploded quantities computed: parent_qty_per * child_qty_per through levels

#### States
- **Initial**: "Select a part to explore its Bill of Materials." with part selector prominent.
- **Empty BOM**: "Part {partNumber} has no bill of materials defined."
- **Loading**: Skeleton tree or table
- **Error**: Error banner

#### Modals / Drawers
- None

---

### Screen: BOM Detail

**Route**: `/catalog/bom/:partId`
**Roles**: tenant_admin (F), inventory_manager (F), procurement_manager (R), receiving_manager (R), executive (R) | **Access**: F = edit, R = view

#### Purpose
Display and manage the single-level BOM for a specific parent part.

#### Layout
- **Header**: "BOM -- {Part Number} {Part Name}" title, Part Type badge, action buttons
  - F roles: "+ Add BOM Line"
- **Info banner**: "Single-level BOM showing direct children only. For multi-level exploded view, use the BOM Explorer."
- **BOM Table**: Child Part Number (link), Child Part Name, Child Type (badge), Qty Per (editable inline for F roles), Sort Order (drag handle for F roles), Notes (editable inline), Actions
  - Actions (F roles): "Remove" (trash icon)
- **Summary row**: Total unique children, Total child types breakdown
- **"Explore Full BOM" link**: Navigates to `/catalog/bom` with this part pre-selected (shows multi-level tree)

#### Primary Actions
- "+ Add BOM Line": Opens Add BOM Line modal
- Inline qty/notes edit (F roles): Auto-saves on blur with debounce, PATCH `/api/catalog/bom/{bomItemId}`
- Drag to reorder: Updates `sortOrder` via PATCH
- "Remove" per row: Confirmation then DELETE
- Part Number link: Navigates to child part detail

#### Data Displayed
- `bom_items WHERE parentPartId = :partId` with joined child part details
- Ordered by `sortOrder`

#### States
- **Empty**: "No BOM lines defined for {partNumber}. Add child parts to build the bill of materials." with "Add BOM Line" button.
- **Loading**: Table skeleton
- **Error**: Error banner
- **404**: "Part not found."

#### Modals / Drawers
- **Add BOM Line Modal**: Child Part (searchable select, required, must not equal parent, must not create circular reference), Qty Per (decimal input, required, > 0), Notes (textarea, optional). Validation: Cannot add duplicate child. Cannot add parent as its own child. Server validates no circular references. Actions: "Cancel", "Add Line" (primary). POST `/api/catalog/bom`.
