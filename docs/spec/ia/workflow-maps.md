# Arda V2 -- Workflow Maps

> Defines the primary and secondary user workflows with current and target click/time budgets.
> Includes step-by-step interaction flows, keyboard-only paths, and UX debt items that block each workflow's target state.
> Source of truth for workflow-level UX performance goals.

---

## 1. Overview

### 1.1 Purpose

This document maps the highest-frequency user workflows in the Arda Kanban system, establishes measurable click-depth and time budgets, and identifies the gaps between current implementation and target state. Each workflow includes a granular step-by-step interaction flow for both mouse and keyboard paths.

### 1.2 Scope

Covers the 5 primary workflows (executed multiple times per day by core personas) and 3 secondary workflows (executed daily or weekly). Each workflow is defined from a cold start on its entry page.

### 1.3 Workflow IDs

| ID | Workflow | Category |
|----|----------|----------|
| WF-01 | Queue Triage (Single Card) | Primary |
| WF-02 | Queue Triage (Bulk Order) | Primary |
| WF-03 | Scan Trigger | Primary |
| WF-04 | Part Lookup | Primary |
| WF-05 | Aging Card Review | Primary |
| WF-06 | Loop Parameter Adjustment | Secondary |
| WF-07 | Card Stage History | Secondary |
| WF-08 | Notification Triage | Secondary |

### 1.4 Key Metrics

| Metric | Definition |
|--------|-----------|
| **Click count** | Number of discrete mouse clicks or taps required to complete the workflow |
| **Interaction count** | Total interactions including keyboard input, scrolls, and clicks |
| **Time budget** | Maximum wall-clock time for a trained user to complete the workflow |
| **Keyboard-only** | Whether the workflow can be completed without a mouse |

---

## 2. Primary Workflows

### 2.1 WF-01: Queue Triage (Single Card)

**Persona**: Procurement Manager, Operations Manager
**Entry point**: `/queue` (sidebar "Order Queue")
**Frequency**: 10-30x per day

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Click count | 4 | 2 | -2 |
| Interactions | 4 | 2 | -2 |
| Time budget | ~12s | < 5s | -7s |
| Keyboard-only | No | Yes | Missing |

#### Current Path (4 clicks)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Click sidebar "Order Queue" | Sidebar nav item | Navigate to `/queue` |
| 2 | Click card row to expand | `QueueCardItem` row | `ExpandedCardPanel` opens below row |
| 3 | Scroll to action buttons | Scroll within panel | Action buttons become visible |
| 4 | Click "Create Order" | Button inside `ExpandedCardPanel` | Purchase order created, toast shown |

**Bottleneck**: Steps 2-3 are unnecessary indirection. The user's intent is to create an order for a visible card, but the action is hidden inside an expanded panel that requires scrolling.

#### Target Path (2 clicks)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Navigate to `/queue` | Sidebar or `g q` | Queue page loads |
| 2 | Click inline cart icon | `ShoppingCart` icon button on `QueueCardItem` row | Order created directly, toast shown |

#### Target Keyboard Path (3-4 keystrokes)

| Step | Keys | Action | Result |
|------|------|--------|--------|
| 1 | `g q` | Go-To chord | Navigate to `/queue` |
| 2 | `j`/`k` | Focus navigation | Move focus ring to target card |
| 3 | `Shift+Enter` | Create order shortcut | Order created for focused card |

**Dependencies**: UX-003 (inline card action button), UX-005 (Go-To chords), UX-007 (j/k navigation), UX-011 (Shift+Enter shortcut)

---

### 2.2 WF-02: Queue Triage (Bulk Order)

**Persona**: Procurement Manager, Operations Manager
**Entry point**: `/queue`
**Frequency**: 2-5x per day

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Click count (5 cards) | 1 + 5*5 = 26 | 1 + 5 + 2 = 8 | -18 |
| Interactions | 26 | 8 | -18 |
| Time budget | ~60s | < 15s | -45s |
| Keyboard-only | No | Yes | Missing |

