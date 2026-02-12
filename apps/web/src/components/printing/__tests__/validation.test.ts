import { describe, it, expect } from 'vitest';
import { validatePrintData } from '../validation';
import type { KanbanPrintData } from '../types';
import {
  PROCUREMENT_CARD_FIXTURE,
  PRODUCTION_CARD_FIXTURE,
  TRANSFER_CARD_FIXTURE,
  MINIMAL_CARD_FIXTURE,
} from './fixtures';
import type { CardFormat } from '@arda/shared-types';

// ─── Validation Tests ─────────────────────────────────────────────────
// Ensures the validation layer correctly enforces required fields per format.

describe('validatePrintData', () => {
  describe('valid data', () => {
    const formats: CardFormat[] = [
      'order_card_3x5_portrait',
      '3x5_card', '4x6_card', 'business_card',
      'business_label', '1x3_label', 'bin_label', '1x1_label',
    ];

    it.each(formats)('accepts PROCUREMENT_CARD_FIXTURE for format %s', (format) => {
      const result = validatePrintData(PROCUREMENT_CARD_FIXTURE, format);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts PRODUCTION_CARD_FIXTURE for 3x5_card', () => {
      const result = validatePrintData(PRODUCTION_CARD_FIXTURE, '3x5_card');
      expect(result.valid).toBe(true);
    });

    it('accepts TRANSFER_CARD_FIXTURE for business_label', () => {
      const result = validatePrintData(TRANSFER_CARD_FIXTURE, 'business_label');
      expect(result.valid).toBe(true);
    });

    it('accepts MINIMAL_CARD_FIXTURE for 3x5_card', () => {
      const result = validatePrintData(MINIMAL_CARD_FIXTURE, '3x5_card');
      expect(result.valid).toBe(true);
    });

    it('accepts MINIMAL_CARD_FIXTURE for 1x1_label (QR-only)', () => {
      const result = validatePrintData(MINIMAL_CARD_FIXTURE, '1x1_label');
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid cardId', () => {
    it('rejects missing cardId', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, cardId: '' };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('cardId must be a valid UUID');
    });

    it('rejects malformed UUID', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, cardId: 'not-a-uuid' };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('cardId must be a valid UUID');
    });
  });

  describe('invalid card numbers', () => {
    it('rejects cardNumber < 1', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, cardNumber: 0 };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('cardNumber must be a positive integer');
    });

    it('rejects cardNumber > totalCards', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, cardNumber: 5, totalCards: 3 };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('cardNumber cannot exceed totalCards');
    });
  });

  describe('required fields for card formats', () => {
    it('rejects missing partDescription for 3x5_card', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, partDescription: '' };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('partDescription is required for card formats');
    });

    it('rejects missing facilityName for 4x6_card', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, facilityName: '' };
      const result = validatePrintData(data, '4x6_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('facilityName is required for card formats');
    });

    it('rejects missing tenantName for business_card', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, tenantName: '' };
      const result = validatePrintData(data, 'business_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('tenantName is required for card formats');
    });

    it('rejects negative orderQuantity', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, orderQuantity: -1 };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('orderQuantity must be a non-negative number');
    });
  });

  describe('QR code validation', () => {
    it('rejects missing qrCodeDataUrl', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, qrCodeDataUrl: '' };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('qrCodeDataUrl must be a valid data URL');
    });

    it('rejects non-data-URL qrCodeDataUrl', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, qrCodeDataUrl: 'https://example.com/qr.png' };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('qrCodeDataUrl must be a valid data URL');
    });
  });

  describe('loop type and stage validation', () => {
    it('rejects invalid loopType', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, loopType: 'invalid' as KanbanPrintData['loopType'] };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('loopType'))).toBe(true);
    });

    it('rejects invalid currentStage', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, currentStage: 'invalid' as KanbanPrintData['currentStage'] };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('currentStage'))).toBe(true);
    });
  });

  describe('label-specific validation', () => {
    it('rejects missing partDescription for business_label (showDescription=true)', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, partDescription: '' };
      const result = validatePrintData(data, 'business_label');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('partDescription is required for this label format');
    });

    it('allows missing partDescription for bin_label (showDescription=false)', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, partDescription: '' };
      const result = validatePrintData(data, 'bin_label');
      // bin_label does not require description, but QR and partNumber still needed
      // The card-format-specific validation won't fire since bin_label is thermal
      expect(result.valid).toBe(true);
    });

    it('allows missing partDescription for 1x1_label', () => {
      const data = { ...PROCUREMENT_CARD_FIXTURE, partDescription: '' };
      const result = validatePrintData(data, '1x1_label');
      expect(result.valid).toBe(true);
    });
  });

  describe('multiple errors', () => {
    it('collects all errors, not just the first one', () => {
      const data = {
        ...PROCUREMENT_CARD_FIXTURE,
        cardId: 'bad',
        partNumber: '',
        qrCodeDataUrl: 'bad',
        loopType: 'invalid' as KanbanPrintData['loopType'],
      };
      const result = validatePrintData(data, '3x5_card');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});
