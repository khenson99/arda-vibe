import { createLogger } from '@arda/config';

const log = createLogger('email-provider');

// ─── Types ──────────────────────────────────────────────────────────────
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  from?: string;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  messageId: string;
  provider: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

// ─── SendGrid Provider ──────────────────────────────────────────────────
export class SendGridProvider implements EmailProvider {
  readonly name = 'sendgrid';

  private readonly apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('SENDGRID_API_KEY is required for SendGrid provider');
    }
    this.apiKey = apiKey;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    // Dynamic import keeps @sendgrid/mail isolated
    const sgMail = await import('@sendgrid/mail');
    const client = sgMail.default || sgMail;

    client.setApiKey(this.apiKey);

    const msg: Record<string, unknown> = {
      to: message.to,
      from: message.from || process.env.EMAIL_FROM || 'noreply@arda.cards',
      subject: message.subject,
      html: message.html,
    };

    if (message.headers && Object.keys(message.headers).length > 0) {
      msg.headers = message.headers;
    }

    const [response] = await client.send(msg as unknown as Parameters<typeof client.send>[0]);

    return {
      messageId: response?.headers?.['x-message-id'] || `sg-${Date.now()}`,
      provider: this.name,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * RFC 2047 encode a Subject header when it contains non-ASCII characters.
 * Uses Base64 ("B") encoding with UTF-8 charset.
 * ASCII-only subjects are returned unchanged.
 */
function encodeSubjectRfc2047(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(subject)) {
    const encoded = Buffer.from(subject, 'utf-8').toString('base64');
    return `=?UTF-8?B?${encoded}?=`;
  }
  return subject;
}

// ─── SES Provider ───────────────────────────────────────────────────────
export class SESProvider implements EmailProvider {
  readonly name = 'ses';

  private readonly region: string;

  constructor(region?: string) {
    this.region = region || process.env.AWS_REGION || 'us-east-1';
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    // Dynamic import keeps @aws-sdk/client-ses isolated
    const { SESClient, SendRawEmailCommand } = await import('@aws-sdk/client-ses');

    const client = new SESClient({ region: this.region });
    const from = message.from || process.env.EMAIL_FROM || 'noreply@arda.cards';

    // Build raw MIME message to support custom headers (e.g. List-Unsubscribe)
    const headerLines = [
      `From: ${from}`,
      `To: ${message.to}`,
      `Subject: ${encodeSubjectRfc2047(message.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
    ];

    if (message.headers) {
      for (const [key, value] of Object.entries(message.headers)) {
        headerLines.push(`${key}: ${value}`);
      }
    }

    const rawMessage = `${headerLines.join('\r\n')}\r\n\r\n${message.html}`;

    const command = new SendRawEmailCommand({
      RawMessage: { Data: new TextEncoder().encode(rawMessage) },
      Source: from,
      Destinations: [message.to],
    });

    const result = await client.send(command);

    return {
      messageId: result.MessageId || `ses-${Date.now()}`,
      provider: this.name,
    };
  }
}

// ─── Factory ────────────────────────────────────────────────────────────
export type EmailProviderName = 'sendgrid' | 'ses';

export function createEmailProvider(providerName?: string): EmailProvider {
  const name = providerName || process.env.EMAIL_PROVIDER;

  if (!name) {
    throw new Error(
      'EMAIL_PROVIDER environment variable is required. Valid values: sendgrid, ses'
    );
  }

  const normalized = name.toLowerCase().trim() as EmailProviderName;

  switch (normalized) {
    case 'sendgrid': {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (!apiKey) {
        throw new Error('SENDGRID_API_KEY environment variable is required for SendGrid provider');
      }
      log.info({ provider: normalized }, 'Email provider selected');
      return new SendGridProvider(apiKey);
    }

    case 'ses': {
      const region = process.env.AWS_REGION;
      log.info({ provider: normalized, region }, 'Email provider selected');
      return new SESProvider(region);
    }

    default:
      throw new Error(
        `Invalid EMAIL_PROVIDER "${name}". Valid values: sendgrid, ses`
      );
  }
}
