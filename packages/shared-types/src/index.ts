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

export type NotificationChannel = 'in_app' | 'email' | 'webhook';
export type NotificationApiChannel = 'inApp' | 'email' | 'webhook';

/** Maps API channel names to database column values. */
export const API_TO_DB_CHANNEL: Record<NotificationApiChannel, NotificationChannel> = {
  inApp: 'in_app',
  email: 'email',
  webhook: 'webhook',
} as const;

/** Maps database channel values to API channel names. */
export const DB_TO_API_CHANNEL: Record<NotificationChannel, NotificationApiChannel> = {
  in_app: 'inApp',
  email: 'email',
  webhook: 'webhook',
} as const;

/**
 * Canonical system-level default notification preferences.
 * Single source of truth — imported by both the notifications and auth services.
 */
export const NOTIFICATION_DEFAULT_PREFERENCES: Record<NotificationType, Record<NotificationApiChannel, boolean>> = {
  card_triggered: { inApp: true, email: false, webhook: false },
  po_created: { inApp: true, email: true, webhook: false },
  po_sent: { inApp: true, email: false, webhook: false },
  po_received: { inApp: true, email: true, webhook: false },
  stockout_warning: { inApp: true, email: true, webhook: false },
  relowisa_recommendation: { inApp: true, email: false, webhook: false },
  exception_alert: { inApp: true, email: true, webhook: true },
  wo_status_change: { inApp: true, email: false, webhook: false },
  transfer_status_change: { inApp: true, email: false, webhook: false },
  system_alert: { inApp: true, email: true, webhook: false },
  receiving_completed: { inApp: true, email: true, webhook: false },
  production_hold: { inApp: true, email: true, webhook: false },
  automation_escalated: { inApp: true, email: true, webhook: true },
};

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

export const PLAN_IDS = ['free', 'starter', 'pro', 'enterprise'] as const;

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;

export type BillingInterval = 'monthly' | 'annual';

export const BILLING_INTERVALS = ['monthly', 'annual'] as const;

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;

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

/** Represents -1 as unlimited for plan limits (Enterprise tier). */
export const UNLIMITED = -1 as const;

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
export type RealtimeProtocolVersion = '1' | '2';

export const WS_EVENT_TYPES = [
  // Control events
  'connected',
  'pong',
  'error',
  'replay_complete',
  'resync_required',
  'backpressure_warning',
  'event_batch',
  // Core lifecycle + order events
  'card:stage_changed',
  'card:triggered',
  'po:status_changed',
  'wo:status_changed',
  'transfer:status_changed',
  // Production events
  'wo:step_completed',
  'wo:quantity_reported',
  'wo:expedited',
  'wo:held',
  'wo:resumed',
  // Receiving events
  'receiving:completed',
  'receiving:exception_created',
  'receiving:exception_resolved',
  // Automation events
  'automation:po_created',
  'automation:to_created',
  'automation:email_dispatched',
  'automation:shopping_list_item_added',
  'automation:card_stage_changed',
  'automation:escalated',
  // Realtime surfaces
  'notification:new',
  'relowisa:recommendation',
  'kpi:refreshed',
  'audit:created',
  'user:activity',
  'inventory:updated',
] as const;

export type WSEventType = (typeof WS_EVENT_TYPES)[number];

export interface WSEvent<T = unknown> {
  type: WSEventType;
  tenantId: string;
  payload: T;
  timestamp: string;
}

export interface RealtimeHandshakeAuth {
  token: string;
  protocolVersion?: RealtimeProtocolVersion;
  lastEventId?: string;
}

export interface RealtimeConnectedPayload {
  tenantId: string;
  userId: string;
  timestamp: string;
  protocolVersion?: RealtimeProtocolVersion;
  lastEventId?: string;
}

export interface RealtimePingPayload {
  timestamp?: string;
}

export interface RealtimePongPayload {
  timestamp: string;
}

