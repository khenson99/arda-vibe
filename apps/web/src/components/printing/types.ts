// ─── Printing Types & Configuration ──────────────────────────────────
// Matches the layout specification in docs/spec/printing/layout-specs.md.

import type { CardFormat } from '@arda/shared-types';

// ─── Kanban Print Data ──────────────────────────────────────────────
// All data needed to render a single kanban card/label for printing.
export interface KanbanPrintData {
  cardId: string;
  cardNumber: number;
  totalCards: number;
  partNumber: string;
  partDescription: string;
  sku: string;
  loopType: 'procurement' | 'production' | 'transfer';
  currentStage: 'created' | 'triggered' | 'ordered' | 'in_transit' | 'received' | 'restocked';
  facilityName: string;
  storageLocation?: string;
  supplierName?: string;
  sourceFacilityName?: string;
  orderQuantity: number;
  minQuantity: number;
  statedLeadTimeDays?: number;
  safetyStockDays?: number;
  qrCodeDataUrl: string;
  scanUrl: string;
  tenantName: string;
  tenantLogoUrl?: string;
  notes?: string;
  notesText?: string;
  imageUrl?: string;
  minimumText: string;
  locationText: string;
  orderText: string;
  supplierText: string;
  unitPriceText?: string;
  orderQuantityValue?: string;
  orderUnitsText?: string;
  minQuantityValue?: string;
  minUnitsText?: string;
  cardsCountText?: string;
  orderMethodText?: string;
  itemLocationText?: string;
  statusText?: string;
  updatedAtText?: string;
  glCodeText?: string;
  itemTypeText?: string;
  itemSubtypeText?: string;
  uomText?: string;
  accentColor?: string;
  lastPrintedAt?: string;
  showArdaWatermark: boolean;
}

// ─── Print Template Props ────────────────────────────────────────────
export interface PrintTemplateProps {
  data: KanbanPrintData;
  format: CardFormat;
  config: FormatConfig;
}

// ─── Format Configuration ────────────────────────────────────────────
export interface FormatConfig {
  widthIn: number;
  heightIn: number;
  widthPx: number;
  heightPx: number;
  qrSizePx: number;
  safeInsetPx: number;
  printerClass: 'standard' | 'thermal';
  layoutVariant: 'legacy' | 'order_card_3x5_portrait';
  showLogo: boolean;
  showDescription: boolean;
  showExtendedFields: boolean;
  showNotes: boolean;
  showScanUrl: boolean;
}

// ─── Validation Result ───────────────────────────────────────────────
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Format Configs (Source of Truth) ───────────────────────────────
export const FORMAT_CONFIGS: Record<CardFormat, FormatConfig> = {
  order_card_3x5_portrait: {
    widthIn: 3,
    heightIn: 5,
    widthPx: 288,
    heightPx: 480,
    qrSizePx: 62,
    safeInsetPx: 13,
    printerClass: 'standard',
    layoutVariant: 'order_card_3x5_portrait',
    showLogo: false,
    showDescription: true,
    showExtendedFields: false,
    showNotes: true,
    showScanUrl: false,
  },
  '3x5_card': {
    widthIn: 5,
    heightIn: 3,
    widthPx: 480,
    heightPx: 288,
    qrSizePx: 96,
    safeInsetPx: 12,
    printerClass: 'standard',
    layoutVariant: 'legacy',
    showLogo: true,
    showDescription: true,
    showExtendedFields: false,
    showNotes: false,
    showScanUrl: true,
  },
  '4x6_card': {
    widthIn: 6,
    heightIn: 4,
    widthPx: 576,
    heightPx: 384,
    qrSizePx: 120,
    safeInsetPx: 12,
    printerClass: 'standard',
    layoutVariant: 'legacy',
    showLogo: true,
    showDescription: true,
    showExtendedFields: true,
    showNotes: true,
    showScanUrl: true,
  },
  business_card: {
    widthIn: 3.5,
    heightIn: 2,
    widthPx: 336,
    heightPx: 192,
    qrSizePx: 64,
    safeInsetPx: 12,
    printerClass: 'standard',
    layoutVariant: 'legacy',
    showLogo: true,
    showDescription: true,
    showExtendedFields: false,
    showNotes: false,
    showScanUrl: false,
  },
  business_label: {
    widthIn: 3.5,
    heightIn: 1.125,
    widthPx: 336,
    heightPx: 108,
    qrSizePx: 48,
    safeInsetPx: 6,
    printerClass: 'thermal',
    layoutVariant: 'legacy',
    showLogo: false,
    showDescription: true,
    showExtendedFields: false,
    showNotes: false,
    showScanUrl: false,
  },
  '1x3_label': {
    widthIn: 3,
    heightIn: 1,
    widthPx: 288,
    heightPx: 96,
    qrSizePx: 48,
    safeInsetPx: 6,
    printerClass: 'thermal',
    layoutVariant: 'legacy',
    showLogo: false,
    showDescription: true,
    showExtendedFields: false,
    showNotes: false,
    showScanUrl: false,
  },
  bin_label: {
    widthIn: 2,
    heightIn: 1,
    widthPx: 192,
    heightPx: 96,
    qrSizePx: 48,
    safeInsetPx: 6,
    printerClass: 'thermal',
    layoutVariant: 'legacy',
    showLogo: false,
    showDescription: false,
    showExtendedFields: false,
    showNotes: false,
    showScanUrl: false,
  },
  '1x1_label': {
    widthIn: 1,
    heightIn: 1,
    widthPx: 96,
    heightPx: 96,
    qrSizePx: 80,
    safeInsetPx: 6,
    printerClass: 'thermal',
    layoutVariant: 'legacy',
    showLogo: false,
    showDescription: false,
    showExtendedFields: false,
    showNotes: false,
    showScanUrl: false,
  },
};

// ─── Stage Labels ───────────────────────────────────────────────────
export const STAGE_LABELS: Record<KanbanPrintData['currentStage'], string> = {
  created: 'Created',
  triggered: 'Triggered',
  ordered: 'Ordered',
  in_transit: 'In Transit',
  received: 'Received',
  restocked: 'Restocked',
};

// ─── Loop Type Labels ───────────────────────────────────────────────
export const LOOP_TYPE_LABELS: Record<KanbanPrintData['loopType'], string> = {
  procurement: 'Procurement',
  production: 'Production',
  transfer: 'Transfer',
};
