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
  | 'system_alert';

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
  | '3x5_card'
  | '4x6_card'
  | 'business_card'
  | 'business_label'
  | '1x3_label'
  | 'bin_label'
  | '1x1_label';

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