#### Current Path (1 + 5N clicks, N = cards)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Navigate to `/queue` | Sidebar | Queue page loads |
| 2-6 | Per card: expand (1), scroll (1), click "Create Order" (1), wait for toast (1), close (1) | `QueueCardItem`, `ExpandedCardPanel` | One order created per iteration |

No batch creation exists. Each order must be created individually through the expand-scroll-click-wait-close cycle.

#### Target Path (1 + N + 2 clicks)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Navigate to `/queue` | Sidebar or `g q` | Queue page loads |
| 2-6 | Check N card checkboxes | Checkbox on each `QueueCardItem` | Cards marked as selected |
| 7 | Click "Create Orders" | Bulk action bar button | Confirmation modal opens |
| 8 | Click "Confirm" | Modal confirm button | All orders created, toast with count |

#### Target Keyboard Path (N + 4 keystrokes)

| Step | Keys | Action | Result |
|------|------|--------|--------|
| 1 | `g q` | Go-To chord | Navigate to `/queue` |
| 2-6 | `j` + `x` (repeat N times) | Focus + toggle select | N cards selected |
| 7 | `Ctrl+Shift+Enter` | Bulk create shortcut | Confirmation modal opens |
| 8 | `Enter` | Confirm modal | All orders created |

**Dependencies**: UX-005 (Go-To chords), UX-006 (bulk selection + actions bar), UX-007 (j/k navigation)

---

### 2.3 WF-03: Scan Trigger

**Persona**: Warehouse/Receiving Personnel, Inventory Manager
**Entry point**: Header "Scan" button or `/scan`
**Frequency**: 20-50x per day

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Click count | 2 | 1 | -1 |
| Interactions | 2 | 1 | -1 |
| Time budget | ~3s | < 2s | -1s |
| Keyboard-only | No | Yes | Missing |

#### Current Path (2 interactions)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Click header "Scan" button | Header `QrCode` icon button | Navigate to `/scan` |
| 2 | Scan QR code | Camera viewfinder | Card identified, navigate to `/scan/:cardId` |

#### Target Path (1-2 interactions)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | `Cmd+K`, type "scan", select "Scan Card" | Command palette workflow item | Navigate to `/scan`, camera activates |
| 1-alt | Click header "Scan" button (unchanged) | Header icon button | Same as current |
| 2 | Scan QR code | Camera viewfinder | Card identified |

The scan workflow is already well-optimized via the `/scan/:cardId` deep-link pattern. The primary improvement is adding a keyboard-accessible path via the command palette.

**Dependencies**: UX-013 (scan via command palette)

---

### 2.4 WF-04: Part Lookup

**Persona**: All roles with catalog access
**Entry point**: Any page
**Frequency**: 10-20x per day

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Click count | 2 | 1 | -1 |
| Interactions | 2+ | 1 | -1+ |
| Time budget | ~8s | < 3s | -5s |
| Keyboard-only | No | Yes | Missing |

#### Current Path (2+ interactions)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Click sidebar "Items" | Sidebar nav item | Navigate to `/parts` |
| 2 | Type in search box | Search input on parts page | Results filter as user types |
| 3 | Click matching part | Part row | Navigate to part detail |

#### Target Path (1 interaction)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | `Cmd+K` or `/` | Command palette opens | Search input focused |
| 2 | Type part name or number | Palette search input | Entity search results appear instantly |
| 3 | Select matching part | Entity search result item | Navigate to part detail |

Entity search in the command palette eliminates the need to navigate to the parts page first. Parts are already loaded client-side via `useWorkspaceData`, so search can be instant (no API call required).

**Dependencies**: UX-004 (entity search in palette), UX-001 (fix palette routes), UX-002 (add missing pages)

---

### 2.5 WF-05: Aging Card Review

