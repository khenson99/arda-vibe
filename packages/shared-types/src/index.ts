// ─── Shared Types for Arda V2 ──────────────────────────────────────────
// Types used across multiple services. Import from @arda/shared-types.

// ─── User Roles ───────────────────────────────────────────────────────
export type UserRole =
  | 'tenant_admin'
  | 'inventory_manager'
  | 'procurement_manager'
  | 'receiving_manager'
  | 'ecommerce_director'
  | 'salesperson'
  | 'executive';

// ─── Kanban Types ─────────────────────────────────────────────────────
export type LoopType = 'procurement' | 'production' | 'transfer';

export type CardStage =
  | 'created'
  | 'triggered'
  | 'ordered'
  | 'in_transit'
  | 'received'
  | 'restocked';

export type CardMode = 'single' | 'multi';

// ─── Order Types ──────────────────────────────────────────────────────
export type POStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'sent'
  | 'acknowledged'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'cancelled';

export type WOStatus =
  | 'draft'
  | 'scheduled'
  | 'in_progress'
  | 'on_hold'
  | 'completed'
  | 'cancelled';

export type TransferStatus =
  | 'draft'
  | 'requested'
  | 'approved'
  | 'picking'
  | 'shipped'
  | 'in_transit'
  | 'received'
  | 'closed'
  | 'cancelled';

// ─── Part Types ───────────────────────────────────────────────────────
export type PartType =
  | 'raw_material'
  | 'component'
  | 'subassembly'
  | 'finished_good'
  | 'consumable'
  | 'packaging'
  | 'other';

export type UnitOfMeasure =
  | 'each'
  | 'box'
  | 'case'
  | 'pallet'
  | 'kg'
  | 'lb'
  | 'meter'
  | 'foot'
  | 'liter'
  | 'gallon'
  | 'roll'
  | 'sheet'
  | 'pair'
  | 'set'
  | 'other';

// ─── Notification Types ──────────────────────────────────────────────
export type NotificationType =
  | 'card_triggered'
  | 'po_created'
  | 'po_sent'
  | 'po_received'
  | 'stockout_warning'
  | 'relowisa_recommendation'
  | 'exception_alert'
  | 'wo_status_change'
  | 'transfer_status_change'
  | 'system_alert'
  | 'receiving_completed'
  | 'production_hold'
  | 'automation_escalated';

export type DeliveryStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'bounced';

// ─── Audit Summary API ───────────────────────────────────────────────
export type AuditSummaryGranularity = 'day' | 'week';

export interface AuditSummaryQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  dateFrom?: string;
  dateTo?: string;
  granularity?: AuditSummaryGranularity;
}

export interface AuditSummaryCountByAction {
  action: string;
  count: number;
}

export interface AuditSummaryCountByEntityType {
  entityType: string;
  count: number;
}

export interface AuditSummaryCountByTimeBucket {
  bucket: string;
  count: number;
}

export interface AuditSummaryStatusTransition {
  status: string;
  count: number;
}

export interface AuditSummaryRecentAnomaly {
  action: string;
  currentCount: number;
  previousCount: number;
  delta: number;
  percentChange: number | null;
  severity: 'medium' | 'high';
}

export interface AuditSummaryData {
  total: number;
  byAction: AuditSummaryCountByAction[];
  byEntityType: AuditSummaryCountByEntityType[];
  byTimeBucket: AuditSummaryCountByTimeBucket[];
  topActions: AuditSummaryCountByAction[];
  statusTransitionFunnel: AuditSummaryStatusTransition[];
  recentAnomalies: AuditSummaryRecentAnomaly[];
}

