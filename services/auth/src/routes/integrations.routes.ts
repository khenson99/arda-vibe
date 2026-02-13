import { Router, type Request } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole, type AuthRequest } from '@arda/auth-utils';
import * as integrationService from '../services/integration.service.js';
import type { AuthAuditContext } from '../services/auth-audit.js';

function extractAuditContext(req: Request): AuthAuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0]?.trim();
  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
  const authReq = req as AuthRequest;
  return {
    userId: authReq.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

export const integrationsRouter = Router();

// All integration routes require authentication
integrationsRouter.use(authMiddleware);

// ─── Validation Schemas ───────────────────────────────────────────────

const createApiKeySchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  permissions: z.array(z.string()).optional(),
  expiresInDays: z.number().int().positive().optional(),
});

const updateWebhookSchema = z.object({
  webhookUrl: z.string().url().nullable().optional(),
  webhookSecret: z.string().min(1).max(255).optional().nullable(),
  webhookEvents: z.array(z.string()).optional(),
});

// ─── POST /integrations/api-keys ──────────────────────────────────────
// Create a new API key (tenant_admin only)
integrationsRouter.post(
  '/api-keys',
  requireRole('tenant_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const input = createApiKeySchema.parse(req.body);
      const auditCtx = extractAuditContext(req);
      const result = await integrationService.createApiKey({
        tenantId: req.user!.tenantId,
        userId: req.user!.sub,
        name: input.name,
        permissions: input.permissions,
        expiresInDays: input.expiresInDays,
      }, auditCtx);

      res.status(201).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
        });
        return;
      }
      next(err);
    }
  }
);

// ─── GET /integrations/api-keys ───────────────────────────────────────
// List all API keys for the tenant (tenant_admin only)
integrationsRouter.get(
  '/api-keys',
  requireRole('tenant_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const keys = await integrationService.listApiKeys(req.user!.tenantId);
      res.json(keys);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /integrations/api-keys/:id/revoke ────────────────────────────
// Revoke an API key (tenant_admin only)
integrationsRouter.put(
  '/api-keys/:id/revoke',
  requireRole('tenant_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const apiKeyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!apiKeyId) {
        res.status(400).json({ error: 'API key ID is required' });
        return;
      }

      const auditCtx = extractAuditContext(req);
      await integrationService.revokeApiKey(apiKeyId, req.user!.tenantId, req.user!.sub, auditCtx);
      res.json({ success: true, message: 'API key revoked' });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── DELETE /integrations/api-keys/:id ────────────────────────────────
// Delete an API key (tenant_admin only)
integrationsRouter.delete(
  '/api-keys/:id',
  requireRole('tenant_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const apiKeyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!apiKeyId) {
        res.status(400).json({ error: 'API key ID is required' });
        return;
      }

      await integrationService.deleteApiKey(apiKeyId, req.user!.tenantId);
      res.json({ success: true, message: 'API key deleted' });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ─── GET /integrations/webhook ────────────────────────────────────────
// Get webhook settings (tenant_admin only)
integrationsRouter.get(
  '/webhook',
  requireRole('tenant_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const settings = await integrationService.getWebhookSettings(req.user!.tenantId);
      res.json(settings);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /integrations/webhook ────────────────────────────────────────
// Update webhook settings (tenant_admin only)
integrationsRouter.put(
  '/webhook',
  requireRole('tenant_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const input = updateWebhookSchema.parse(req.body);
      const result = await integrationService.updateWebhookSettings({
        tenantId: req.user!.tenantId,
        webhookUrl: input.webhookUrl,
        webhookSecret: input.webhookSecret,
        webhookEvents: input.webhookEvents,
      });

      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
        });
        return;
      }
      next(err);
    }
  }
);
