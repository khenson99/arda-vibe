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
