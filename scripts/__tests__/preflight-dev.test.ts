import { describe, it, expect } from 'vitest';
import {
  classifyReachabilityError,
  findPortConflicts,
  formatPortOwner,
  parseEndpointFromUrl,
  shouldSkipPreflight,
} from '../preflight-dev.js';

describe('preflight-dev helpers', () => {
  it('parses dependency endpoints with fallback ports', () => {
    const postgres = parseEndpointFromUrl('postgresql://user:pass@db.internal/arda_v2', 5432);
    const redis = parseEndpointFromUrl('redis://cache.internal', 6379);

    expect(postgres).toEqual({ host: 'db.internal', port: 5432 });
    expect(redis).toEqual({ host: 'cache.internal', port: 6379 });
  });

  it('classifies tcp failure reasons', () => {
    expect(classifyReachabilityError({ code: 'ETIMEDOUT' })).toBe('connection timed out');
    expect(classifyReachabilityError({ code: 'ECONNREFUSED' })).toBe('connection refused');
    expect(classifyReachabilityError({ code: 'ENOTFOUND' })).toBe('host not found');
    expect(classifyReachabilityError({ code: 'EHOSTUNREACH' })).toBe('host unreachable');
    expect(classifyReachabilityError({ code: 'SOMETHING_ELSE' })).toBe('connection failed');
  });

  it('detects and formats port conflicts', () => {
    const conflicts = findPortConflicts(
      [3000, 3003, 5173],
      (port) => (port === 3003 ? { port, pid: 777, command: 'node' } : null)
    );

    expect(conflicts).toEqual([{ port: 3003, pid: 777, command: 'node' }]);
    expect(formatPortOwner(conflicts[0])).toBe('Port 3003 is already in use by pid 777 (node).');
  });

  it('supports SKIP_PREFLIGHT short-circuit', () => {
    expect(shouldSkipPreflight({ SKIP_PREFLIGHT: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldSkipPreflight({ SKIP_PREFLIGHT: 'TRUE' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldSkipPreflight({ SKIP_PREFLIGHT: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
