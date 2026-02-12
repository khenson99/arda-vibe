/**
 * Tests for detectScanConflict — pure-function conflict resolution.
 *
 * Mocks @arda/config, @arda/db, and @arda/events because
 * card-lifecycle.service.ts imports them at module scope. The function
 * under test (detectScanConflict) is a pure function with no I/O.
 */

// Mock infrastructure modules before any imports that trigger them
vi.mock('@arda/config', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  config: { REDIS_URL: 'redis://localhost:6379' },
}));
vi.mock('@arda/db', () => ({
  db: { query: {}, transaction: vi.fn(), insert: vi.fn(), update: vi.fn() },
  schema: {
    kanbanCards: {},
    kanbanLoops: {},
    cardStageTransitions: {},
    lifecycleEvents: {},
    kanbanParameterHistory: {},
    lifecycleEventTypeEnum: { enumValues: [] },
  },
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'mock', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));
vi.mock('@arda/events', () => ({ getEventBus: vi.fn(() => ({ publish: vi.fn() })) }));

import { detectScanConflict } from '../services/card-lifecycle.service.js';
import type { CardStage, ScanConflictResolution } from '@arda/shared-types';

describe('detectScanConflict', () => {
  it('should return "ok" when card is in "created" stage and active', () => {
    expect(detectScanConflict('created', true)).toBe('ok');
  });

  it('should return "already_triggered" when card is in "triggered" stage', () => {
    expect(detectScanConflict('triggered', true)).toBe('already_triggered');
  });

  it('should return "stage_advanced" for stages past "triggered"', () => {
    const advancedStages: CardStage[] = ['ordered', 'in_transit', 'received', 'restocked'];

    for (const stage of advancedStages) {
      expect(detectScanConflict(stage, true)).toBe('stage_advanced');
    }
  });

  it('should return "card_inactive" when card is not active, regardless of stage', () => {
    const allStages: CardStage[] = [
      'created',
      'triggered',
      'ordered',
      'in_transit',
      'received',
      'restocked',
    ];

    for (const stage of allStages) {
      expect(detectScanConflict(stage, false)).toBe('card_inactive');
    }
  });

  it('should prioritize "card_inactive" over stage-based resolution', () => {
    // Even if the card is in "created" (would normally be "ok"),
    // an inactive card should always return "card_inactive"
    expect(detectScanConflict('created', false)).toBe('card_inactive');
  });

  describe('exhaustive resolution coverage', () => {
    const cases: Array<{
      stage: CardStage;
      isActive: boolean;
      expected: ScanConflictResolution;
    }> = [
      { stage: 'created', isActive: true, expected: 'ok' },
      { stage: 'created', isActive: false, expected: 'card_inactive' },
      { stage: 'triggered', isActive: true, expected: 'already_triggered' },
      { stage: 'triggered', isActive: false, expected: 'card_inactive' },
      { stage: 'ordered', isActive: true, expected: 'stage_advanced' },
      { stage: 'ordered', isActive: false, expected: 'card_inactive' },
      { stage: 'in_transit', isActive: true, expected: 'stage_advanced' },
      { stage: 'received', isActive: true, expected: 'stage_advanced' },
      { stage: 'restocked', isActive: true, expected: 'stage_advanced' },
    ];

    for (const { stage, isActive, expected } of cases) {
      it(`(${stage}, active=${isActive}) → ${expected}`, () => {
        expect(detectScanConflict(stage, isActive)).toBe(expected);
      });
    }
  });
});
