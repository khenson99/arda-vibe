import { describe, it, expect, vi } from 'vitest';

// Mock heavy dependencies that need env vars / database connections
vi.mock('@arda/db', () => ({ db: {}, schema: {} }));
vi.mock('@arda/events', () => ({ getEventBus: vi.fn() }));
vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../middleware/error-handler.js', () => ({
  AppError: class AppError extends Error {
    constructor(public status: number, message: string, public code?: string) {
      super(message);
    }
  },
}));

import { VALID_TRANSITIONS, isValidTransition } from '../card-lifecycle.service.js';

describe('VALID_TRANSITIONS', () => {
  it('defines all six Kanban stages', () => {
    const stages = Object.keys(VALID_TRANSITIONS);
    expect(stages).toEqual(
      expect.arrayContaining(['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked'])
    );
    expect(stages).toHaveLength(6);
  });

  it('forms a complete cycle from created back to created', () => {
    const cycle = ['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked', 'triggered'];
    for (let i = 0; i < cycle.length - 1; i++) {
      expect(VALID_TRANSITIONS[cycle[i]]).toContain(cycle[i + 1]);
    }
  });

  it('allows skipping in_transit (local procurement shortcut)', () => {
    expect(VALID_TRANSITIONS['ordered']).toContain('received');
    expect(VALID_TRANSITIONS['ordered']).toContain('in_transit');
  });

  it('each stage has at least one valid next stage', () => {
    for (const [stage, nextStages] of Object.entries(VALID_TRANSITIONS)) {
      expect(nextStages.length, `${stage} should have valid next stages`).toBeGreaterThan(0);
    }
  });
});

describe('isValidTransition', () => {
  it('returns true for valid forward transitions', () => {
    expect(isValidTransition('created', 'triggered')).toBe(true);
    expect(isValidTransition('triggered', 'ordered')).toBe(true);
    expect(isValidTransition('ordered', 'in_transit')).toBe(true);
    expect(isValidTransition('ordered', 'received')).toBe(true);
    expect(isValidTransition('in_transit', 'received')).toBe(true);
    expect(isValidTransition('received', 'restocked')).toBe(true);
    expect(isValidTransition('restocked', 'triggered')).toBe(true);
  });

  it('returns false for backward transitions', () => {
    expect(isValidTransition('triggered', 'created')).toBe(false);
    expect(isValidTransition('ordered', 'triggered')).toBe(false);
    expect(isValidTransition('received', 'ordered')).toBe(false);
    expect(isValidTransition('restocked', 'received')).toBe(false);
  });

  it('returns false for skipping stages (except ordered -> received)', () => {
    expect(isValidTransition('created', 'ordered')).toBe(false);
    expect(isValidTransition('created', 'received')).toBe(false);
    expect(isValidTransition('triggered', 'in_transit')).toBe(false);
    expect(isValidTransition('triggered', 'received')).toBe(false);
  });

  it('returns false for same-stage transitions', () => {
    expect(isValidTransition('created', 'created')).toBe(false);
    expect(isValidTransition('ordered', 'ordered')).toBe(false);
  });

  it('returns false for unknown stages', () => {
    expect(isValidTransition('nonexistent', 'triggered')).toBe(false);
    expect(isValidTransition('created', 'nonexistent')).toBe(false);
    expect(isValidTransition('', '')).toBe(false);
  });
});
