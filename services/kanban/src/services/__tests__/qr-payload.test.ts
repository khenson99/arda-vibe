import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  buildScanUrl: vi.fn(),
  generateQRDataUrl: vi.fn(),
}));

vi.mock('@arda/config', () => ({
  config: {
    NODE_ENV: 'development',
    APP_URL: 'http://localhost:5173',
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@arda/db', () => ({
  db: {
    query: {
      kanbanCards: { findFirst: mocks.findFirst },
    },
  },
  schema: {
    kanbanCards: {},
  },
}));

vi.mock('../../utils/qr-generator.js', () => ({
  buildScanUrl: mocks.buildScanUrl,
  generateQRDataUrl: mocks.generateQRDataUrl,
}));

import {
  generateQrPayload,
  generateQrPayloadBatch,
  resolveQrScan,
  verifyCardUuidImmutability,
  buildDeepLinkUrl,
} from '../qr-payload.service.js';

describe('qr-payload.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildScanUrl.mockReturnValue('http://localhost:5173/scan/test-uuid');
    mocks.generateQRDataUrl.mockResolvedValue('data:image/png;base64,abc123');
  });

  // ── generateQrPayload ──
  describe('generateQrPayload', () => {
    it('returns scanUrl and qrCodeDataUrl for a card', async () => {
      const result = await generateQrPayload('test-uuid');
      expect(result.cardId).toBe('test-uuid');
      expect(result.scanUrl).toBe('http://localhost:5173/scan/test-uuid');
      expect(result.qrCodeDataUrl).toBe('data:image/png;base64,abc123');
      expect(mocks.buildScanUrl).toHaveBeenCalledWith('test-uuid', undefined);
      expect(mocks.generateQRDataUrl).toHaveBeenCalledWith('test-uuid', undefined);
    });

    it('passes tenantSlug to underlying functions', async () => {
      await generateQrPayload('card-1', 'acme');
      expect(mocks.buildScanUrl).toHaveBeenCalledWith('card-1', 'acme');
      expect(mocks.generateQRDataUrl).toHaveBeenCalledWith('card-1', 'acme');
    });
  });

  // ── generateQrPayloadBatch ──
  describe('generateQrPayloadBatch', () => {
    it('generates payloads for multiple cards', async () => {
      const results = await generateQrPayloadBatch(['card-1', 'card-2']);
      expect(results).toHaveLength(2);
      expect(results[0].payload).toBeDefined();
      expect(results[1].payload).toBeDefined();
    });

    it('deduplicates card IDs', async () => {
      const results = await generateQrPayloadBatch(['card-1', 'card-1', 'card-2']);
      expect(results).toHaveLength(2);
    });

    it('captures per-card errors without failing the batch', async () => {
      mocks.generateQRDataUrl
        .mockResolvedValueOnce('data:image/png;base64,ok')
        .mockRejectedValueOnce(new Error('QR generation failed'));
      const results = await generateQrPayloadBatch(['good-card', 'bad-card']);
      expect(results).toHaveLength(2);
      expect(results[0].payload).toBeDefined();
      expect(results[1].error).toBe('QR generation failed');
    });

    it('rejects batch exceeding MAX_BATCH_SIZE', async () => {
      const ids = Array.from({ length: 201 }, (_, i) => `card-${i}`);
      await expect(generateQrPayloadBatch(ids)).rejects.toThrow('Batch size exceeds maximum');
    });
  });

  // ── resolveQrScan ──
  describe('resolveQrScan', () => {
    it('returns VALID for an active card', async () => {
      mocks.findFirst.mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440000', isActive: true });
      const result = await resolveQrScan('550e8400-e29b-41d4-a716-446655440000');
      expect(result.status).toBe('VALID');
      expect(result.card).toBeDefined();
    });

    it('returns MALFORMED_UUID for invalid UUID', async () => {
      const result = await resolveQrScan('not-a-uuid');
      expect(result.status).toBe('MALFORMED_UUID');
    });

    it('returns CARD_NOT_FOUND when card does not exist', async () => {
      mocks.findFirst.mockResolvedValue(null);
      const result = await resolveQrScan('550e8400-e29b-41d4-a716-446655440000');
      expect(result.status).toBe('CARD_NOT_FOUND');
    });

    it('returns CARD_INACTIVE for deactivated card', async () => {
      mocks.findFirst.mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440000', isActive: false });
      const result = await resolveQrScan('550e8400-e29b-41d4-a716-446655440000');
      expect(result.status).toBe('CARD_INACTIVE');
    });
  });

  // ── verifyCardUuidImmutability ──
  describe('verifyCardUuidImmutability', () => {
    it('returns immutable:true when card exists', async () => {
      mocks.findFirst.mockResolvedValue({ id: 'card-uuid', tenantId: 'tenant-1' });
      const result = await verifyCardUuidImmutability('card-uuid', 'tenant-1');
      expect(result.immutable).toBe(true);
      expect(result.card).toBeDefined();
    });

    it('returns immutable:false when card not found', async () => {
      mocks.findFirst.mockResolvedValue(null);
      const result = await verifyCardUuidImmutability('missing-card', 'tenant-1');
      expect(result.immutable).toBe(false);
    });
  });

  // ── buildDeepLinkUrl ──
  describe('buildDeepLinkUrl', () => {
    it('delegates to buildScanUrl', () => {
      buildDeepLinkUrl('card-1', 'acme');
      expect(mocks.buildScanUrl).toHaveBeenCalledWith('card-1', 'acme');
    });
  });
});
