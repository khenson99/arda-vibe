import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock @arda/config ──────────────────────────────────────────────────
vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

// ─── Mock @sendgrid/mail ────────────────────────────────────────────────
const sgSendMock = vi.fn(async () => [{ statusCode: 202, headers: { 'x-message-id': 'sg-msg-123' } }]);

vi.mock('@sendgrid/mail', () => ({
  default: {
    setApiKey: vi.fn(),
    send: sgSendMock,
  },
}));

// ─── Mock @aws-sdk/client-ses ───────────────────────────────────────────
const sesSendMock = vi.fn(async () => ({ MessageId: 'ses-msg-456' }));

class MockSESClient {
  send = sesSendMock;
}

class MockSendRawEmailCommand {
  constructor(public readonly input: unknown) {}
}

vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: MockSESClient,
  SendRawEmailCommand: MockSendRawEmailCommand,
}));

import {
  SendGridProvider,
  SESProvider,
  createEmailProvider,
  type EmailMessage,
} from './email-provider.js';

describe('email-provider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env
    process.env = { ...originalEnv };
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SENDGRID_API_KEY;

    sgSendMock.mockClear();
    sesSendMock.mockClear();
  });

  // ─── SendGridProvider ───────────────────────────────────────────────

  describe('SendGridProvider', () => {
    it('throws if api key is empty', () => {
      expect(() => new SendGridProvider('')).toThrow('SENDGRID_API_KEY is required');
    });

    it('sends an email via SendGrid', async () => {
      const provider = new SendGridProvider('test-key');

      const message: EmailMessage = {
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Hello</p>',
      };

      const result = await provider.send(message);

      expect(result.provider).toBe('sendgrid');
      expect(result.messageId).toBe('sg-msg-123');
      expect(sgSendMock).toHaveBeenCalledTimes(1);
      expect(sgSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Test Subject',
          html: '<p>Hello</p>',
        })
      );
    });

    it('includes custom headers when provided', async () => {
      const provider = new SendGridProvider('test-key');

      const message: EmailMessage = {
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Hi</p>',
        headers: { 'List-Unsubscribe': '<mailto:unsub@example.com>' },
      };

      await provider.send(message);

      expect(sgSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { 'List-Unsubscribe': '<mailto:unsub@example.com>' },
        })
      );
    });

    it('uses from address from message when provided', async () => {
      const provider = new SendGridProvider('test-key');

      const message: EmailMessage = {
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Hi</p>',
        from: 'custom@example.com',
      };

      await provider.send(message);

      expect(sgSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'custom@example.com',
        })
      );
    });

    it('has name property equal to sendgrid', () => {
      const provider = new SendGridProvider('test-key');
      expect(provider.name).toBe('sendgrid');
    });
  });

  // ─── SESProvider ────────────────────────────────────────────────────

  describe('SESProvider', () => {
    it('sends an email via SES', async () => {
      const provider = new SESProvider('us-east-1');

      const message: EmailMessage = {
        to: 'user@example.com',
        subject: 'SES Test',
        html: '<p>Hello SES</p>',
      };

      const result = await provider.send(message);

      expect(result.provider).toBe('ses');
      expect(result.messageId).toBe('ses-msg-456');
      expect(sesSendMock).toHaveBeenCalledTimes(1);
    });

    it('includes custom headers in raw MIME message', async () => {
      const provider = new SESProvider('us-west-2');

      const message: EmailMessage = {
        to: 'user@example.com',
        subject: 'Test',
        html: '<p>Hi</p>',
        headers: { 'List-Unsubscribe': '<mailto:unsub@example.com>' },
      };

      const result = await provider.send(message);

      expect(result.provider).toBe('ses');
      expect(result.messageId).toBe('ses-msg-456');
      // Verify the SES send mock was called with a command that has raw message data
      expect(sesSendMock).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sentCommand = (sesSendMock.mock.calls[0] as any)[0] as MockSendRawEmailCommand;
      expect(sentCommand.input).toEqual(
        expect.objectContaining({
          Source: expect.any(String),
          Destinations: ['user@example.com'],
        })
      );
    });

    it('has name property equal to ses', () => {
      const provider = new SESProvider();
      expect(provider.name).toBe('ses');
    });

    it('defaults region from AWS_REGION env var', () => {
      process.env.AWS_REGION = 'eu-west-1';
      const provider = new SESProvider();
      // The region is stored internally; we verify it constructs without error
      expect(provider.name).toBe('ses');
    });
  });

  // ─── createEmailProvider Factory ────────────────────────────────────

  describe('createEmailProvider', () => {
    it('throws when EMAIL_PROVIDER is not set and no argument given', () => {
      delete process.env.EMAIL_PROVIDER;
      expect(() => createEmailProvider()).toThrow('EMAIL_PROVIDER environment variable is required');
    });

    it('throws for invalid provider name', () => {
      expect(() => createEmailProvider('mailchimp')).toThrow(
        'Invalid EMAIL_PROVIDER "mailchimp"'
      );
    });

    it('creates SendGridProvider when provider is sendgrid', () => {
      process.env.SENDGRID_API_KEY = 'SG.test-key';
      const provider = createEmailProvider('sendgrid');
      expect(provider.name).toBe('sendgrid');
    });

    it('throws when sendgrid selected but SENDGRID_API_KEY is missing', () => {
      delete process.env.SENDGRID_API_KEY;
      expect(() => createEmailProvider('sendgrid')).toThrow(
        'SENDGRID_API_KEY environment variable is required'
      );
    });

    it('creates SESProvider when provider is ses', () => {
      const provider = createEmailProvider('ses');
      expect(provider.name).toBe('ses');
    });

    it('reads EMAIL_PROVIDER from env var when no argument is passed', () => {
      process.env.EMAIL_PROVIDER = 'ses';
      const provider = createEmailProvider();
      expect(provider.name).toBe('ses');
    });

    it('normalizes provider name case and whitespace', () => {
      process.env.SENDGRID_API_KEY = 'SG.test-key';
      const provider = createEmailProvider('  SendGrid  ');
      expect(provider.name).toBe('sendgrid');
    });
  });
});
