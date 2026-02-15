import crypto from 'node:crypto';
import { google, type gmail_v1 } from 'googleapis';
import { config, createLogger } from '@arda/config';
import { db, schema } from '@arda/db';
import { eq, and } from 'drizzle-orm';

const log = createLogger('gmail-service');

// ─── Token Encryption ────────────────────────────────────────────────
// AES-256-GCM encryption for OAuth tokens at rest.
// KEY must be exactly 32 bytes (256 bits).

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = config.TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required for Gmail integration');
  }
  // Use SHA-256 to derive a consistent 32-byte key from the env string
  return crypto.createHash('sha256').update(key).digest();
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64)
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptToken(encryptedStr: string): string {
  const key = getEncryptionKey();
  const parts = encryptedStr.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }

  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}

// ─── OAuth2 Client ───────────────────────────────────────────────────

export function createOAuth2Client() {
  const clientId = config.GOOGLE_CLIENT_ID;
  const clientSecret = config.GOOGLE_CLIENT_SECRET;
  const redirectUri = config.GMAIL_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Gmail integration');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function getAuthUrl(): string {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPES,
    prompt: 'consent', // Always prompt to ensure refresh token is returned
  });
}

export interface OAuthTokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiry: Date | null;
  email: string | null;
  scopes: string[];
}

export async function exchangeCodeForTokens(code: string): Promise<OAuthTokenExchangeResult> {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('OAuth exchange did not return required tokens — user may need to re-authorize with consent prompt');
  }

  // Fetch the user's email address from the token info
  oauth2Client.setCredentials(tokens);
  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    email = userInfo.data.email ?? null;
  } catch (err) {
    log.warn({ err }, 'Could not fetch user email from Google — proceeding without it');
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    email,
    scopes: tokens.scope?.split(' ') ?? GMAIL_SCOPES,
  };
}

// ─── Token Storage ───────────────────────────────────────────────────

export async function storeOAuthTokens(
  userId: string,
  tenantId: string,
  tokens: OAuthTokenExchangeResult
): Promise<void> {
  const encryptedAccess = encryptToken(tokens.accessToken);
  const encryptedRefresh = encryptToken(tokens.refreshToken);

  // Upsert: if user already has tokens for this provider, update them
  const existing = await db
    .select({ id: schema.userOauthTokens.id })
    .from(schema.userOauthTokens)
    .where(
      and(
        eq(schema.userOauthTokens.userId, userId),
        eq(schema.userOauthTokens.provider, 'google')
      )
    );

  if (existing.length > 0) {
    await db
      .update(schema.userOauthTokens)
      .set({
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        tokenExpiry: tokens.expiry,
        scopes: tokens.scopes,
        email: tokens.email,
        isValid: true,
        updatedAt: new Date(),
      })
      .where(eq(schema.userOauthTokens.id, existing[0].id));
  } else {
    await db.insert(schema.userOauthTokens).values({
      userId,
      tenantId,
      provider: 'google',
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      tokenExpiry: tokens.expiry,
      scopes: tokens.scopes,
      email: tokens.email,
    });
  }
}

export async function getUserOAuthTokens(userId: string) {
  const rows = await db
    .select()
    .from(schema.userOauthTokens)
    .where(
      and(
        eq(schema.userOauthTokens.userId, userId),
        eq(schema.userOauthTokens.provider, 'google')
      )
    );

  return rows[0] ?? null;
}

export async function revokeUserTokens(userId: string): Promise<boolean> {
  const tokenRow = await getUserOAuthTokens(userId);
  if (!tokenRow) return false;

  // Attempt to revoke with Google
  try {
    const oauth2Client = createOAuth2Client();
    const accessToken = decryptToken(tokenRow.accessToken);
    oauth2Client.setCredentials({ access_token: accessToken });
    await oauth2Client.revokeToken(accessToken);
  } catch (err) {
    log.warn({ err }, 'Could not revoke token with Google — removing locally anyway');
  }

  await db
    .delete(schema.userOauthTokens)
    .where(
      and(
        eq(schema.userOauthTokens.userId, userId),
        eq(schema.userOauthTokens.provider, 'google')
      )
    );

  return true;
}

// ─── Authenticated Gmail Client ─────────────────────────────────────

async function getGmailClient(userId: string): Promise<gmail_v1.Gmail> {
  const tokenRow = await getUserOAuthTokens(userId);
  if (!tokenRow) {
    throw new GmailError('Gmail not connected — user must authorize first', 'GMAIL_NOT_CONNECTED');
  }
  if (!tokenRow.isValid) {
    throw new GmailError('Gmail tokens are invalid — user must re-authorize', 'GMAIL_TOKENS_INVALID');
  }

  const oauth2Client = createOAuth2Client();
  const accessToken = decryptToken(tokenRow.accessToken);
  const refreshToken = decryptToken(tokenRow.refreshToken);

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: tokenRow.tokenExpiry?.getTime(),
  });

  // Handle token refresh automatically
  oauth2Client.on('tokens', async (newTokens) => {
    try {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (newTokens.access_token) {
        updates.accessToken = encryptToken(newTokens.access_token);
      }
      if (newTokens.refresh_token) {
        updates.refreshToken = encryptToken(newTokens.refresh_token);
      }
      if (newTokens.expiry_date) {
        updates.tokenExpiry = new Date(newTokens.expiry_date);
      }

      await db
        .update(schema.userOauthTokens)
        .set(updates)
        .where(eq(schema.userOauthTokens.id, tokenRow.id));

      log.debug({ userId }, 'Gmail OAuth tokens refreshed and stored');
    } catch (err) {
      log.error({ err, userId }, 'Failed to persist refreshed Gmail tokens');
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ─── Email Sending ───────────────────────────────────────────────────

export class GmailError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'GmailError';
  }
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  mimeType: string;
}

export interface SendEmailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  messageId: string;
  threadId: string;
}

