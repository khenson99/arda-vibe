import jwt from 'jsonwebtoken';
import { createLogger } from '@arda/config';

const log = createLogger('unsubscribe-token');

export interface UnsubscribeTokenPayload {
  userId: string;
  tenantId: string;
  notificationType: string;
  channel: 'email'; // always email for unsubscribe
}

const TOKEN_EXPIRY = '30d'; // 30-day expiry
const TOKEN_ISSUER = 'arda-notifications';

function getUnsubscribeSecret(): string {
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('UNSUBSCRIBE_TOKEN_SECRET must be set (min 32 chars)');
  }
  return secret;
}

export function generateUnsubscribeToken(payload: UnsubscribeTokenPayload): string {
  return jwt.sign(payload, getUnsubscribeSecret(), {
    expiresIn: TOKEN_EXPIRY,
    issuer: TOKEN_ISSUER,
  });
}

export function verifyUnsubscribeToken(token: string): UnsubscribeTokenPayload {
  const decoded = jwt.verify(token, getUnsubscribeSecret(), {
    issuer: TOKEN_ISSUER,
  }) as UnsubscribeTokenPayload;

  log.debug({ userId: decoded.userId, notificationType: decoded.notificationType }, 'Unsubscribe token verified');
  return decoded;
}

export function buildUnsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function buildUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