export interface AuditSummaryFilters extends Required<Pick<AuditSummaryQuery, 'granularity'>> {
  action?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface AuditSummaryResponse {
  data: AuditSummaryData;
  filters: AuditSummaryFilters;
}

// ─── API Response Types ──────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  code?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

// ─── Card Print Format ───────────────────────────────────────────────
export type CardFormat =
  | 'order_card_3x5_portrait'
  | '3x5_card'
  | '4x6_card'
  | 'business_card'
  | 'business_label'
  | '1x3_label'
  | 'bin_label'
  | '1x1_label';

export const CARD_TEMPLATE_SCHEMA_VERSION = 1 as const;
export type CardTemplateSchemaVersion = typeof CARD_TEMPLATE_SCHEMA_VERSION;
export type CardTemplateStatus = 'active' | 'archived';
export type CardTemplateBindingToken =
  | 'title'
  | 'itemName'
  | 'sku'
  | 'partNumberText'
  | 'minimumText'
  | 'locationText'
  | 'orderText'
  | 'supplierText'
  | 'supplierNameText'
  | 'unitPriceText'
  | 'orderQuantityValue'
  | 'orderUnitsText'
  | 'minQuantityValue'
  | 'minUnitsText'
  | 'cardsCountText'
  | 'orderMethodText'
  | 'itemLocationText'
  | 'statusText'
  | 'updatedAtText'
  | 'glCodeText'
  | 'itemTypeText'
  | 'itemSubtypeText'
  | 'uomText'
  | 'facilityNameText'
  | 'sourceFacilityNameText'
  | 'storageLocationText'
  | 'scanUrlText'
  | 'notesText'
  | 'imageUrl'
  | 'qrCodeDataUrl';

export type CardTemplateIconName = 'minimum' | 'location' | 'order' | 'supplier';

export interface CardTemplateElementStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  textAlign?: 'left' | 'center' | 'right';
  lineHeight?: number;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  padding?: number;
  opacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
}

export interface CardTemplateBaseElement {
  id: string;
  key?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  rotation?: number;
  locked?: boolean;
  style?: CardTemplateElementStyle;
}

export interface CardTemplateBoundTextElement extends CardTemplateBaseElement {
  type: 'bound_text';
  token: CardTemplateBindingToken;
  fallbackText?: string;
}

export interface CardTemplateTextElement extends CardTemplateBaseElement {
  type: 'text';
  text: string;
}

export interface CardTemplateImageElement extends CardTemplateBaseElement {
  type: 'image';
  token?: Extract<CardTemplateBindingToken, 'imageUrl'>;
  src?: string;
  fit?: 'contain' | 'cover';
}

export interface CardTemplateQrElement extends CardTemplateBaseElement {
  type: 'qr';
}

export interface CardTemplateIconElement extends CardTemplateBaseElement {
  type: 'icon';
  iconName: CardTemplateIconName;
  iconUrl?: string;
}

export interface CardTemplateLineElement extends CardTemplateBaseElement {
  type: 'line';
  orientation: 'horizontal' | 'vertical';
}

export interface CardTemplateRectElement extends CardTemplateBaseElement {
  type: 'rect';
}

export interface CardTemplateNotesBoxElement extends CardTemplateBaseElement {
  type: 'notes_box';
  token?: Extract<CardTemplateBindingToken, 'notesText'>;
}

export interface CardTemplateFieldRowGroupElement extends CardTemplateBaseElement {
  type: 'field_row_group';
  iconName: CardTemplateIconName;
  iconUrl?: string;
  label: string;
  token: CardTemplateBindingToken;
}

export type CardTemplateElement =
  | CardTemplateBoundTextElement
  | CardTemplateTextElement
  | CardTemplateImageElement
  | CardTemplateQrElement
  | CardTemplateIconElement
  | CardTemplateLineElement
  | CardTemplateRectElement
  | CardTemplateNotesBoxElement
  | CardTemplateFieldRowGroupElement;

export interface CardTemplateDefinition {
  version: CardTemplateSchemaVersion;
  canvas: {
    width: number;
    height: number;
    background: string;
  };
  grid: {
    enabled: boolean;
    size: number;
    snapThreshold: number;
  };
  safeArea: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  requiredElementKeys: string[];
  elements: CardTemplateElement[];
}

