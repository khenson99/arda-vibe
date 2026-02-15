import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ─── Hoisted Mocks ──────────────────────────────────────────────────
const { publishUserActivityMock } = vi.hoisted(() => {
  const publishUserActivityMock = vi.fn().mockResolvedValue(undefined);
  return { publishUserActivityMock };
});

vi.mock('../realtime-publishers.js', () => ({
  publishUserActivity: publishUserActivityMock,
}));

import { userActivityMiddleware } from '../activity-middleware.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    path: '/purchase-orders',
    baseUrl: '/orders',
    headers: {},
    user: { sub: 'user-1', tenantId: 'tenant-1' },
    ...overrides,
  } as unknown as Request;
}

function createMockRes(statusCode = 200): Response & { _finishCallbacks: (() => void)[] } {
  const callbacks: (() => void)[] = [];
  return {
    statusCode,
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'finish') callbacks.push(cb);
    }),
    _finishCallbacks: callbacks,
  } as unknown as Response & { _finishCallbacks: (() => void)[] };
}

function fireFinish(res: ReturnType<typeof createMockRes>) {
  for (const cb of res._finishCallbacks) cb();
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('userActivityMiddleware', () => {
  const getCorrelationId = vi.fn(() => 'corr-123');
  let middleware: ReturnType<typeof userActivityMiddleware>;
  let next: NextFunction;

  beforeEach(() => {
    publishUserActivityMock.mockReset().mockResolvedValue(undefined);
    getCorrelationId.mockReturnValue('corr-123');
    middleware = userActivityMiddleware('orders', getCorrelationId);
    next = vi.fn();
  });

  it('calls next() immediately', () => {
    const req = createMockReq();
    const res = createMockRes();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('publishes user.activity on successful POST mutation', () => {
    const req = createMockReq({ method: 'POST', path: '/purchase-orders', baseUrl: '/orders' });
    const res = createMockRes(201);

    middleware(req, res, next);
    fireFinish(res);

    expect(publishUserActivityMock).toHaveBeenCalledOnce();
    expect(publishUserActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        activityType: 'mutation',
        route: 'POST /orders/purchase-orders',
        resourceType: 'purchase-orders',
        source: 'orders',
        correlationId: 'corr-123',
      }),
    );
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('publishes for %s method', (method) => {
    const req = createMockReq({ method, path: '/some-resource/abc-123' });
    const res = createMockRes(200);

    middleware(req, res, next);
    fireFinish(res);

    expect(publishUserActivityMock).toHaveBeenCalledOnce();
  });

  it('extracts UUID resourceId from second path segment', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const req = createMockReq({ method: 'PATCH', path: `/purchase-orders/${uuid}` });
    const res = createMockRes(200);

    middleware(req, res, next);
    fireFinish(res);

    expect(publishUserActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'purchase-orders',
        resourceId: uuid,
      }),
    );
  });

  it('does not publish for GET requests', () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes(200);

    middleware(req, res, next);
    fireFinish(res);

    expect(publishUserActivityMock).not.toHaveBeenCalled();
  });

  it('does not publish for non-2xx responses', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes(400);

    middleware(req, res, next);
    fireFinish(res);

    expect(publishUserActivityMock).not.toHaveBeenCalled();
  });

  it('does not publish for 500 responses', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes(500);

    middleware(req, res, next);
    fireFinish(res);

    expect(publishUserActivityMock).not.toHaveBeenCalled();
  });

  it('does not publish when no user is authenticated', () => {
    const req = createMockReq({ method: 'POST', user: undefined } as unknown as Partial<Request>);
    const res = createMockRes(200);

    middleware(req, res, next);
    fireFinish(res);

    expect(publishUserActivityMock).not.toHaveBeenCalled();
  });

  it('omits correlationId when it is "unknown"', () => {
    getCorrelationId.mockReturnValue('unknown');
    middleware = userActivityMiddleware('kanban', getCorrelationId);

    const req = createMockReq({ method: 'POST', path: '/cards' });
    const res = createMockRes(201);

    middleware(req, res, next);
    fireFinish(res);

    expect(publishUserActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: undefined,
        source: 'kanban',
      }),
    );
  });
});
