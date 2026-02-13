import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from './middleware.js';
import {
  auditContextMiddleware,
  type AuditContextRequest,
} from './audit-context.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createMockReq(overrides?: {
  user?: Partial<AuthRequest['user']>;
  headers?: Record<string, string | string[]>;
  remoteAddress?: string;
}): Partial<AuthRequest> {
  return {
    user: overrides?.user as AuthRequest['user'],
    headers: overrides?.headers ?? {},
    socket: { remoteAddress: overrides?.remoteAddress ?? '127.0.0.1' } as any,
  };
}

function createMockRes(): Partial<Response> {
  return {};
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('auditContextMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it('attaches auditContext to the request', () => {
    const req = createMockReq({
      user: {
        sub: 'user-123',
        tenantId: 'tenant-1',
        email: 'test@example.com',
        role: 'tenant_admin',
      },
      headers: { 'user-agent': 'TestBrowser/1.0' },
      remoteAddress: '10.0.0.1',
    });
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    const auditReq = req as unknown as AuditContextRequest;
    expect(auditReq.auditContext).toBeDefined();
    expect(auditReq.auditContext.userId).toBe('user-123');
    expect(auditReq.auditContext.userAgent).toBe('TestBrowser/1.0');
    expect(auditReq.auditContext.ipAddress).toBe('10.0.0.1');
    expect(next).toHaveBeenCalled();
  });

  it('prefers X-Forwarded-For over socket.remoteAddress', () => {
    const req = createMockReq({
      headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18' },
      remoteAddress: '127.0.0.1',
    });
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    const auditReq = req as unknown as AuditContextRequest;
    expect(auditReq.auditContext.ipAddress).toBe('203.0.113.50');
  });

  it('handles array X-Forwarded-For header', () => {
    const req = createMockReq({
      headers: { 'x-forwarded-for': ['198.51.100.1', '70.41.3.18'] },
      remoteAddress: '127.0.0.1',
    });
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    const auditReq = req as unknown as AuditContextRequest;
    expect(auditReq.auditContext.ipAddress).toBe('198.51.100.1');
  });

  it('falls back to socket.remoteAddress when no X-Forwarded-For', () => {
    const req = createMockReq({
      headers: {},
      remoteAddress: '192.168.1.100',
    });
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    const auditReq = req as unknown as AuditContextRequest;
    expect(auditReq.auditContext.ipAddress).toBe('192.168.1.100');
  });

  it('truncates IP to 45 characters (IPv6 max)', () => {
    const longIp = 'a'.repeat(50);
    const req = createMockReq({
      headers: { 'x-forwarded-for': longIp },
    });
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    const auditReq = req as unknown as AuditContextRequest;
    expect(auditReq.auditContext.ipAddress).toHaveLength(45);
  });

  it('handles missing user gracefully (undefined userId)', () => {
    const req = createMockReq({
      headers: { 'user-agent': 'Bot/1.0' },
    });
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    const auditReq = req as unknown as AuditContextRequest;
    expect(auditReq.auditContext.userId).toBeUndefined();
    expect(auditReq.auditContext.userAgent).toBe('Bot/1.0');
    expect(next).toHaveBeenCalled();
  });

  it('handles array user-agent header', () => {
    const req = createMockReq({
      headers: { 'user-agent': ['Agent1', 'Agent2'] },
    });
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    const auditReq = req as unknown as AuditContextRequest;
    expect(auditReq.auditContext.userAgent).toBe('Agent1');
  });

  it('handles missing user-agent header', () => {
    const req = createMockReq({
      headers: {},
    });
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    const auditReq = req as unknown as AuditContextRequest;
    expect(auditReq.auditContext.userAgent).toBeUndefined();
  });

  it('always calls next (no error path)', () => {
    const req = createMockReq();
    const res = createMockRes();

    auditContextMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