export interface CardTemplateRecord {
  id: string;
  tenantId: string;
  name: string;
  format: CardFormat;
  isDefault: boolean;
  status: CardTemplateStatus;
  definition: CardTemplateDefinition;
  createdByUserId?: string | null;
  updatedByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Print Job Types ────────────────────────────────────────────────
export type PrintJobStatus = 'pending' | 'printing' | 'completed' | 'failed' | 'cancelled';

export interface PrintJobSummary {
  id: string;
  status: PrintJobStatus;
  format: CardFormat;
  printerClass: 'standard' | 'thermal';
  cardCount: number;
  isReprint: boolean;
  requestedByUserId?: string;
  createdAt: string;
  completedAt?: string;
}

// ─── Billing ──────────────────────────────────────────────────────────
export type PlanId = 'free' | 'starter' | 'pro' | 'enterprise';

export interface PlanFeatures {
  multiLocation: boolean;
  productionKanban: boolean;
  transferKanban: boolean;
  reloWisa: boolean;
  ecommerceApi: boolean;
  scheduledReports: boolean;
  sso: boolean;
  webhooks: boolean;
  customBranding: boolean;
  prioritySupport: boolean;
}

// ─── Production Types ────────────────────────────────────────────────
export type WOHoldReason =
  | 'material_shortage'
  | 'equipment_failure'
  | 'quality_hold'
  | 'labor_unavailable'
  | 'other';

export type RoutingStepStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'on_hold'
  | 'skipped';

export type ProductionOperationType =
  | 'start_step'
  | 'complete_step'
  | 'skip_step'
  | 'report_quantity'
  | 'hold'
  | 'resume'
  | 'expedite'
  | 'split'
  | 'rework';

export interface ProductionQueueItem {
  id: string;
  workOrderId: string;
  woNumber: string;
  partId: string;
  facilityId: string;
  status: string;
  priorityScore: number;
  manualPriority: number;
  isExpedited: boolean;
  totalSteps: number;
  completedSteps: number;
  enteredQueueAt: string;
  startedAt: string | null;
}

export interface RoutingTemplateInput {
  name: string;
  description?: string;
  partId?: string;
  steps: RoutingTemplateStepInput[];
}

export interface RoutingTemplateStepInput {
  workCenterId: string;
  stepNumber: number;
  operationName: string;
  estimatedMinutes?: number;
  instructions?: string;
}

// ─── WO Status Transitions ──────────────────────────────────────────
export const WO_VALID_TRANSITIONS: Record<WOStatus, WOStatus[]> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

// ─── Routing Step Transitions ───────────────────────────────────────
export const ROUTING_STEP_VALID_TRANSITIONS: Record<RoutingStepStatus, RoutingStepStatus[]> = {
  pending: ['in_progress', 'skipped'],
  in_progress: ['complete', 'on_hold', 'skipped'],
  complete: [],
  on_hold: ['in_progress'],
  skipped: [],
};

// ─── WebSocket Events ────────────────────────────────────────────────
export type WSEventType =
  | 'card:stage_changed'
  | 'card:triggered'
  | 'po:status_changed'
  | 'wo:status_changed'
  | 'transfer:status_changed'
  | 'inventory:updated'
  | 'notification:new'
  | 'relowisa:recommendation'
  | 'wo:step_completed'
  | 'wo:quantity_reported'
  | 'wo:expedited'
  | 'wo:held'
  | 'wo:resumed';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  tenantId: string;
  payload: T;
  timestamp: string;
}

// ─── Transfer Lifecycle ──────────────────────────────────────────────
export const TRANSFER_VALID_TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  draft: ['requested', 'cancelled'],
  requested: ['approved', 'cancelled'],
  approved: ['picking', 'cancelled'],
  picking: ['shipped', 'cancelled'],
  shipped: ['in_transit', 'cancelled'],
  in_transit: ['received', 'cancelled'],
  received: ['closed'],
  closed: [],
  cancelled: [],
};

export interface TransferLifecycleEvent {
  transferOrderId: string;
  fromStatus: TransferStatus;
  toStatus: TransferStatus;
  userId: string;
  reason?: string;
  timestamp: string;
}

// ─── Inventory Ledger Types ─────────────────────────────────────────
export type InventoryAdjustmentType = 'set' | 'increment' | 'decrement';

export type InventoryField = 'qtyOnHand' | 'qtyReserved' | 'qtyInTransit';

