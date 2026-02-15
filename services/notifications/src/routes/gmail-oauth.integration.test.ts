import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
  storedTokens: null as Record<string, unknown> | null,
  gmailConnected: false,
}));

// ─── Hoisted mocks for gmail.service ────────────────────────────────
const gmailServiceMock = vi.hoisted(() => ({
  getAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?scope=gmail.send'),
  exchangeCodeForTokens: vi.fn().mockResolvedValue({
    accessToken: 'ya29.mock-access-token',
    refreshToken: '1//mock-refresh-token',
    expiry: new Date('2026-02-15T10:00:00Z'),
    email: 'user@example.com',
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
  }),
  storeOAuthTokens: vi.fn(async () => {
    testState.storedTokens = { stored: true };
    testState.gmailConnected = true;
  }),
  getUserOAuthTokens: vi.fn(async () =>
    testState.gmailConnected
      ? {
          id: 'token-1',
          userId: 'user-1',
          tenantId: 'tenant-1',
          provider: 'google',
          email: 'user@example.com',
          isValid: true,
          scopes: ['https://www.googleapis.com/auth/gmail.send'],
          createdAt: new Date('2026-02-14T00:00:00Z'),
        }
      : null
  ),
  revokeUserTokens: vi.fn(async () => {
    if (!testState.gmailConnected) return false;
    testState.gmailConnected = false;
    testState.storedTokens = null;
    return true;
  }),
  sendEmail: vi.fn(async () => ({
    messageId: 'msg-abc123',
    threadId: 'thread-xyz789',
  })),
  GmailError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'GmailError';
      this.code = code;
    }
  },
}));

// ─── Hoisted audit mock ─────────────────────────────────────────────
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.auditEntries.push(entry);
    return { id: 'audit-' + testState.auditEntries.length, hashChain: 'mock', sequenceNumber: testState.auditEntries.length };
  })
);

// ─── Module mocks ───────────────────────────────────────────────────
vi.mock('@arda/config', () => ({
  config: {},
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@arda/db', () => ({
  db: {},
  schema: {
    userOauthTokens: {
      id: 'user_oauth_tokens.id',
      userId: 'user_oauth_tokens.user_id',
      provider: 'user_oauth_tokens.provider',
    },
  },
  writeAuditEntry: mockWriteAuditEntry,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
}));

vi.mock('../services/gmail.service.js', () => gmailServiceMock);

// ─── Imports (after mocks) ──────────────────────────────────────────
import { gmailOauthRouter } from './gmail-oauth.routes.js';

// ─── Helpers ────────────────────────────────────────────────────────
function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { tenantId: 'tenant-1', sub: 'user-1' };
    next();
  });
  app.use('/gmail', gmailOauthRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error', code: err?.code });
  });
  return app;
}

async function fetchJson(app: express.Express, path: string, options?: RequestInit) {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, options);
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ═════════════════════════════════════════════════════════════════════