**Persona**: Operations Manager, Inventory Manager
**Entry point**: `/` (Dashboard) or `/queue`
**Frequency**: 2-5x per day

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Click count | 1 + visual scan | 0 + inline action | -1 |
| Interactions | 2 | 1 | -1 |
| Time budget | ~5s | < 2s | -3s |
| Keyboard-only | No | Yes | Missing |

#### Current Path (1 click + visual scan)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Navigate to `/queue` | Sidebar or direct URL | Queue page loads |
| 2 | Visually scan for aging badges | Orange/red badges on cards | User identifies aging cards manually |

#### Target Path (1 click)

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Click "Review N aging cards" link | `NextActionBanner` on Dashboard or Queue | Navigate to `/queue?aging=true` (pre-filtered) |
| 2 | Review filtered cards | Queue page showing only aging cards | User sees only cards needing attention |

The `NextActionBanner` component currently renders on the queue page showing summary counts but does not link to specific filtered views or individual cards.

**Dependencies**: UX-008 (NextActionBanner deep-link), UX-014 (queue filters in URL)

---

## 3. Secondary Workflows

### 3.1 WF-06: Loop Parameter Adjustment

**Persona**: Inventory Manager, Operations Manager
**Entry point**: `/loops` or `/loops/:loopId`
**Frequency**: 1-3x per week

| Metric | Current | Target |
|--------|---------|--------|
| Click count | 4 | 3 |
| Time budget | ~20s | < 15s |

#### Path

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Navigate to `/loops` | Sidebar or `g l` | Loops list loads |
| 2 | Select loop | Loop row | Loop detail page |
| 3 | Click edit | Edit button | Parameters become editable |
| 4 | Modify parameters + save | Form inputs + Save button | Parameters updated |

No significant IA changes needed. Primary improvement is command palette search for loops by name (via entity search in UX-004).

### 3.2 WF-07: Card Stage History

**Persona**: Operations Manager, Inventory Manager
**Entry point**: Card detail page
**Frequency**: 2-5x per week

| Metric | Current | Target |
|--------|---------|--------|
| Click count | 3 | 2 |
| Time budget | ~10s | < 6s |

#### Path

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Navigate to `/cards` | Sidebar or `g c` | Cards list loads |
| 2 | Select card | Card row | Card detail page |
| 3 | View transition history | History section | Stage transitions displayed |

Improvement: command palette entity search for cards by card number eliminates step 1 (via UX-004).

### 3.3 WF-08: Notification Triage

**Persona**: All roles
**Entry point**: Header bell icon
**Frequency**: 3-10x per day

| Metric | Current | Target |
|--------|---------|--------|
| Click count | 2 | 2 |
| Time budget | ~5s | < 5s |

#### Path

| Step | Action | UI Element | Result |
|------|--------|-----------|--------|
| 1 | Click bell icon | Header notification icon | Notification panel opens |
| 2 | Review notifications | Notification list | User reads and acts on notifications |

No changes needed for MVP Phase 1.

---

## 4. Workflow-to-Route Mapping

| ID | Workflow | Primary Route | Supporting Routes | Entry Methods |
|----|----------|--------------|-------------------|---------------|
| WF-01 | Queue Triage (Single) | `/queue` | -- | Sidebar, `g q` |
| WF-02 | Queue Triage (Bulk) | `/queue` | -- | Sidebar, `g q` |
| WF-03 | Scan Trigger | `/scan`, `/scan/:cardId` | -- | Header button, `g s`, `Cmd+K` |
| WF-04 | Part Lookup | `/parts` | -- | `Cmd+K` entity search |
| WF-05 | Aging Card Review | `/queue` | `/` (dashboard) | NextActionBanner link |
| WF-06 | Loop Parameter Adjust | `/loops/:loopId` | `/loops` | Sidebar, `g l`, `Cmd+K` |
| WF-07 | Card Stage History | `/cards` | -- | Sidebar, `g c`, `Cmd+K` |
| WF-08 | Notification Triage | -- | -- | Header bell icon |

---