export interface InventoryLedgerEntry {
  id: string;
  tenantId: string;
  facilityId: string;
  partId: string;
  qtyOnHand: number;
  qtyReserved: number;
  qtyInTransit: number;
  reorderPoint: number;
  reorderQty: number;
  lastCountedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryAdjustment {
  facilityId: string;
  partId: string;
  field: InventoryField;
  adjustmentType: InventoryAdjustmentType;
  quantity: number;
  source?: string;
}

// ─── Lead Time Types ────────────────────────────────────────────────
export interface LeadTimeRecord {
  id: string;
  tenantId: string;
  sourceFacilityId: string;
  destinationFacilityId: string;
  partId: string;
  transferOrderId: string | null;
  shippedAt: string;
  receivedAt: string;
  leadTimeDays: number;
  createdAt: string;
}

// ─── Source Recommendation ──────────────────────────────────────────
export interface SourceRecommendation {
  facilityId: string;
  facilityName: string;
  facilityCode: string;
  availableQty: number;
  avgLeadTimeDays: number | null;
  distanceKm: number | null;
  score: number;
}

// ─── Transfer Queue Types ───────────────────────────────────────────
export interface TransferQueueItem {
  id: string;
  transferOrderId: string;
  toNumber: string;
  sourceFacilityId: string;
  sourceFacilityName: string;
  destinationFacilityId: string;
  destinationFacilityName: string;
  status: TransferStatus;
  priorityScore: number;
  requestedDate: string | null;
  shippedDate: string | null;
  receivedDate: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  createdAt: string;
  lineCount?: number;
  totalQuantity?: number;
}

export interface TransferQueueFilters {
  status?: TransferStatus;
  sourceFacilityId?: string;
  destinationFacilityId?: string;
  minPriorityScore?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface TransferQueueResponse {
  data: TransferQueueItem[];
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

// ─── Lead Time Analytics Types ──────────────────────────────────────
export interface LeadTimeAnalytics {
  sourceFacilityId: string;
  destinationFacilityId: string;
  partId?: string;
  avgLeadTimeDays: number;
  minLeadTimeDays: number;
  maxLeadTimeDays: number;
  medianLeadTimeDays: number;
  sampleSize: number;
  lastUpdated: string;
}

export interface LeadTimeAnalyticsQuery {
  sourceFacilityId?: string;
  destinationFacilityId?: string;
  partId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface LeadTimeAnalyticsResponse {
  data: LeadTimeAnalytics[];
  summary?: {
    totalRoutes: number;
    avgLeadTimeDays: number;
    totalTransfers: number;
  };
}

// ─── Cross-Location Inventory Types ─────────────────────────────────
export interface CrossLocationInventoryItem {
  partId: string;
  partNumber: string;
  partDescription: string;
  locations: {
    facilityId: string;
    facilityName: string;
    qtyOnHand: number;
    qtyReserved: number;
    qtyInTransit: number;
    qtyAvailable: number;
    reorderPoint: number;
    reorderQty: number;
    lastCountedAt: string | null;
  }[];
  totalOnHand: number;
  totalReserved: number;
  totalInTransit: number;
  totalAvailable: number;
}

export interface CrossLocationInventoryQuery {
  partId?: string;
  facilityIds?: string[];
  includeZeroQty?: boolean;
  sortBy?: 'partNumber' | 'totalOnHand' | 'totalAvailable';
  sortOrder?: 'asc' | 'desc';
}

export interface CrossLocationInventoryResponse {
  data: CrossLocationInventoryItem[];
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

// ─── Scan Dedupe / Conflict / Replay Types ─────────────────────────
export interface ScanDedupeResult {
  allowed: boolean;
  existingStatus?: 'pending' | 'completed' | 'failed' | 'unknown';
  cachedResult?: unknown;
  wasReplay: boolean;
}

export type ScanConflictResolution =
  | 'already_triggered'
  | 'stage_advanced'
  | 'card_inactive'
  | 'ok';

export interface ScanReplayItem {
  cardId: string;
  idempotencyKey: string;
  scannedAt: string;
  location?: { lat?: number; lng?: number };
}

export interface ScanReplayResult {
  cardId: string;
  idempotencyKey: string;
  success: boolean;
  error?: string;
  errorCode?: string;
  card?: unknown;
  loopType?: string;
  partId?: string;
  message?: string;
  wasReplay: boolean;
}

export interface BatchReplayResponse {
  total: number;
  succeeded: number;
  failed: number;
  results: ScanReplayResult[];
}

// ─── Lead Time Aggregate Stats (for MVP-10/T3) ─────────────────────
export interface LeadTimeAggregateStats {
  avgLeadTimeDays: number;
  medianLeadTimeDays: number;
  p90LeadTimeDays: number;
  minLeadTimeDays: number;
  maxLeadTimeDays: number;
  transferCount: number;
}

export interface LeadTimeTrendDataPoint {
  date: string; // ISO date (YYYY-MM-DD)
  avgLeadTimeDays: number;
  transferCount: number;
}

export interface LeadTimeTrendData {
  data: LeadTimeTrendDataPoint[];
  summary: {
    overallAvg: number;
    totalTransfers: number;
    dateRange: { from: string; to: string };
  };
}

export interface LeadTimeFilters {
  sourceFacilityId?: string;
  destinationFacilityId?: string;
  partId?: string;
  dateFrom?: string; // ISO date string
  dateTo?: string; // ISO date string
}
