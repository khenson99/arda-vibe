import { describe, expect, it } from 'vitest';
import {
  getNotificationTier,
  IMMEDIATE_TIER_TYPES,
  DIGEST_TIER_TYPES,
} from './tier-classification.js';

describe('tier-classification', () => {
  // ─── Immediate Tier ──────────────────────────────────────────────────

  describe('immediate tier types', () => {
    const immediateCases: Array<[string]> = [
      ['exception_alert'],
      ['stockout_warning'],
      ['production_hold'],
      ['automation_escalated'],
    ];

    it.each(immediateCases)('%s → immediate', (type) => {
      expect(getNotificationTier(type)).toBe('immediate');
    });

    it('has exactly 4 immediate types', () => {
      expect(IMMEDIATE_TIER_TYPES.size).toBe(4);
    });
  });

  // ─── Digest Tier ─────────────────────────────────────────────────────

  describe('digest tier types', () => {
    const digestCases: Array<[string]> = [
      ['card_triggered'],
      ['po_created'],
      ['po_sent'],
      ['po_received'],
      ['wo_status_change'],
      ['transfer_status_change'],
      ['system_alert'],
      ['receiving_completed'],
      ['relowisa_recommendation'],
    ];

    it.each(digestCases)('%s → digest', (type) => {
      expect(getNotificationTier(type)).toBe('digest');
    });

    it('has exactly 9 digest types', () => {
      expect(DIGEST_TIER_TYPES.size).toBe(9);
    });
  });

  // ─── Coverage ────────────────────────────────────────────────────────

  it('covers all 13 notification types across both tiers', () => {
    expect(IMMEDIATE_TIER_TYPES.size + DIGEST_TIER_TYPES.size).toBe(13);
  });

  it('has no overlap between tiers', () => {
    for (const type of IMMEDIATE_TIER_TYPES) {
      expect(DIGEST_TIER_TYPES.has(type as any)).toBe(false);
    }
  });

  // ─── Unknown Type ────────────────────────────────────────────────────

  it('throws for unknown notification type', () => {
    expect(() => getNotificationTier('unknown_type')).toThrow(
      'Unknown notification type for tier classification: unknown_type'
    );
  });
});