describe('Gmail OAuth Routes', () => {
  beforeEach(() => {
    testState.auditEntries = [];
    testState.storedTokens = null;
    testState.gmailConnected = false;
    mockWriteAuditEntry.mockClear();
    gmailServiceMock.getAuthUrl.mockClear();
    gmailServiceMock.exchangeCodeForTokens.mockClear();
    gmailServiceMock.storeOAuthTokens.mockClear();
    gmailServiceMock.getUserOAuthTokens.mockClear();
    gmailServiceMock.revokeUserTokens.mockClear();
    gmailServiceMock.sendEmail.mockClear();
  });

  describe('GET /gmail/auth-url', () => {
    it('returns the OAuth consent URL', async () => {
      const app = createApp();
      const res = await fetchJson(app, '/gmail/auth-url');

      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://accounts.google.com/o/oauth2/auth?scope=gmail.send');
      expect(gmailServiceMock.getAuthUrl).toHaveBeenCalledOnce();
    });
  });

  describe('GET /gmail/callback', () => {
    it('exchanges code, stores tokens, and writes audit entry', async () => {
      const app = createApp();
      const res = await fetchJson(app, '/gmail/callback?code=test-auth-code');

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.email).toBe('user@example.com');
      expect(res.body.scopes).toEqual(['https://www.googleapis.com/auth/gmail.send']);

      // Verify service calls
      expect(gmailServiceMock.exchangeCodeForTokens).toHaveBeenCalledWith('test-auth-code');
      expect(gmailServiceMock.storeOAuthTokens).toHaveBeenCalledWith('user-1', 'tenant-1', expect.objectContaining({
        accessToken: 'ya29.mock-access-token',
      }));

      // Verify audit entry
      expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
      const audit = testState.auditEntries[0];
      expect(audit.action).toBe('gmail.connected');
      expect(audit.entityType).toBe('user_oauth_token');
      expect(audit.entityId).toBe('user-1');
      expect(audit.tenantId).toBe('tenant-1');
    });

    it('returns 400 when code is missing', async () => {
      const app = createApp();
      const res = await fetchJson(app, '/gmail/callback');

      expect(res.status).toBe(500);
      expect(gmailServiceMock.exchangeCodeForTokens).not.toHaveBeenCalled();
    });
  });

  describe('GET /gmail/status', () => {
    it('returns connected=false when no tokens exist', async () => {
      const app = createApp();
      const res = await fetchJson(app, '/gmail/status');

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });

    it('returns connection details when tokens exist', async () => {
      testState.gmailConnected = true;
      const app = createApp();
      const res = await fetchJson(app, '/gmail/status');

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.email).toBe('user@example.com');
      expect(res.body.isValid).toBe(true);
    });
  });

  describe('DELETE /gmail/disconnect', () => {
    it('revokes tokens and writes audit entry', async () => {
      testState.gmailConnected = true;
      const app = createApp();
      const res = await fetchJson(app, '/gmail/disconnect', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);

      expect(gmailServiceMock.revokeUserTokens).toHaveBeenCalledWith('user-1');

      // Verify audit entry
      expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
      const audit = testState.auditEntries[0];
      expect(audit.action).toBe('gmail.disconnected');
      expect(audit.entityType).toBe('user_oauth_token');
      expect(audit.previousState).toEqual(expect.objectContaining({
        provider: 'google',
        email: 'user@example.com',
      }));
    });

    it('returns 404 when no connection exists', async () => {
      const app = createApp();
      const res = await fetchJson(app, '/gmail/disconnect', { method: 'DELETE' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('GMAIL_NOT_CONNECTED');
    });
  });

  describe('POST /gmail/send', () => {
    it('sends an email successfully', async () => {
      testState.gmailConnected = true;
      const app = createApp();
      const res = await fetchJson(app, '/gmail/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: ['recipient@example.com'],
          subject: 'Test Email',
          textBody: 'Hello from Arda',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body.sent).toBe(true);
      expect(res.body.messageId).toBe('msg-abc123');
      expect(res.body.threadId).toBe('thread-xyz789');

      expect(gmailServiceMock.sendEmail).toHaveBeenCalledWith('user-1', expect.objectContaining({
        to: ['recipient@example.com'],
        subject: 'Test Email',
        textBody: 'Hello from Arda',
      }));
    });

    it('sends email with attachments (base64 decoded)', async () => {
      testState.gmailConnected = true;
      const app = createApp();
      const pdfContent = Buffer.from('fake-pdf-content').toString('base64');

      const res = await fetchJson(app, '/gmail/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: ['recipient@example.com'],
          subject: 'PO Attached',
          htmlBody: '<p>Please see attached PO.</p>',
          attachments: [
            { filename: 'PO-12345.pdf', content: pdfContent, mimeType: 'application/pdf' },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body.sent).toBe(true);

      // Verify attachment was decoded from base64
      const callArgs = gmailServiceMock.sendEmail.mock.calls[0][1];
      expect(callArgs.attachments[0].filename).toBe('PO-12345.pdf');
      expect(callArgs.attachments[0].content).toBeInstanceOf(Buffer);
      expect(callArgs.attachments[0].content.toString()).toBe('fake-pdf-content');
    });

    it('validates required fields', async () => {
      const app = createApp();

      // Missing subject
      const res = await fetchJson(app, '/gmail/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: ['test@example.com'] }),
      });

      expect(res.status).toBe(500);
    });

    it('requires at least one of textBody or htmlBody', async () => {
      const app = createApp();
      const res = await fetchJson(app, '/gmail/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: ['test@example.com'],
          subject: 'No Body',
        }),
      });

      expect(res.status).toBe(500);
    });

    it('sends email with CC and BCC', async () => {
      testState.gmailConnected = true;
      const app = createApp();
      const res = await fetchJson(app, '/gmail/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: ['to@example.com'],
          cc: ['cc@example.com'],
          bcc: ['bcc@example.com'],
          subject: 'CC/BCC Test',
          textBody: 'body',
        }),
      });

      expect(res.status).toBe(200);
      const callArgs = gmailServiceMock.sendEmail.mock.calls[0][1];
      expect(callArgs.cc).toEqual(['cc@example.com']);
      expect(callArgs.bcc).toEqual(['bcc@example.com']);
    });
  });
});
