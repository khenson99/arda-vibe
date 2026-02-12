// ─── Print Data Validation ───────────────────────────────────────────
// Validates KanbanPrintData against format-specific requirements before rendering.

import type { CardFormat } from '@arda/shared-types';
import type { KanbanPrintData, ValidationResult } from './types';
import { FORMAT_CONFIGS } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_URL_RE = /^data:/;
const VALID_LOOP_TYPES = ['procurement', 'production', 'transfer'] as const;
const VALID_STAGES = ['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked'] as const;

export function validatePrintData(
  data: KanbanPrintData,
  format: CardFormat,
): ValidationResult {
  const errors: string[] = [];
  const config = FORMAT_CONFIGS[format];

  // ── Universal validations ──
  if (!data.cardId || !UUID_RE.test(data.cardId)) {
    errors.push('cardId must be a valid UUID');
  }

  if (!data.partNumber || data.partNumber.trim().length === 0) {
    errors.push('partNumber is required');
  }

  if (!data.sku || data.sku.trim().length === 0) {
    errors.push('sku is required');
  }

  if (!Number.isInteger(data.cardNumber) || data.cardNumber < 1) {
    errors.push('cardNumber must be a positive integer');
  }

  if (data.cardNumber > data.totalCards) {
    errors.push('cardNumber cannot exceed totalCards');
  }

  if (!data.qrCodeDataUrl || !DATA_URL_RE.test(data.qrCodeDataUrl)) {
    errors.push('qrCodeDataUrl must be a valid data URL');
  }

  if (data.orderQuantity < 0) {
    errors.push('orderQuantity must be a non-negative number');
  }

  if (!(VALID_LOOP_TYPES as readonly string[]).includes(data.loopType)) {
    errors.push(`loopType must be one of: ${VALID_LOOP_TYPES.join(', ')}`);
  }

  if (!(VALID_STAGES as readonly string[]).includes(data.currentStage)) {
    errors.push(`currentStage must be one of: ${VALID_STAGES.join(', ')}`);
  }

  // ── Card format validations (standard printers) ──
  if (config.printerClass === 'standard') {
    if (!data.partDescription || data.partDescription.trim().length === 0) {
      errors.push('partDescription is required for card formats');
    }
    if (!data.facilityName || data.facilityName.trim().length === 0) {
      errors.push('facilityName is required for card formats');
    }
    if (!data.tenantName || data.tenantName.trim().length === 0) {
      errors.push('tenantName is required for card formats');
    }
  }

  if (format === 'order_card_3x5_portrait') {
    if (!data.minimumText?.trim()) errors.push('minimumText is required for order_card_3x5_portrait');
    if (!data.locationText?.trim()) errors.push('locationText is required for order_card_3x5_portrait');
    if (!data.orderText?.trim()) errors.push('orderText is required for order_card_3x5_portrait');
    if (!data.supplierText?.trim()) errors.push('supplierText is required for order_card_3x5_portrait');
  }

  // ── Label format validations (thermal printers) ──
  if (config.printerClass === 'thermal' && config.showDescription) {
    if (!data.partDescription || data.partDescription.trim().length === 0) {
      errors.push('partDescription is required for this label format');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
