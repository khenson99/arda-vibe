import { Router, type Request } from 'express';
import { z } from 'zod';
import { createLogger } from '@arda/config';
import { writeAuditEntry, db } from '@arda/db';
import type { AuditContext } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';
import {
  getAuthUrl,
  exchangeCodeForTokens,
  storeOAuthTokens,
  getUserOAuthTokens,
  revokeUserTokens,
  sendEmail,
  GmailError,
} from '../services/gmail.service.js';

const log = createLogger('gmail-oauth');

function getRequestAuditContext(req: Request): AuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded as string | undefined)?.split(',')[0]?.trim();
  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
  return {
    userId: req.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

export const gmailOauthRouter = Router();

// ─── GET /auth-url — Generate OAuth consent URL ─────────────────────
gmailOauthRouter.get('/auth-url', (_req, res, next) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// ─── GET /callback — Handle OAuth callback ──────────────────────────
const callbackSchema = z.object({
  code: z.string().min(1, 'OAuth authorization code is required'),
});

gmailOauthRouter.get('/callback', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const { code } = callbackSchema.parse(req.query);

    const tokens = await exchangeCodeForTokens(code);

    await storeOAuthTokens(userId, tenantId, tokens);

    await writeAuditEntry(db, {
      tenantId,
      userId: auditContext.userId,
      action: 'gmail.connected',
      entityType: 'user_oauth_token',
      entityId: userId,
      newState: { provider: 'google', email: tokens.email, scopes: tokens.scopes },
      metadata: { source: 'gmail.oauth_callback' },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    log.info({ userId, email: tokens.email }, 'Gmail account connected');

    res.json({
      connected: true,
      email: tokens.email,
      scopes: tokens.scopes,
    });
  } catch (err) {
    log.error({ err }, 'Gmail OAuth callback failed');
    next(err);
  }
});

// ─── GET /status — Check Gmail connection status ────────────────────
gmailOauthRouter.get('/status', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tokenRow = await getUserOAuthTokens(userId);

    if (!tokenRow) {
      res.json({ connected: false });
      return;
    }

    res.json({
      connected: true,
      email: tokenRow.email,
      isValid: tokenRow.isValid,
      scopes: tokenRow.scopes,
      connectedAt: tokenRow.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /disconnect — Revoke and remove tokens ──────────────────
gmailOauthRouter.delete('/disconnect', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const tokenRow = await getUserOAuthTokens(userId);
    if (!tokenRow) {
      throw new AppError(404, 'No Gmail connection found', 'GMAIL_NOT_CONNECTED');
    }

    const removed = await revokeUserTokens(userId);
    if (!removed) {
      throw new AppError(404, 'No Gmail connection found', 'GMAIL_NOT_CONNECTED');
    }

    await writeAuditEntry(db, {
      tenantId,
      userId: auditContext.userId,
      action: 'gmail.disconnected',
      entityType: 'user_oauth_token',
      entityId: userId,
      previousState: { provider: 'google', email: tokenRow.email, scopes: tokenRow.scopes },
      metadata: { source: 'gmail.disconnect' },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    log.info({ userId }, 'Gmail account disconnected');

    res.json({ disconnected: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /send — Send an email via user's Gmail ────────────────────
const sendEmailSchema = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1, 'Subject is required'),
  textBody: z.string().optional(),
  htmlBody: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        content: z.string(), // base64-encoded content
        mimeType: z.string().default('application/octet-stream'),
      })
    )
    .optional(),
}).refine(
  (data) => data.textBody || data.htmlBody,
  { message: 'At least one of textBody or htmlBody is required' }
);

gmailOauthRouter.post('/send', async (req, res, next) => {
  try {
    const userId = req.user!.sub;

    const body = sendEmailSchema.parse(req.body);

    // Decode base64 attachment content into Buffers
    const attachments = body.attachments?.map((att) => ({
      filename: att.filename,
      content: Buffer.from(att.content, 'base64'),
      mimeType: att.mimeType,
    }));

    const result = await sendEmail(userId, {
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      textBody: body.textBody,
      htmlBody: body.htmlBody,
      attachments,
    });

    res.json({
      sent: true,
      messageId: result.messageId,
      threadId: result.threadId,
    });
  } catch (err) {
    if (err instanceof GmailError) {
      const statusMap: Record<string, number> = {
        GMAIL_NOT_CONNECTED: 400,
        GMAIL_TOKENS_INVALID: 401,
        GMAIL_AUTH_EXPIRED: 401,
        GMAIL_RATE_LIMITED: 429,
        GMAIL_SEND_FAILED: 502,
      };
      throw new AppError(statusMap[err.code] ?? 500, err.message, err.code);
    }
    next(err);
  }
});
