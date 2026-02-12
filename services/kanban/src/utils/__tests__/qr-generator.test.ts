import { describe, it, expect, vi } from 'vitest';

// Mock @arda/config before importing the module under test
vi.mock('@arda/config', () => ({
  config: {
    NODE_ENV: 'development',
    APP_URL: 'http://localhost:5173',
  },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildScanUrl } from '../qr-generator.js';

describe('buildScanUrl', () => {
  it('returns localhost URL in development mode', () => {
    const url = buildScanUrl('card-uuid-123');
    expect(url).toBe('http://localhost:5173/scan/card-uuid-123');
  });

  it('ignores tenantSlug in development mode', () => {
    const url = buildScanUrl('card-uuid-123', 'acme');
    // In dev mode, always uses APP_URL regardless of tenant
    expect(url).toBe('http://localhost:5173/scan/card-uuid-123');
  });

  it('embeds the card UUID in the path', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const url = buildScanUrl(uuid);
    expect(url).toContain(`/scan/${uuid}`);
  });

  it('always produces a valid URL', () => {
    const url = buildScanUrl('test-card-id');
    expect(() => new URL(url)).not.toThrow();
  });
});
