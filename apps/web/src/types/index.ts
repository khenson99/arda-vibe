import type { LucideIcon } from "lucide-react";
import { Truck, Factory, Package2 } from "lucide-react";

/* ── Loop types ──────────────────────────────────────────────── */

export type LoopType = "procurement" | "production" | "transfer";

export const LOOP_ORDER: LoopType[] = ["procurement", "production", "transfer"];

export const LOOP_META: Record<LoopType, { label: string; icon: LucideIcon }> = {
  procurement: { label: "Procurement", icon: Truck },
  production: { label: "Production", icon: Factory },
  transfer: { label: "Transfer", icon: Package2 },
};

/* ── Items table column definitions ──────────────────────────── */

export const ITEMS_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

export const ITEM_TABLE_COLUMNS = [
  { key: "item", label: "Item", defaultVisible: true, required: true },
  { key: "image", label: "Image", defaultVisible: true, required: true },
  { key: "quickActions", label: "Quick actions", defaultVisible: true, required: true },
  { key: "supplier", label: "Supplier", defaultVisible: true, required: false },
  { key: "unitPrice", label: "Unit price", defaultVisible: true, required: false },
  { key: "orderQuantity", label: "Order quantity", defaultVisible: true, required: false },
  { key: "orderUnits", label: "Order units", defaultVisible: true, required: false },
  { key: "minQuantity", label: "Min quantity", defaultVisible: true, required: false },
  { key: "minUnits", label: "Min units", defaultVisible: true, required: false },
  { key: "cards", label: "# of Cards", defaultVisible: true, required: false },
  { key: "notes", label: "Notes", defaultVisible: true, required: false },
  { key: "orderMethod", label: "Order method", defaultVisible: false, required: false },
  { key: "location", label: "Location", defaultVisible: false, required: false },
  { key: "status", label: "Status", defaultVisible: false, required: false },
  { key: "updated", label: "Updated", defaultVisible: false, required: false },
  { key: "glCode", label: "GL code", defaultVisible: false, required: false },
] as const;

export type ItemTableColumnKey = (typeof ITEM_TABLE_COLUMNS)[number]["key"];

export type InlineEditableField =
  | "supplier"
  | "orderQuantity"
  | "orderUnits"
  | "minQuantity"
  | "minUnits"
  | "orderMethod"
  | "location";

export const ITEM_TABLE_COLUMN_KEYS = ITEM_TABLE_COLUMNS.map((column) => column.key);

export const ITEM_TABLE_DEFAULT_VISIBLE_COLUMNS = ITEM_TABLE_COLUMNS
  .filter((column) => column.defaultVisible)
  .map((column) => column.key);

/* ── Auth ─────────────────────────────────────────────────────── */

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  tenantId: string;
  tenantName: string;
  tenantSlug?: string;
  tenantLogo?: string;
}

export interface AuthSession {
  tokens: AuthTokens;
  user: SessionUser;
}

export interface AuthResponse {
  tokens: AuthTokens;
  user: SessionUser;
}

/* ── Queue ────────────────────────────────────────────────────── */

export interface QueueSummary {
  totalAwaitingOrders: number;
  oldestCardAgeHours: number;
  byLoopType: Record<string, number>;
}

export interface QueueCard {
  id: string;
  cardNumber: number;
  currentStage: string;
  currentStageEnteredAt: string;
  loopId: string;
  loopType: LoopType;
  partId: string;
  facilityId: string;
  primarySupplierId?: string | null;
  supplierName?: string | null;
  supplierContactEmail?: string | null;
  supplierContactPhone?: string | null;
  draftPurchaseOrderId?: string | null;
  minQuantity: number;
  orderQuantity: number;
  numberOfCards: number;
}

export type QueueByLoop = Record<LoopType, QueueCard[]>;

/* ── Parts / Items ────────────────────────────────────────────── */

