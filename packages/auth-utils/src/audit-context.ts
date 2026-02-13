import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from './middleware.js';

// ─── Audit Context ──────────────────────────────────────────────────

export interface AuditContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditContextRequest extends AuthRequest {
  auditContext: AuditContext;
}

/**
 * Express middleware that extracts audit-relevant fields (IP address,
 * user agent, user ID) from the request and attaches them as
 * `req.auditContext`.
 *
 * Must be used AFTER authMiddleware so `req.user` is populated.
 *
 * Usage:
 *   app.use(authMiddleware);
 *   app.use(auditContextMiddleware);
 *   // ... routes can now use req.auditContext
 */
export function auditContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authReq = req as AuthRequest;
  const auditReq = req as AuditContextRequest;

  // Extract client IP — prefer X-Forwarded-For (first entry) for proxied requests
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0]?.trim();
  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;

  // Extract User-Agent
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader)
    ? userAgentHeader[0]
    : userAgentHeader;

  auditReq.auditContext = {
    userId: authReq.user?.sub,
    ipAddress: rawIp?.slice(0, 45), // varchar(45) matches IPv6 max
    userAgent,
  };

  next();
}