export interface RealtimeErrorPayload {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface RealtimeReplayCompletePayload {
  replayedCount: number;
  lastEventId: string;
  protocolVersion?: RealtimeProtocolVersion;
}

export interface RealtimeResyncRequiredPayload {
  reason: 'stale_last_event_id' | 'replay_failed';
  lastEventId?: string;
  replayTtlMs?: number;
  protocolVersion?: RealtimeProtocolVersion;
}

export interface RealtimeBackpressureWarningPayload {
  tenantId: string;
  droppedCount: number;
  maxBufferSize: number;
  timestamp: string;
}

export interface RealtimeEventBatchPayload<T = unknown> {
  tenantId: string;
  events: WSEvent<T>[];
  count: number;
  timestamp: string;
}

export interface RealtimeSubscribeLoopPayload {
  loopId: string;
  protocolVersion?: RealtimeProtocolVersion;
  lastEventId?: string;
}

export interface RealtimeUnsubscribeLoopPayload {
  loopId: string;
}

export type RealtimeControlEventType =
  | 'connected'
  | 'pong'
  | 'error'
  | 'replay_complete'
  | 'resync_required'
  | 'backpressure_warning';

export interface RealtimeControlEvent {
  type: RealtimeControlEventType;
  payload:
    | RealtimeConnectedPayload
    | RealtimePongPayload
    | RealtimeErrorPayload
    | RealtimeReplayCompletePayload
    | RealtimeResyncRequiredPayload
    | RealtimeBackpressureWarningPayload;
}

// Compile-time coverage: ensures every WSEventType has a mapped key.
export const WS_EVENT_TYPE_COVERAGE: Record<WSEventType, true> = {
  connected: true,
  pong: true,
  error: true,
  replay_complete: true,
  resync_required: true,
  backpressure_warning: true,
  event_batch: true,
  'card:stage_changed': true,
  'card:triggered': true,
  'po:status_changed': true,
  'wo:status_changed': true,
  'transfer:status_changed': true,
  'wo:step_completed': true,
  'wo:quantity_reported': true,
  'wo:expedited': true,
  'wo:held': true,
  'wo:resumed': true,
  'receiving:completed': true,
  'receiving:exception_created': true,
  'receiving:exception_resolved': true,
  'automation:po_created': true,
  'automation:to_created': true,
  'automation:email_dispatched': true,
  'automation:shopping_list_item_added': true,
  'automation:card_stage_changed': true,
  'automation:escalated': true,
  'notification:new': true,
  'relowisa:recommendation': true,
  'kpi:refreshed': true,
  'audit:created': true,
  'user:activity': true,
  'inventory:updated': true,
};

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

export type TransferQueueStatus = 'draft' | 'requested' | 'triggered' | 'below_reorder';

export interface TransferQueueItem {
  id: string;
  type: 'draft_to' | 'kanban_trigger' | 'below_reorder';

  transferOrderId?: string;
  toNumber?: string;
  kanbanCardId?: string;
  partId: string;
  partNumber?: string;
  partName?: string;
  /** Number of distinct parts/lines on this queue item (> 1 for multi-line TOs). */
  lineCount?: number;

  sourceFacilityId?: string;
  sourceFacilityName?: string;
  destinationFacilityId: string;
  destinationFacilityName: string;

  quantityRequested: number;
  availableQty?: number;

  priorityScore: number;
  daysBelowReorder?: number;
  isExpedited: boolean;

  status: string;
  createdAt: string;
  requestedDate?: string;

