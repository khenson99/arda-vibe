import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Mock config before importing service ────────────────────────────
vi.mock('@arda/config', () => ({
  config: {
    TOKEN_ENCRYPTION_KEY: 'test-encryption-key-that-is-at-least-32-chars-long',
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GMAIL_REDIRECT_URI: 'http://localhost:5173/gmail/callback',
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@arda/db', () => ({
  db: {},
  schema: {
    userOauthTokens: {
      id: 'user_oauth_tokens.id',
      userId: 'user_oauth_tokens.user_id',
      tenantId: 'user_oauth_tokens.tenant_id',
      provider: 'user_oauth_tokens.provider',
      accessToken: 'user_oauth_tokens.access_token',
      refreshToken: 'user_oauth_tokens.refresh_token',
      tokenExpiry: 'user_oauth_tokens.token_expiry',
      scopes: 'user_oauth_tokens.scopes',
      email: 'user_oauth_tokens.email',
      isValid: 'user_oauth_tokens.is_valid',
      createdAt: 'user_oauth_tokens.created_at',
      updatedAt: 'user_oauth_tokens.updated_at',
    },
  },
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'mock', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?test=1'),
        getToken: vi.fn(),
        setCredentials: vi.fn(),
        revokeToken: vi.fn(),
        on: vi.fn(),
      })),
    },
    oauth2: vi.fn(),
    gmail: vi.fn(),
  },
}));

import {
  encryptToken,
  decryptToken,
  buildMimeMessage,
  encodeMimeToBase64Url,
  GmailError,
  type SendEmailOptions,
} from './gmail.service.js';

// ═════════════════════════════════════════════════════════════════════

describe('Gmail Service — Token Encryption', () => {
  it('encrypts and decrypts a token round-trip', () => {
    const original = 'ya29.test-access-token-value';
    const encrypted = encryptToken(original);

    // Encrypted should not equal the original
    expect(encrypted).not.toBe(original);

    // Should contain 3 base64 parts separated by colons (iv:authTag:ciphertext)
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);

    // Decrypt should return original
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(original);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const token = 'test-token';
    const encrypted1 = encryptToken(token);
    const encrypted2 = encryptToken(token);

    // Different IVs = different ciphertexts
    expect(encrypted1).not.toBe(encrypted2);

    // Both decrypt to the same value
    expect(decryptToken(encrypted1)).toBe(token);
    expect(decryptToken(encrypted2)).toBe(token);
  });

  it('handles empty string', () => {
    const encrypted = encryptToken('');
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe('');
  });

  it('handles long tokens', () => {
    const longToken = 'a'.repeat(2000);
    const encrypted = encryptToken(longToken);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(longToken);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encryptToken('test-token');
    const parts = encrypted.split(':');
    // Tamper with the ciphertext
    parts[2] = Buffer.from('tampered').toString('base64');
    const tampered = parts.join(':');

    expect(() => decryptToken(tampered)).toThrow();
  });

  it('throws on invalid format', () => {
    expect(() => decryptToken('not-valid-format')).toThrow('Invalid encrypted token format');
  });
});

describe('Gmail Service — MIME Message Building', () => {
  it('builds a plain text email', () => {
    const opts: SendEmailOptions = {
      to: ['alice@example.com'],
      subject: 'Test Subject',
      textBody: 'Hello World',
    };

    const mime = buildMimeMessage('sender@example.com', opts);

    expect(mime).toContain('From: sender@example.com');
    expect(mime).toContain('To: alice@example.com');
    expect(mime).toContain('Subject: Test Subject');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Hello World');
  });

  it('builds an HTML-only email', () => {
    const opts: SendEmailOptions = {
      to: ['bob@example.com'],
      subject: 'HTML Email',
      htmlBody: '<h1>Hello</h1>',
    };

    const mime = buildMimeMessage('sender@example.com', opts);

    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).toContain('<h1>Hello</h1>');
  });

  it('builds a multipart/alternative email with text + HTML', () => {
    const opts: SendEmailOptions = {
      to: ['charlie@example.com'],
      subject: 'Mixed Content',
      textBody: 'Plain text version',
      htmlBody: '<p>HTML version</p>',
    };

    const mime = buildMimeMessage('sender@example.com', opts);

    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Plain text version');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).toContain('<p>HTML version</p>');
  });

  it('includes CC and BCC headers', () => {
    const opts: SendEmailOptions = {
      to: ['to@example.com'],
      cc: ['cc1@example.com', 'cc2@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'CC Test',
      textBody: 'body',
    };

    const mime = buildMimeMessage('sender@example.com', opts);

    expect(mime).toContain('Cc: cc1@example.com, cc2@example.com');
    expect(mime).toContain('Bcc: bcc@example.com');
  });

  it('supports multiple To recipients', () => {
    const opts: SendEmailOptions = {
      to: ['a@example.com', 'b@example.com', 'c@example.com'],
      subject: 'Multi To',
      textBody: 'body',
    };

    const mime = buildMimeMessage('sender@example.com', opts);

    expect(mime).toContain('To: a@example.com, b@example.com, c@example.com');
  });

  it('builds a multipart/mixed email with attachments', () => {
    const opts: SendEmailOptions = {
      to: ['dave@example.com'],
      subject: 'With Attachment',
      textBody: 'See attached',
      attachments: [
        {
          filename: 'report.pdf',
          content: Buffer.from('fake-pdf-content'),
          mimeType: 'application/pdf',
        },
      ],
    };

    const mime = buildMimeMessage('sender@example.com', opts);

    expect(mime).toContain('Content-Type: multipart/mixed');
    expect(mime).toContain('Content-Type: application/pdf; name="report.pdf"');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(mime).toContain(Buffer.from('fake-pdf-content').toString('base64'));
  });

  it('builds email with text + HTML + attachment', () => {
    const opts: SendEmailOptions = {
      to: ['eve@example.com'],
      subject: 'Full Email',
      textBody: 'Plain text',
      htmlBody: '<p>HTML</p>',
      attachments: [
        {
          filename: 'doc.txt',
          content: Buffer.from('hello'),
          mimeType: 'text/plain',
        },
      ],
    };

    const mime = buildMimeMessage('sender@example.com', opts);

    // Should be multipart/mixed (outer) with multipart/alternative (inner)
    expect(mime).toContain('Content-Type: multipart/mixed');
    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Plain text');
    expect(mime).toContain('<p>HTML</p>');
    expect(mime).toContain('Content-Disposition: attachment; filename="doc.txt"');
  });

  it('includes MIME-Version header', () => {
    const opts: SendEmailOptions = {
      to: ['test@example.com'],
      subject: 'MIME Check',
      textBody: 'body',
    };

    const mime = buildMimeMessage('sender@example.com', opts);
    expect(mime).toContain('MIME-Version: 1.0');
  });
});

describe('Gmail Service — Base64URL Encoding', () => {
  it('converts MIME message to base64url', () => {
    const message = 'From: test@example.com\r\nTo: to@example.com\r\nSubject: Test\r\n\r\nBody';
    const encoded = encodeMimeToBase64Url(message);

    // Should not contain + / = (standard base64 chars)
    expect(encoded).not.toMatch(/[+/=]/);

    // Should be decodable back
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    expect(decoded).toBe(message);
  });
});

describe('Gmail Service — GmailError', () => {
  it('creates error with code', () => {
    const err = new GmailError('Test error', 'GMAIL_SEND_FAILED');
    expect(err.message).toBe('Test error');
    expect(err.code).toBe('GMAIL_SEND_FAILED');
    expect(err.name).toBe('GmailError');
    expect(err).toBeInstanceOf(Error);
  });
});
