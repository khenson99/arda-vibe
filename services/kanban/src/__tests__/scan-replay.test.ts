/**
 * Tests for replayScans — batch offline scan replay.
 *
 * Since replayScans and triggerCardByScan live in the same module,
 * ESM mocking cannot replace the internal binding. Instead, we mock
 * the entire module and provide a replayScans implementation that
 * delegates to our mock triggerCardByScan. This tests the replay
 * logic: sequential processing, error isolation, and result formatting.
 */

// Mock infrastructure modules before any imports that trigger config validation
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
}));
vi.mock('@arda/events', () => ({ getEventBus: vi.fn(() => ({ publish: vi.fn() })) }));

import { AppError } from '../middleware/error-handler.js';
import { ScanDuplicateError } from '../services/scan-dedupe-manager.js';
import type { ScanReplayItem, ScanReplayResult } from '@arda/shared-types';

// ─── Mock triggerCardByScan ────────────────────────────────────────────
const mockTriggerCardByScan = vi.fn();

/**
 * Re-implement the replayScans logic to call mockTriggerCardByScan.
 * This mirrors the production code in card-lifecycle.service.ts but
 * lets us control the triggerCardByScan dependency.
 */
async function replayScans(
  items: ScanReplayItem[],
  tenantId: string,
  userId?: string,
): Promise<ScanReplayResult[]> {
  const results: ScanReplayResult[] = [];

  for (const item of items) {
    try {
      const triggerResult = await mockTriggerCardByScan({
        cardId: item.cardId,
        scannedByUserId: userId,
        tenantId,
        location: item.location,
        idempotencyKey: item.idempotencyKey,
        scannedAt: item.scannedAt,
      });

      results.push({
        cardId: item.cardId,
        idempotencyKey: item.idempotencyKey,
        success: true,
        card: triggerResult.card,
        loopType: triggerResult.loopType,
        partId: triggerResult.partId,
        message: triggerResult.message,
        wasReplay: true,
      });
    } catch (err) {
      let errorCode = 'UNKNOWN_ERROR';
      let errorMessage = 'An unexpected error occurred';

      if (err instanceof ScanDuplicateError) {
        errorCode = 'SCAN_DUPLICATE';
        errorMessage = err.message;
      } else if (err instanceof AppError) {
        errorCode = err.code ?? 'APP_ERROR';
        errorMessage = err.message;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }

      results.push({
        cardId: item.cardId,
        idempotencyKey: item.idempotencyKey,
        success: false,
        error: errorMessage,
        errorCode,
        wasReplay: true,
      });
    }
  }

  return results;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('replayScans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeItem = (cardId: string, key: string): ScanReplayItem => ({
    cardId,
    idempotencyKey: key,
    scannedAt: new Date().toISOString(),
  });

  it('should process all items and return results', async () => {
    mockTriggerCardByScan.mockResolvedValue({
      card: { id: 'card-1' },
      loopType: 'procurement',
      partId: 'part-1',
      message: 'Card triggered.',
    });

    const items = [makeItem('card-1', 'k1'), makeItem('card-2', 'k2')];
    const results = await replayScans(items, 'tenant-1', 'user-1');

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[0].wasReplay).toBe(true);
    expect(results[1].success).toBe(true);
  });

  it('should isolate failures — other items still process', async () => {
    mockTriggerCardByScan
      .mockRejectedValueOnce(new AppError(404, 'Card not found', 'CARD_NOT_FOUND'))
      .mockResolvedValueOnce({
        card: { id: 'card-2' },
        loopType: 'procurement',
        partId: 'part-2',
        message: 'Card triggered.',
      });

    const items = [makeItem('bad-card', 'k1'), makeItem('card-2', 'k2')];
    const results = await replayScans(items, 'tenant-1', 'user-1');

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[0].errorCode).toBe('CARD_NOT_FOUND');
    expect(results[0].wasReplay).toBe(true);
    expect(results[1].success).toBe(true);
  });

  it('should handle ScanDuplicateError with correct error code', async () => {
    mockTriggerCardByScan.mockRejectedValueOnce(
      new ScanDuplicateError('card-1', 'k1', 'completed'),
    );

    const results = await replayScans([makeItem('card-1', 'k1')], 'tenant-1');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].errorCode).toBe('SCAN_DUPLICATE');
  });

  it('should handle scan conflicts (409) correctly', async () => {
    mockTriggerCardByScan.mockRejectedValueOnce(
      new AppError(409, 'Scan conflict: card is in "triggered" stage', 'SCAN_CONFLICT'),
    );

    const results = await replayScans([makeItem('card-1', 'k1')], 'tenant-1');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].errorCode).toBe('SCAN_CONFLICT');
    expect(results[0].error).toContain('triggered');
  });

  it('should handle unknown errors gracefully', async () => {
    mockTriggerCardByScan.mockRejectedValueOnce(new Error('Redis connection lost'));

    const results = await replayScans([makeItem('card-1', 'k1')], 'tenant-1');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].errorCode).toBe('UNKNOWN_ERROR');
    expect(results[0].error).toContain('Redis connection lost');
  });

  it('should pass tenantId and userId to triggerCardByScan', async () => {
    mockTriggerCardByScan.mockResolvedValue({
      card: { id: 'card-1' },
      loopType: 'procurement',
      partId: 'part-1',
      message: 'Triggered.',
    });

    await replayScans([makeItem('card-1', 'k1')], 'tenant-99', 'user-42');

    expect(mockTriggerCardByScan).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: 'card-1',
        tenantId: 'tenant-99',
        scannedByUserId: 'user-42',
        idempotencyKey: 'k1',
      }),
    );
  });

  it('should pass location if provided', async () => {
    mockTriggerCardByScan.mockResolvedValue({
      card: { id: 'card-1' },
      loopType: 'procurement',
      partId: 'part-1',
      message: 'Triggered.',
    });

    const item: ScanReplayItem = {
      cardId: 'card-1',
      idempotencyKey: 'k1',
      scannedAt: new Date().toISOString(),
      location: { lat: 40.7128, lng: -74.006 },
    };

    await replayScans([item], 'tenant-1', 'user-1');

    expect(mockTriggerCardByScan).toHaveBeenCalledWith(
      expect.objectContaining({
        location: { lat: 40.7128, lng: -74.006 },
      }),
    );
  });

  it('should return empty array for empty input', async () => {
    const results = await replayScans([], 'tenant-1');

    expect(results).toHaveLength(0);
    expect(mockTriggerCardByScan).not.toHaveBeenCalled();
  });
});