  recommendedSources: SourceRecommendation[];
}

export interface TransferQueueFilters {
  destinationFacilityId?: string;
  sourceFacilityId?: string;
  status?: TransferQueueStatus;
  partId?: string;
  minPriorityScore?: number;
  maxPriorityScore?: number;
}

export interface TransferQueueResponse {
  data: TransferQueueItem[];
  pagination: {
    page: number;
    limit: number;
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

// ─── Import Pipeline Types (MVP-21) ────────────────────────────────

export type ImportJobStatus =
  | 'pending'
  | 'parsing'
  | 'matching'
  | 'review'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ImportSourceType =
  | 'csv'
  | 'xlsx'
  | 'google_sheets'
  | 'manual_entry';

export type ImportItemDisposition =
  | 'new'
  | 'duplicate'
  | 'update'
  | 'skip'
  | 'error';

export type AiOperationType =
  | 'field_mapping'
  | 'deduplication'
  | 'categorization'
  | 'enrichment'
  | 'validation';

export type AiProviderLogStatus =
  | 'pending'
  | 'success'
  | 'error'
  | 'timeout';

// ─── Import Job State Transitions ───────────────────────────────────
export const IMPORT_JOB_VALID_TRANSITIONS: Record<ImportJobStatus, ImportJobStatus[]> = {
  pending: ['parsing', 'cancelled'],
  parsing: ['matching', 'failed'],
  matching: ['review', 'failed'],
  review: ['applying', 'cancelled'],
  applying: ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

// ─── Import Pipeline Interfaces ─────────────────────────────────────
export interface ImportJobSummary {
  id: string;
  tenantId: string;
  status: ImportJobStatus;
  sourceType: ImportSourceType;
  fileName: string;
  totalRows: number;
  processedRows: number;
  newItems: number;
  duplicateItems: number;
  updatedItems: number;
  skippedItems: number;
  errorItems: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ImportMatchResult {
  importItemId: string;
  existingPartId: string | null;
  matchScore: number;
  matchMethod: string;
  disposition: ImportItemDisposition;
}

// ─── Customer Types (MVP-13) ────────────────────────────────────────

export type CustomerStatus = 'active' | 'inactive' | 'prospect' | 'suspended';

export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  code: string | null;
  status: CustomerStatus;
  email: string | null;
  phone: string | null;
  website: string | null;
  paymentTerms: string | null;
  creditLimit: number | null;
  taxId: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerContact {
  id: string;
  tenantId: string;
  customerId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  isPrimary: boolean;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerAddress {
  id: string;
  tenantId: string;
  customerId: string;
  label: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string | null;
  postalCode: string | null;
  country: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomerInput {
  name: string;
  code?: string;
  status?: CustomerStatus;
  email?: string;
  phone?: string;
  website?: string;
  paymentTerms?: string;
  creditLimit?: number;
  taxId?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateCustomerInput {
  name?: string;
  code?: string;
  status?: CustomerStatus;
  email?: string;
  phone?: string;
  website?: string;
  paymentTerms?: string;
  creditLimit?: number;
  taxId?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateCustomerContactInput {
  customerId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  title?: string;
  isPrimary?: boolean;
}

export interface CreateCustomerAddressInput {
  customerId: string;
  label?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country?: string;
  isDefault?: boolean;
}

// ─── Sales Order Types (MVP-13) ─────────────────────────────────────

export type SOStatus =
  | 'draft'
  | 'confirmed'
  | 'processing'
  | 'partially_shipped'
  | 'shipped'
  | 'delivered'
  | 'invoiced'
  | 'closed'
  | 'cancelled';

export const SO_VALID_TRANSITIONS: Record<SOStatus, SOStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['partially_shipped', 'shipped', 'cancelled'],
  partially_shipped: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['invoiced', 'closed'],
  invoiced: ['closed'],
  closed: [],
  cancelled: [],
};

export interface SalesOrder {
  id: string;
  tenantId: string;
  soNumber: string;
  customerId: string;
  facilityId: string;
  status: SOStatus;
  orderDate: string | null;
  requestedShipDate: string | null;
  promisedShipDate: string | null;
  actualShipDate: string | null;
  shippingAddressId: string | null;
  billingAddressId: string | null;
  subtotal: number;
  taxAmount: number;
  shippingAmount: number;
  discountAmount: number;
  totalAmount: number;
  currency: string;
  paymentTerms: string | null;
  shippingMethod: string | null;
  trackingNumber: string | null;
  notes: string | null;
  internalNotes: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesOrderLine {
  id: string;
  tenantId: string;
  salesOrderId: string;
  partId: string;
  lineNumber: number;
  quantityOrdered: number;
  quantityAllocated: number;
  quantityShipped: number;
  unitPrice: number;
  discountPercent: number;
  lineTotal: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSalesOrderInput {
  customerId: string;
  facilityId: string;
  orderDate?: string;
  requestedShipDate?: string;
  shippingAddressId?: string;
  billingAddressId?: string;
  paymentTerms?: string;
  shippingMethod?: string;
  notes?: string;
  internalNotes?: string;
  lines: CreateSalesOrderLineInput[];
}

export interface CreateSalesOrderLineInput {
  partId: string;
  quantityOrdered: number;
  unitPrice: number;
  discountPercent?: number;
  notes?: string;
}

export interface UpdateSalesOrderInput {
  status?: SOStatus;
  requestedShipDate?: string;
  promisedShipDate?: string;
  shippingAddressId?: string;
  billingAddressId?: string;
  paymentTerms?: string;
  shippingMethod?: string;
  trackingNumber?: string;
  notes?: string;
  internalNotes?: string;
  cancelReason?: string;
}

// ─── Product Visibility Types (MVP-13) ──────────────────────────────

export type VisibilityState = 'visible' | 'hidden' | 'coming_soon' | 'discontinued';

export interface ProductVisibility {
  id: string;
  tenantId: string;
  partId: string;
  visibilityState: VisibilityState;
  displayName: string | null;
  shortDescription: string | null;
  longDescription: string | null;
  displayPrice: number | null;
  displayOrder: number;
  publishedAt: string | null;
  unpublishedAt: string | null;
  metadata: Record<string, unknown> | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProductVisibilityInput {
  visibilityState?: VisibilityState;
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  displayPrice?: number;
  displayOrder?: number;
  metadata?: Record<string, unknown>;
}

export interface ProductVisibilityFilters {
  visibilityState?: VisibilityState;
  partId?: string;
  sortBy?: 'displayOrder' | 'displayName' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

// ─── Demand Signal Types (MVP-13) ───────────────────────────────────

export type DemandSignalType =
  | 'sales_order'
  | 'forecast'
  | 'reorder_point'
  | 'safety_stock'
  | 'seasonal'
  | 'manual';

export interface DemandSignal {
  id: string;
  tenantId: string;
  partId: string;
  facilityId: string;
  signalType: DemandSignalType;
  quantityDemanded: number;
  quantityFulfilled: number;
  salesOrderId: string | null;
  salesOrderLineId: string | null;
  demandDate: string;
  fulfilledAt: string | null;
  triggeredKanbanCardId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDemandSignalInput {
  partId: string;
  facilityId: string;
  signalType: DemandSignalType;
  quantityDemanded: number;
  demandDate: string;
  salesOrderId?: string;
  salesOrderLineId?: string;
  metadata?: Record<string, unknown>;
}

export interface DemandSignalFilters {
  partId?: string;
  facilityId?: string;
  signalType?: DemandSignalType;
  dateFrom?: string;
  dateTo?: string;
  unfulfilled?: boolean;
}