/**
 * Build a MIME message with optional attachments.
 * Uses multipart/mixed when attachments are present, multipart/alternative for text+HTML.
 */
export function buildMimeMessage(
  from: string,
  options: SendEmailOptions
): string {
  const boundary = `arda_${crypto.randomBytes(16).toString('hex')}`;
  const altBoundary = `arda_alt_${crypto.randomBytes(16).toString('hex')}`;

  const headers = [
    `From: ${from}`,
    `To: ${options.to.join(', ')}`,
  ];

  if (options.cc?.length) {
    headers.push(`Cc: ${options.cc.join(', ')}`);
  }
  if (options.bcc?.length) {
    headers.push(`Bcc: ${options.bcc.join(', ')}`);
  }
  headers.push(`Subject: ${options.subject}`);
  headers.push('MIME-Version: 1.0');

  const hasAttachments = options.attachments && options.attachments.length > 0;

  if (hasAttachments) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  } else if (options.htmlBody && options.textBody) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  } else if (options.htmlBody) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
  }

  const messageParts: string[] = [headers.join('\r\n'), ''];

  if (hasAttachments) {
    // Body part (text/html alternative inside mixed)
    if (options.textBody && options.htmlBody) {
      messageParts.push(`--${boundary}`);
      messageParts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      messageParts.push('');
      messageParts.push(`--${altBoundary}`);
      messageParts.push('Content-Type: text/plain; charset="UTF-8"');
      messageParts.push('');
      messageParts.push(options.textBody);
      messageParts.push(`--${altBoundary}`);
      messageParts.push('Content-Type: text/html; charset="UTF-8"');
      messageParts.push('');
      messageParts.push(options.htmlBody);
      messageParts.push(`--${altBoundary}--`);
    } else {
      messageParts.push(`--${boundary}`);
      if (options.htmlBody) {
        messageParts.push('Content-Type: text/html; charset="UTF-8"');
        messageParts.push('');
        messageParts.push(options.htmlBody);
      } else {
        messageParts.push('Content-Type: text/plain; charset="UTF-8"');
        messageParts.push('');
        messageParts.push(options.textBody ?? '');
      }
    }

    // Attachments
    for (const att of options.attachments!) {
      messageParts.push(`--${boundary}`);
      messageParts.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      messageParts.push('Content-Transfer-Encoding: base64');
      messageParts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      messageParts.push('');
      messageParts.push(att.content.toString('base64'));
    }
    messageParts.push(`--${boundary}--`);
  } else if (options.htmlBody && options.textBody) {
    messageParts.push(`--${altBoundary}`);
    messageParts.push('Content-Type: text/plain; charset="UTF-8"');
    messageParts.push('');
    messageParts.push(options.textBody);
    messageParts.push(`--${altBoundary}`);
    messageParts.push('Content-Type: text/html; charset="UTF-8"');
    messageParts.push('');
    messageParts.push(options.htmlBody);
    messageParts.push(`--${altBoundary}--`);
  } else {
    messageParts.push(options.htmlBody ?? options.textBody ?? '');
  }

  return messageParts.join('\r\n');
}

/**
 * Encode a MIME message to base64url (Gmail API format).
 */
export function encodeMimeToBase64Url(mimeMessage: string): string {
  return Buffer.from(mimeMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sendEmail(
  userId: string,
  options: SendEmailOptions
): Promise<SendEmailResult> {
  const gmail = await getGmailClient(userId);

  // Get the user's email from their stored tokens
  const tokenRow = await getUserOAuthTokens(userId);
  const fromEmail = tokenRow?.email ?? 'me';

  const mimeMessage = buildMimeMessage(fromEmail, options);
  const raw = encodeMimeToBase64Url(mimeMessage);

  try {
    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    if (!response.data.id) {
      throw new GmailError('Gmail API returned no message ID', 'GMAIL_SEND_FAILED');
    }

    log.info(
      { userId, messageId: response.data.id, threadId: response.data.threadId },
      'Email sent via Gmail'
    );

    return {
      messageId: response.data.id,
      threadId: response.data.threadId ?? response.data.id,
    };
  } catch (err: unknown) {
    // Handle specific Google API errors
    const googleErr = err as { code?: number; message?: string; errors?: Array<{ reason?: string }> };

    if (googleErr.code === 401 || googleErr.errors?.[0]?.reason === 'authError') {
      // Mark tokens as invalid so user is prompted to re-authorize
      await db
        .update(schema.userOauthTokens)
        .set({ isValid: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.userOauthTokens.userId, userId),
            eq(schema.userOauthTokens.provider, 'google')
          )
        );

      log.warn({ userId }, 'Gmail auth error — tokens marked invalid');
      throw new GmailError(
        'Gmail authorization expired — please reconnect your Gmail account',
        'GMAIL_AUTH_EXPIRED'
      );
    }

    if (googleErr.code === 429) {
      throw new GmailError(
        'Gmail rate limit exceeded — please try again later',
        'GMAIL_RATE_LIMITED'
      );
    }

    log.error({ err, userId }, 'Gmail send failed');
    throw new GmailError(
      `Failed to send email: ${googleErr.message ?? 'unknown error'}`,
      'GMAIL_SEND_FAILED'
    );
  }
}