export interface PartsResponse {
  data: PartRecord[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface PartRecord {
  id: string;
  partNumber: string;
  name: string;
  type: string;
  uom: string;
  isSellable: boolean;
  isActive: boolean;
  eId?: string;
  externalGuid?: string | null;
  orderMechanism?: string | null;
  location?: string | null;
  minQty?: number | null;
  minQtyUnit?: string | null;
  orderQty?: number | null;
  orderQtyUnit?: string | null;
  primarySupplier?: string | null;
  primarySupplierLink?: string | null;
  notes?: string | null;
  unitPrice?: string | number | null;
  imageUrl?: string | null;
  glCode?: string | null;
  itemSubtype?: string | null;
  createdAt?: string;
  updatedAt: string;
}

export interface FacilityRecord {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  type: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StorageLocationRecord {
  id: string;
  tenantId: string;
  facilityId: string;
  name: string;
  code: string;
  zone?: string | null;
  description?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierRecord {
  id: string;
  tenantId: string;
  name: string;
  code?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProcurementOrderMethod =
  | "email"
  | "online"
  | "purchase_order"
  | "shopping"
  | "rfq"
  | "third_party"
  | "phone";

export interface ProcurementDraftLineInput {
  cardId: string;
  quantityOrdered: number;
  description?: string | null;
  orderMethod: ProcurementOrderMethod;
  sourceUrl?: string | null;
  notes?: string | null;
}

export interface CreateProcurementDraftsInput {
  supplierId: string;
  recipientEmail?: string | null;
  paymentTerms?: string | null;
  shippingTerms?: string | null;
  notes?: string | null;
  thirdPartyInstructions?: string | null;
  lines: ProcurementDraftLineInput[];
}

export interface CreateProcurementDraftsResult {
  supplierId: string;
  recipientEmail: string | null;
  drafts: Array<{
    poId: string;
    poNumber: string;
    facilityId: string;
    cardIds: string[];
  }>;
  totalDrafts: number;
  totalCards: number;
}

export interface VerifyProcurementDraftsInput {
  poIds: string[];
  cardIds: string[];
}

/* ── Data Authority (bitemporal records) ──────────────────────── */

export interface DataAuthorityTimeCoordinates {
  effective: number;
  recorded: number;
}

export interface DataAuthorityEntityRecord<TPayload, TMetadata = Record<string, unknown>> {
  rId: string;
  asOf: DataAuthorityTimeCoordinates;
  payload: TPayload;
  metadata: TMetadata;
  previous?: string | null;
  retired: boolean;
}

export interface DataAuthorityPageResult<TPayload, TMetadata = Record<string, unknown>> {
  thisPage: string;
  nextPage: string;
  previousPage?: string | null;
  results: Array<DataAuthorityEntityRecord<TPayload, TMetadata>>;
  totalCount?: number | null;
}

export interface DataAuthorityCreateRequest<TPayload, TMetadata = Record<string, unknown>> {
  payload: TPayload;
  metadata: TMetadata;
  effectiveAt: number;
  author: string;
}

export interface ItemsServicePayload {
  eId: string;
  externalGuid?: string | null;
  name: string;
  orderMechanism?: string | null;
  location?: string | null;
  minQty?: number | null;
  minQtyUnit?: string | null;
  orderQty?: number | null;
  orderQtyUnit?: string | null;
  primarySupplier?: string | null;
  primarySupplierLink?: string | null;
  imageUrl?: string | null;
  notes?: string | null;
  glCode?: string | null;
  itemSubtype?: string | null;
}

export interface ItemsServiceInputPayload {
  externalGuid: string;
  name: string;
  orderMechanism: string;
  location: string | null;
  minQty: number;
  minQtyUnit: string;
  orderQty: number | null;
  orderQtyUnit: string | null;
  primarySupplier: string;
  primarySupplierLink: string | null;
  imageUrl: string | null;
  notes?: string | null;
}

/* ── Orders ───────────────────────────────────────────────────── */

export interface OrderLineItemReference {
  eId: string;
  rId?: string | null;
  name?: string | null;
}

export interface OrderLineQuantityValue {
  amount: number;
  unit: string;
}

export interface OrderLineMoneyValue {
  value: number;
  currency: string;
}

export interface OrdersServiceOrderLinePayload {
  eId: string;
  status: string;
  item?: OrderLineItemReference | null;
  quantity?: OrderLineQuantityValue | null;
  unitCost?: OrderLineMoneyValue | null;
  received?: OrderLineQuantityValue | null;
  notes?: string | null;
  privateNotes?: string | null;
}

export interface OrderLineByItemSummary {
  itemEId: string;
  status: string | null;
  unitCostValue: number | null;
  unitCostCurrency: string | null;
  orderedQty: number | null;
  orderedQtyUnit: string | null;
  receivedQty: number | null;
  receivedQtyUnit: string | null;
  notes: string | null;
  updatedAt: string | null;
}

/* ── Notifications ────────────────────────────────────────────── */

export interface NotificationRecord {
  id: string;
  type: string;
  title: string;
  body: string;
  actionUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

/* ── Kanban stages ───────────────────────────────────────────── */

export type CardStage =
  | "created"
  | "triggered"
  | "ordered"
  | "in_transit"
  | "received"
  | "restocked";

export const CARD_STAGES: CardStage[] = [
  "created",
  "triggered",
  "ordered",
  "in_transit",
  "received",
  "restocked",
];

export const CARD_STAGE_META: Record<
  CardStage,
  { label: string; color: string; bgClass: string; textClass: string }
> = {
  created: { label: "Created", color: "hsl(var(--muted-foreground))", bgClass: "bg-muted", textClass: "text-muted-foreground" },
  triggered: { label: "Triggered", color: "hsl(var(--arda-warning))", bgClass: "bg-[hsl(var(--arda-warning-light))]", textClass: "text-[hsl(var(--arda-warning))]" },
  ordered: { label: "Ordered", color: "hsl(var(--accent))", bgClass: "bg-accent/10", textClass: "text-[hsl(var(--accent))]" },
  in_transit: { label: "In Transit", color: "hsl(var(--secondary-foreground))", bgClass: "bg-secondary", textClass: "text-secondary-foreground" },
  received: { label: "Received", color: "hsl(var(--arda-success))", bgClass: "bg-[hsl(var(--arda-success-light))]", textClass: "text-[hsl(var(--arda-success))]" },
  restocked: { label: "Restocked", color: "hsl(var(--arda-success))", bgClass: "bg-[hsl(var(--arda-success-light))]", textClass: "text-[hsl(var(--arda-success))]" },
};

/* ── Kanban loop & card models ───────────────────────────────── */

export interface KanbanLoop {
  id: string;
  tenantId: string;
  partId: string;
  facilityId: string;
  loopType: LoopType;
  cardMode: string;
  status: string;
  numberOfCards: number;
  minQuantity: number;
  orderQuantity: number;
  statedLeadTimeDays: number | null;
  safetyStockDays: number | null;
  reorderPoint: number | null;
  primarySupplierId?: string | null;
  sourceFacilityId?: string | null;
  storageLocationId?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  partName?: string;
  facilityName?: string;
}

export interface KanbanCard {
  id: string;
  tenantId: string;
  loopId: string;
  cardNumber: number;
  currentStage: CardStage;
  currentStageEnteredAt: string;
  completedCycles: number;
  lastPrintedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /* Joined/denormalized data (may come from API) */
  loopType?: LoopType;
  partId?: string;
  partName?: string;
  facilityId?: string;
  facilityName?: string;
  minQuantity?: number;
  orderQuantity?: number;
  numberOfCards?: number;
}

export interface CardTransition {
  id: string;
  cardId: string;
  fromStage: CardStage;
  toStage: CardStage;
  method: string;
  performedBy: string | null;
  notes: string | null;
  createdAt: string;
}

export interface KanbanParameterChange {
  id: string;
  loopId: string;
  parameter: string;
  oldValue: string;
  newValue: string;
  reason: string | null;
  changedBy: string | null;
  createdAt: string;
}

export interface LoopCardSummary {
  loopId: string;
  totalCards: number;
  byStage: Partial<Record<CardStage, number>>;
}

export interface LoopVelocity {
  loopId: string;
  avgCycleTimeHours: number | null;
  avgLeadTimeHours: number | null;
  completedCyclesLast30d: number;
  throughputPerDay: number | null;
}

/* ── Purchase Order statuses ─────────────────────────────────── */

export type POStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sent"
  | "acknowledged"
  | "partially_received"
  | "received"
  | "closed"
  | "cancelled";

export const PO_STATUS_META: Record<
  POStatus,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  draft: { label: "Draft", variant: "secondary" },
  pending_approval: { label: "Pending Approval", variant: "outline" },
  approved: { label: "Approved", variant: "default" },
  sent: { label: "Sent", variant: "default" },
  acknowledged: { label: "Acknowledged", variant: "default" },
  partially_received: { label: "Partially Received", variant: "outline" },
  received: { label: "Received", variant: "default" },
  closed: { label: "Closed", variant: "secondary" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

/* ── Purchase Order ──────────────────────────────────────────── */

export interface PurchaseOrder {
  id: string;
  tenantId: string;
  poNumber: string;
  status: POStatus;
  supplierId: string | null;
  supplierName: string | null;
  facilityId: string;
  totalAmount: number | null;
  currency: string;
  notes: string | null;
  paymentTerms?: string | null;
  shippingTerms?: string | null;
  sentToEmail?: string | null;
  expectedDeliveryDate: string | null;
  orderedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: PurchaseOrderLine[];
}

export interface PurchaseOrderLine {
  id: string;
  purchaseOrderId: string;
  partId: string;
  partName?: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitPrice: number | null;
  currency: string;
  notes: string | null;
  description?: string | null;
  orderMethod?: ProcurementOrderMethod | null;
  sourceUrl?: string | null;
}

/* ── Work Order ──────────────────────────────────────────────── */

export type WOStatus = "draft" | "scheduled" | "in_progress" | "completed" | "cancelled";

export interface WorkOrder {
  id: string;
  tenantId: string;
  woNumber: string;
  status: WOStatus;
  facilityId: string;
  partId: string;
  partName?: string;
  quantityOrdered: number;
  quantityCompleted: number;
  scheduledDate: string | null;
  completedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ── Transfer Order ──────────────────────────────────────────── */

export type TOStatus =
  | "draft"
  | "requested"
  | "approved"
  | "picking"
  | "shipped"
  | "in_transit"
  | "received"
  | "closed"
  | "cancelled";

export interface TransferOrder {
  id: string;
  tenantId: string;
  toNumber: string;
  status: TOStatus;
  sourceFacilityId: string;
  destinationFacilityId: string;
  sourceFacilityName?: string;
  destinationFacilityName?: string;
  notes: string | null;
  requestedDate: string | null;
  shippedDate: string | null;
  receivedDate: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: TransferOrderLine[];
}

export interface TransferOrderLine {
  id: string;
  transferOrderId: string;
  partId: string;
  partName?: string;
  quantityRequested: number;
  quantityShipped: number;
  quantityReceived: number;
  notes: string | null;
}

/* ── Source Recommendation ────────────────────────────────────── */

export interface SourceRecommendation {
  facilityId: string;
  facilityName: string;
  facilityCode: string;
  availableQty: number;
  avgLeadTimeDays: number | null;
  distanceKm: number | null;
  score: number;
}

/* ── Inventory Ledger ─────────────────────────────────────────── */

export interface InventoryLedgerEntry {
  id: string;
  tenantId: string;
  facilityId: string;
  partId: string;
  partName?: string;
  qtyOnHand: number;
  qtyReserved: number;
  qtyInTransit: number;
  reorderPoint: number | null;
  reorderQty: number | null;
  updatedAt: string;
}

/* ── Receiving ───────────────────────────────────────────────── */

export type ReceiptStatus = "pending" | "completed" | "rejected";
export type ExceptionType = "overage" | "shortage" | "damage" | "wrong_item" | "quality" | "other";
export type ExceptionSeverity = "low" | "medium" | "high" | "critical";
export type ExceptionResolution = "accepted" | "rejected" | "returned" | "credited";

export interface Receipt {
  id: string;
  tenantId: string;
  orderId: string;
  orderType: string;
  status: ReceiptStatus;
  receivedBy: string | null;
  receivedAt: string;
  notes: string | null;
  createdAt: string;
  lines?: ReceiptLine[];
}

export interface ReceiptLine {
  id: string;
  receiptId: string;
  partId: string;
  partName?: string;
  quantityAccepted: number;
  quantityDamaged: number;
  quantityRejected: number;
  notes: string | null;
}

export interface ReceivingException {
  id: string;
  tenantId: string;
  receiptId: string | null;
  orderId: string | null;
  type: ExceptionType;
  severity: ExceptionSeverity;
  resolution: ExceptionResolution | null;
  description: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ReceivingMetrics {
  totalReceipts: number;
  totalExceptions: number;
  avgReceivingTimeHours: number | null;
  onTimeDeliveryRate: number | null;
  exceptionRate: number | null;
  receiptsByDay: Array<{ date: string; count: number }>;
}

/* ── Unified Order (for combined views) ──────────────────────── */

export type OrderType = "purchase" | "work" | "transfer";

export interface UnifiedOrder {
  id: string;
  orderNumber: string;
  type: OrderType;
  status: string;
  sourceName: string | null;
  totalAmount: number | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
  expectedDate: string | null;
}
