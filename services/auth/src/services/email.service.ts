import nodemailer from 'nodemailer';
import { config } from '@arda/config';

interface PasswordResetEmailInput {
  toEmail: string;
  toName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

const hasSmtpCredentials = Boolean(config.SMTP_USER && config.SMTP_PASS);
const usingDefaultLocalSmtp =
  config.SMTP_HOST === 'localhost' &&
  config.SMTP_PORT === 1025 &&
  !hasSmtpCredentials;

let transport: nodemailer.Transporter | null = null;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      ...(hasSmtpCredentials
        ? {
            auth: {
              user: config.SMTP_USER,
              pass: config.SMTP_PASS,
            },
          }
        : {}),
    });
  }

  return transport;
}

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
  const subject = 'Reset your Arda password';
  const greetingName = input.toName?.trim() || 'there';
  const text = [
    `Hi ${greetingName},`,
    '',
    'We received a request to reset your Arda password.',
    `Use this link to set a new password: ${input.resetUrl}`,
    '',
    `This link expires in ${input.expiresInMinutes} minutes.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  if (usingDefaultLocalSmtp) {
    // In local/dev environments without configured SMTP, surface the reset link in logs.
    console.info('[auth-service] Password reset email not sent (default local SMTP).');
    console.info(`[auth-service] Reset URL for ${input.toEmail}: ${input.resetUrl}`);
    return;
  }

  await getTransport().sendMail({
    from: config.EMAIL_FROM,
    to: input.toEmail,
    subject,
    text,
    html: `
      <p>Hi ${escapeHtml(greetingName)},</p>
      <p>We received a request to reset your Arda password.</p>
      <p><a href="${escapeHtml(input.resetUrl)}">Reset password</a></p>
      <p>This link expires in ${input.expiresInMinutes} minutes.</p>
      <p>If you did not request this, you can ignore this email.</p>
    `,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
