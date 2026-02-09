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

// ─── WebSocket Events ────────────────────────────────────────────────
export type WSEventType =
  | 'card:stage_changed'
  | 'card:triggered'
  | 'po:status_changed'
  | 'wo:status_changed'
  | 'transfer:status_changed'
  | 'inventory:updated'
  | 'notification:new'
  | 'relowisa:recommendation';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  tenantId: string;
  payload: T;
  timestamp: string;
}
