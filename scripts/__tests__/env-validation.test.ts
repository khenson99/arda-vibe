import { describe, it, expect } from 'vitest';
import {
  buildEffectiveEnv,
  validateEnv,
} from '../lib/env-validation.js';

describe('env-validation', () => {
  it('flags missing required variables', () => {
    const result = validateEnv({});

    expect(result.errors.some((error) => error.includes('DATABASE_URL'))).toBe(true);
    expect(result.errors.some((error) => error.includes('JWT_SECRET'))).toBe(true);
    expect(result.errors.some((error) => error.includes('JWT_REFRESH_SECRET'))).toBe(true);
  });

  it('flags invalid url formats', () => {
    const result = validateEnv({
      DATABASE_URL: 'not-a-url',
      JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
      JWT_REFRESH_SECRET: 'abcdefghijklmnopqrstuvwxyz654321',
    });

    expect(result.errors.some((error) => error.includes('Invalid URL'))).toBe(true);
  });

  it('emits production warnings for default development secrets', () => {
    const result = validateEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://arda:arda_dev_password@localhost:5432/arda_v2',
      JWT_SECRET: 'change-me-in-production-use-a-64-char-random-string',
      JWT_REFRESH_SECRET: 'change-me-too-different-from-above',
    });

    expect(result.warnings.some((warning) => warning.includes('JWT_SECRET'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('JWT_REFRESH_SECRET'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('DATABASE_URL'))).toBe(true);
  });

  it('prefers process environment variables over file values', () => {
    const merged = buildEffectiveEnv(
      { DATABASE_URL: 'postgresql://file:pass@localhost:5432/file' },
      { DATABASE_URL: 'postgresql://process:pass@localhost:5432/process' } as NodeJS.ProcessEnv
    );

    expect(merged.DATABASE_URL).toBe('postgresql://process:pass@localhost:5432/process');
  });
});