## 5. Click Budget Summary

| # | ID | Workflow | Current Clicks | Target Clicks | Reduction | Priority |
|---|-----|----------|---------------|--------------|-----------|----------|
| 1 | WF-01 | Queue Triage (Single) | 4 | 2 | -50% | P0 |
| 2 | WF-02 | Queue Triage (Bulk, 5 cards) | 26 | 8 | -69% | P0 |
| 3 | WF-03 | Scan Trigger | 2 | 1 | -50% | P1 |
| 4 | WF-04 | Part Lookup | 2+ | 1 | -50%+ | P0 |
| 5 | WF-05 | Aging Card Review | 2 | 1 | -50% | P1 |
| 6 | WF-06 | Loop Parameter Adjust | 4 | 3 | -25% | P2 |
| 7 | WF-07 | Card Stage History | 3 | 2 | -33% | P2 |
| 8 | WF-08 | Notification Triage | 2 | 2 | 0% | -- |

**Overall target**: Every primary workflow reachable and completable via keyboard-only path. No primary workflow exceeds 3 clicks from its entry page.

---

## 6. UX Debt Blocking Workflows

Each item below blocks one or more workflows from reaching their target click/time budgets. Items are ordered by priority and cross-referenced to `ux-debt-backlog.md`.

### 6.1 P0 -- Critical (Sprint 1)

#### UX-001: Fix command palette routes

- **Workflows blocked**: WF-04 (Part Lookup), all navigation workflows
- **Current**: `PAGE_ITEMS` maps "Order History" to `/notifications` and "Receiving" to `/scan`
- **Target**: "Order History" -> `/orders`, "Receiving" -> `/receiving`
- **Measurable outcome**: Palette navigation lands on correct page 100% of the time
- **File(s)**: `apps/web/src/components/command-palette.tsx` (lines 34-40)
- **Effort**: XS (< 2h)

#### UX-002: Add missing pages to palette

- **Workflows blocked**: All workflows (navigation completeness)
- **Current**: Cards, Loops, and Receiving absent from `PAGE_ITEMS`
- **Target**: All 8 routable pages present in command palette
- **Measurable outcome**: 8/8 pages navigable via `Cmd+K`
- **File(s)**: `apps/web/src/components/command-palette.tsx`
- **Effort**: XS (< 2h)

#### UX-003: Inline card order button

- **Workflows blocked**: WF-01 (Queue Triage Single) -- 4 clicks instead of 2
- **Current**: "Create Order" only inside `ExpandedCardPanel` (requires expand + scroll)
- **Target**: Inline `ShoppingCart` icon button on `QueueCardItem` row
- **Measurable outcome**: Single-card order creation in 2 clicks / < 5s
- **File(s)**: `apps/web/src/pages/queue.tsx` (QueueCardItem, lines 146-220)
- **Effort**: S (2-4h)

#### UX-004: Entity search in palette

- **Workflows blocked**: WF-04 (Part Lookup) -- 2+ clicks instead of 1
- **Current**: Palette only searches page labels and action names
- **Target**: Entity search group querying in-memory `useWorkspaceData` (parts, cards, loops)
- **Measurable outcome**: Part found and navigated to in 1 interaction / < 3s
- **File(s)**: `apps/web/src/components/command-palette.tsx`, `apps/web/src/hooks/use-workspace-data.ts`
- **Effort**: M (4-8h)

### 6.2 P1 -- High (Sprint 1-2)

#### UX-005: Go-To keyboard chords

- **Workflows blocked**: All primary workflows (keyboard-only path)
- **Current**: `onNavigate` defined in TypeScript interface but never invoked
- **Target**: `g` + letter chord system (500ms window) wired to `navigate()`
- **Measurable outcome**: All 8 pages navigable via 2-key chord
- **File(s)**: `apps/web/src/hooks/use-keyboard-shortcuts.ts`, `apps/web/src/layouts/app-shell.tsx`
- **Effort**: M (4-8h)

