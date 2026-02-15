import type { ServerResponse } from 'http';
import type { Express } from 'express';
import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import { serviceUrls, createLogger } from '@arda/config';
import { authMiddleware } from '@arda/auth-utils';

const log = createLogger('proxy');

// ─── Service Route Map ────────────────────────────────────────────────
// Maps URL prefixes to upstream services.
// Auth routes are unprotected (they handle their own auth).
// All other routes require a valid JWT.

interface RouteConfig {
  prefix: string;
  target: string;
  pathRewrite: Record<string, string>;
  requiresAuth: boolean;
}

// NOTE: Express strips the prefix from req.url when using app.use(prefix, ...),
// so pathRewrite patterns match the STRIPPED url (e.g. "/register", not "/api/auth/register").
const routes: RouteConfig[] = [
  {
    prefix: '/api/auth',
    target: serviceUrls.auth,
    pathRewrite: { '^/': '/auth/' },
    requiresAuth: false,
  },
  {
    prefix: '/api/tenants',
    target: serviceUrls.auth,
    pathRewrite: { '^/': '/tenants/' },
    requiresAuth: true,
  },
  {
    prefix: '/api/users',
    target: serviceUrls.auth,
    pathRewrite: { '^/': '/users/' },
    requiresAuth: true,
  },
  {
    prefix: '/api/integrations',
    target: serviceUrls.auth,
    pathRewrite: { '^/': '/integrations/' },
    requiresAuth: true,
  },
  {
    prefix: '/api/catalog',
    target: serviceUrls.catalog,
    pathRewrite: {},
    requiresAuth: true,
  },
  {
    prefix: '/api/kanban',
    target: serviceUrls.kanban,
    pathRewrite: {},
    requiresAuth: true,
  },
  {
    prefix: '/api/orders',
    target: serviceUrls.orders,
    pathRewrite: {},
    requiresAuth: true,
  },
  {
    prefix: '/api/sales/orders',
    target: serviceUrls.orders,
    pathRewrite: { '^/': '/sales-orders/' },
    requiresAuth: true,
  },
  {
    prefix: '/api/items',
    target: serviceUrls.items,
    pathRewrite: { '^/': '/v1/items/' },
    requiresAuth: true,
  },
  // ── Gmail integration (proxied to notifications service) ──
  {
    prefix: '/api/gmail',
    target: serviceUrls.notifications,
    pathRewrite: { '^/': '/gmail/' },
    requiresAuth: true,
  },
  // ── Public unsubscribe endpoint (token-based auth, no JWT) ──
  {
    prefix: '/api/notifications/unsubscribe',
    target: serviceUrls.notifications,
    pathRewrite: { '^/': '/notifications/unsubscribe/' },
    requiresAuth: false,
  },
  {
    prefix: '/api/notifications',
    target: serviceUrls.notifications,
    pathRewrite: { '^/': '/notifications/' },
    requiresAuth: true,
  },
  // ── Public scan endpoint (QR code deep-link, no auth) ──
  {
    prefix: '/scan',
    target: serviceUrls.kanban,
    pathRewrite: { '^/': '/scan/' },
    requiresAuth: false,
  },
];

export function setupProxies(app: Express): void {
  for (const route of routes) {
    const proxyOptions: Options = {
      target: route.target,
      changeOrigin: true,
      pathRewrite: route.pathRewrite,
      on: {
        proxyReq: (proxyReq, req) => {
          // Forward the original client IP
          const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
          if (clientIp) {
            proxyReq.setHeader('x-forwarded-for', String(clientIp));
          }
        },
        proxyRes: (proxyRes) => {
          // Enforce gateway-level CORS policy only; ignore upstream CORS headers.
          delete proxyRes.headers['access-control-allow-origin'];
          delete proxyRes.headers['access-control-allow-credentials'];
          delete proxyRes.headers['access-control-allow-methods'];
          delete proxyRes.headers['access-control-allow-headers'];
          delete proxyRes.headers['access-control-expose-headers'];
          delete proxyRes.headers['access-control-max-age'];
        },
        error: (err, _req, res) => {
          log.error({ prefix: route.prefix, err: err.message }, 'Proxy error');
          if ('writeHead' in res && typeof res.writeHead === 'function') {
            const httpRes = res as ServerResponse;
            const payload = JSON.stringify({
              error: 'Service unavailable',
              service: route.prefix,
            });
            httpRes.writeHead(502, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(payload).toString(),
            });
            httpRes.end(payload);
          }
        },
      },
    };

    if (route.requiresAuth) {
      // Protected route: validate JWT before proxying
      app.use(route.prefix, authMiddleware, createProxyMiddleware(proxyOptions));
    } else {
      // Public route: proxy directly
      app.use(route.prefix, createProxyMiddleware(proxyOptions));
    }

    log.debug({ prefix: route.prefix, target: route.target }, 'Proxy route registered');
  }
}
