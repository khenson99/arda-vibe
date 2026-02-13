import { Router } from 'express';
import { db, schema } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import { createLogger, config } from '@arda/config';
import { verifyUnsubscribeToken } from '../services/unsubscribe-token.js';

const log = createLogger('unsubscribe');

export const unsubscribeRouter = Router();

// ─── HTML Templates ─────────────────────────────────────────────────

function successHtml(notificationType: string): string {
  const label = notificationType.replace(/_/g, ' ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribed - Arda</title>
  <style>
    body { font-family: 'Open Sans', system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #0a0a0a; }
    .card { background: #fff; border-radius: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 40px; max-width: 480px; text-align: center; }
    h1 { font-size: 24px; font-weight: 600; margin: 0 0 12px; }
    p { font-size: 14px; color: #737373; line-height: 1.6; margin: 0 0 24px; }
    .check { font-size: 48px; margin-bottom: 16px; }
    a { display: inline-block; background: #fc5a29; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; }
    a:hover { background: #e84f20; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>Unsubscribed</h1>
    <p>You have been unsubscribed from <strong>${label}</strong> email notifications. You can re-enable this anytime from your notification preferences.</p>
    <a href="${config.APP_URL}/settings/notifications">Manage Preferences</a>
  </div>
</body>
</html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribe Error - Arda</title>
  <style>
    body { font-family: 'Open Sans', system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #0a0a0a; }
    .card { background: #fff; border-radius: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 40px; max-width: 480px; text-align: center; }
    h1 { font-size: 24px; font-weight: 600; margin: 0 0 12px; }
    p { font-size: 14px; color: #737373; line-height: 1.6; margin: 0 0 24px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    a { display: inline-block; background: #fc5a29; color: #fff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; }
    a:hover { background: #e84f20; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#9888;</div>
    <h1>Link Invalid or Expired</h1>
    <p>${message}</p>
    <a href="${config.APP_URL}/settings/notifications">Manage Preferences</a>
  </div>
</body>
</html>`;
}

// ─── Shared Unsubscribe Logic ───────────────────────────────────────

async function handleUnsubscribe(token: string | undefined): Promise<{ status: number; html: string }> {
  if (!token || typeof token !== 'string') {
    return {
      status: 400,
      html: errorHtml('No unsubscribe token was provided. Please use the link from your email.'),
    };
  }

  let payload;
  try {
    payload = verifyUnsubscribeToken(token);
  } catch (err) {
    log.warn({ err }, 'Invalid unsubscribe token');
    return {
      status: 400,
      html: errorHtml('This unsubscribe link is invalid or has expired. Please manage your notification preferences directly in the app.'),
    };
  }

  const { userId, tenantId, notificationType, channel } = payload;

  try {
    // Look up existing preference
    const existing = await db
      .select()
      .from(schema.notificationPreferences)
      .where(
        and(
          eq(schema.notificationPreferences.tenantId, tenantId),
          eq(schema.notificationPreferences.userId, userId),
          eq(
            schema.notificationPreferences.notificationType,
            notificationType as (typeof schema.notificationTypeEnum.enumValues)[number],
          ),
          eq(
            schema.notificationPreferences.channel,
            channel as (typeof schema.notificationChannelEnum.enumValues)[number],
          ),
        ),
      );

    if (existing.length > 0) {
      // Update existing preference — idempotent (already disabled is fine)
      if (existing[0].isEnabled) {
        await db
          .update(schema.notificationPreferences)
          .set({ isEnabled: false, updatedAt: new Date() })
          .where(eq(schema.notificationPreferences.id, existing[0].id));
        log.info({ userId, tenantId, notificationType, channel }, 'Email preference disabled via unsubscribe');
      } else {
        log.debug({ userId, tenantId, notificationType, channel }, 'Email preference already disabled');
      }
    } else {
      // Insert new preference row with isEnabled = false
      await db.insert(schema.notificationPreferences).values({
        tenantId,
        userId,
        notificationType: notificationType as (typeof schema.notificationTypeEnum.enumValues)[number],
        channel: channel as (typeof schema.notificationChannelEnum.enumValues)[number],
        isEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      log.info({ userId, tenantId, notificationType, channel }, 'Email preference created as disabled via unsubscribe');
    }

    return { status: 200, html: successHtml(notificationType) };
  } catch (err) {
    log.error({ err, userId, tenantId, notificationType }, 'Failed to update preference during unsubscribe');
    throw err;
  }
}

// ─── GET /unsubscribe?token=... ─────────────────────────────────────

unsubscribeRouter.get('/unsubscribe', async (req, res, next) => {
  try {
    const token = req.query.token as string | undefined;
    const result = await handleUnsubscribe(token);
    res.status(result.status).type('html').send(result.html);
  } catch (err) {
    next(err);
  }
});

// ─── POST /unsubscribe (RFC 8058 One-Click) ─────────────────────────

unsubscribeRouter.post('/unsubscribe', async (req, res, next) => {
  try {
    // RFC 8058 sends token in query string or request body
    const token = (req.query.token as string | undefined) ?? req.body?.token;
    const result = await handleUnsubscribe(token);
    res.status(result.status).type('html').send(result.html);
  } catch (err) {
    next(err);
  }
});