#### UX-006: Bulk order creation

- **Workflows blocked**: WF-02 (Queue Triage Bulk) -- 26 clicks instead of 8
- **Current**: No checkbox selection, each order created individually
- **Target**: Per-card checkboxes, selection state, sticky bulk actions bar
- **Measurable outcome**: 5-card bulk order in 8 clicks / < 15s
- **File(s)**: `apps/web/src/pages/queue.tsx`
- **Effort**: M (4-8h)

#### UX-007: j/k keyboard card navigation

- **Workflows blocked**: WF-01, WF-02 (no keyboard-only path for queue)
- **Current**: No focus management for queue card list
- **Target**: `j`/`k` moves visible focus ring through cards
- **Measurable outcome**: Queue cards traversable without mouse
- **File(s)**: `apps/web/src/pages/queue.tsx`
- **Effort**: S (2-4h)

#### UX-008: NextActionBanner deep-link

- **Workflows blocked**: WF-05 (Aging Card Review) -- 2 clicks instead of 1
- **Current**: Banner shows counts but clicking does not filter/navigate
- **Target**: "Review N aging cards" link navigates to `/queue?aging=true`
- **Measurable outcome**: Aging cards reachable in 1 click from Dashboard
- **File(s)**: `apps/web/src/components/next-action-banner.tsx`, `apps/web/src/pages/dashboard.tsx`
- **Effort**: XS (< 2h)

#### UX-009: Wire refresh shortcut

- **Workflows blocked**: All workflows (data freshness)
- **Current**: `r` key partially handled but `onRefresh` not wired
- **Target**: `r` triggers current page's data refresh function
- **Measurable outcome**: Data refresh achievable without mouse click
- **File(s)**: `apps/web/src/layouts/app-shell.tsx`, `apps/web/src/hooks/use-keyboard-shortcuts.ts`
- **Effort**: S (2-4h)

### 6.3 P2 -- Medium (Sprint 2-3)

#### UX-010: Keyboard help overlay

- **Workflows blocked**: Discoverability
- **Current**: No way to discover shortcuts without reading source code
- **Target**: `?` key opens modal listing all shortcuts by category
- **File(s)**: New component: `apps/web/src/components/keyboard-help.tsx`
- **Effort**: S (2-4h)

#### UX-011: Shift+Enter order creation shortcut

- **Workflows blocked**: WF-01 (keyboard-only order creation)
- **Current**: No shortcut for creating order from focused card
- **Target**: `Shift+Enter` triggers order creation when card has focus
- **File(s)**: `apps/web/src/pages/queue.tsx`, `apps/web/src/hooks/use-keyboard-shortcuts.ts`
- **Effort**: S (2-4h)

#### UX-012: Palette shortcut display

- **Workflows blocked**: Discoverability
- **Current**: Only "Refresh data" shows shortcut hint
- **Target**: All palette items display keyboard shortcuts via `<CommandShortcut>`
- **File(s)**: `apps/web/src/components/command-palette.tsx`
- **Effort**: XS (< 2h)

#### UX-013: Scan via command palette

- **Workflows blocked**: WF-03 (keyboard-accessible scan)
- **Current**: Scan requires clicking header button
- **Target**: "Scan a card" workflow item in palette navigates to `/scan`
- **File(s)**: `apps/web/src/components/command-palette.tsx`
- **Effort**: XS (< 2h)

#### UX-014: Queue filters in URL

- **Workflows blocked**: WF-05 (Aging Card Review), WF-01/WF-02 (filter persistence)
- **Current**: Filter state in React state only; page refresh resets all
- **Target**: Persist in URL search params (`?loop=procurement&sort=age&q=widget`)
- **File(s)**: `apps/web/src/pages/queue.tsx`
- **Effort**: S (2-4h)

### 6.4 P3 -- Low (Backlog)

#### UX-015: Order entity search (API-backed)

