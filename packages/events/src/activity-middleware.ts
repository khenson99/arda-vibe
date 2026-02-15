/**
 * @arda/events — Express middleware for publishing user.activity events
 *
 * Publishes a user.activity event after successful mutation requests
 * (POST, PUT, PATCH, DELETE) from authenticated routes.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { publishUserActivity } from './realtime-publishers.js';

interface AuthenticatedRequest extends Request {
  user?: {
    sub: string;
    tenantId: string;
    [key: string]: unknown;
  };
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Express middleware that publishes user.activity events for mutation requests.
 *
 * Hooks into `res.on('finish')` to publish after the response is sent,
 * only when the request was successful (2xx status) and used a mutation method.
 *
 * @param serviceName - The service name (e.g. 'orders')
 * @param getCorrelationIdFn - Function to get current correlation ID
 */
export function userActivityMiddleware(
  serviceName: string,
  getCorrelationIdFn: () => string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;

    res.on('finish', () => {
      if (
        !MUTATION_METHODS.has(req.method) ||
        res.statusCode < 200 ||
        res.statusCode >= 300 ||
        !authReq.user?.sub ||
        !authReq.user?.tenantId
      ) {
        return;
      }

      const correlationId = getCorrelationIdFn();

      // Derive resource type from the first path segment after the mount point
      const pathSegments = req.path.split('/').filter(Boolean);
      const resourceType = pathSegments[0] || undefined;
      // If the second segment looks like a UUID, use it as resourceId
      const resourceId =
        pathSegments[1] && /^[0-9a-f-]{36}$/i.test(pathSegments[1])
          ? pathSegments[1]
          : undefined;

      void publishUserActivity({
        tenantId: authReq.user.tenantId,
        userId: authReq.user.sub,
        activityType: 'mutation',
        route: `${req.method} ${req.baseUrl}${req.path}`,
        resourceType,
        resourceId,
        source: serviceName,
        correlationId: correlationId !== 'unknown' ? correlationId : undefined,
      });
    });

    next();
  };
}