- **Workflows blocked**: Part Lookup extended to orders
- **Target**: `GET /api/orders/search?q=...` + palette integration
- **Effort**: M (4-8h)

#### UX-016: Mobile bottom navigation bar

- **Workflows blocked**: All mobile workflows
- **Target**: Bottom nav bar for `< 768px` viewports
- **Effort**: M (4-8h)

#### UX-017: Breadcrumb navigation

- **Workflows blocked**: All (wayfinding)
- **Target**: Auto-generated breadcrumbs from route path segments
- **Effort**: M (4-8h)

#### UX-018: Recent items in palette

- **Workflows blocked**: Part Lookup, general navigation
- **Target**: Last 5 navigations tracked in `localStorage`, shown as "Recent" group
- **Effort**: S (2-4h)

---

## 7. UX Debt Summary

| ID | Title | Priority | Effort | Workflows Blocked | Measurable Outcome |
|----|-------|----------|--------|-------------------|-------------------|
| UX-001 | Fix palette routes | P0 | XS | WF-04, All | Palette navigation correct 100% |
| UX-002 | Add missing pages | P0 | XS | All | 8/8 pages in palette |
| UX-003 | Inline card order button | P0 | S | WF-01 | 2-click single order |
| UX-004 | Entity search | P0 | M | WF-04 | 1-interaction part lookup |
| UX-005 | Go-To chords | P1 | M | All primary | 8 pages via keyboard |
| UX-006 | Bulk order creation | P1 | M | WF-02 | 8-click bulk order (5 cards) |
| UX-007 | j/k card navigation | P1 | S | WF-01, WF-02 | Mouse-free queue navigation |
| UX-008 | Banner deep-link | P1 | XS | WF-05 | 1-click aging review |
| UX-009 | Refresh shortcut | P1 | S | All | Keyboard data refresh |
| UX-010 | Help overlay | P2 | S | Discoverability | Shortcuts discoverable via `?` |
| UX-011 | Shift+Enter order | P2 | S | WF-01 | Keyboard-only order creation |
| UX-012 | Palette shortcuts | P2 | XS | Discoverability | All items show shortcuts |
| UX-013 | Scan via palette | P2 | XS | WF-03 | Keyboard-accessible scan |
| UX-014 | URL query filters | P2 | S | WF-05, WF-01/02 | Filter state survives refresh |
| UX-015 | Order search (API) | P3 | M | WF-04 ext. | Deferred to Phase 2 |
| UX-016 | Mobile nav | P3 | M | All mobile | Deferred to Phase 2 |
| UX-017 | Breadcrumbs | P3 | M | All (wayfinding) | Deferred to Phase 2 |
| UX-018 | Recent items | P3 | S | WF-04 | Deferred to Phase 2 |

### Effort Summary

| Phase | Items | Estimated Hours |
|-------|-------|----------------|
| Sprint 1 (P0) | UX-001, UX-002, UX-003, UX-004 | ~9h |
| Sprint 1-2 (P1) | UX-005, UX-006, UX-007, UX-008, UX-009 | ~16h |
| Sprint 2-3 (P2) | UX-010, UX-011, UX-012, UX-013, UX-014 | ~10h |
| Backlog (P3) | UX-015, UX-016, UX-017, UX-018 | ~14h |
| **Total** | **18 items** | **~49h** |

---

## 8. Cross-References

| Document | Relationship |
|----------|-------------|
| `docs/spec/ia/kanban-ia-simplification.md` | Parent IA simplification spec; defines the command-centered design this document measures |
| `docs/spec/ia/command-surface.md` | Target interaction model that workflow improvements work toward |
| `docs/spec/ia/ux-debt-backlog.md` | Canonical UX gap list; this document integrates debt items with workflow context |
| `docs/spec/ia/navigation-model.md` | Route and sidebar definitions |
| `docs/spec/ia/sitemap.md` | Complete route hierarchy for all personas |
| `docs/spec/screens/kanban-screens.md` | Screen-level specs for affected pages |
