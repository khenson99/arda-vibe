import { Resend } from 'resend';
import { config } from '@arda/config';

interface PasswordResetEmailInput {
  toEmail: string;
  toName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

// Re-use the existing SMTP_PASS which is already a Resend API key (re_…)
const resendApiKey = config.SMTP_PASS;
const usingDefaultLocalSmtp =
  config.SMTP_HOST === 'localhost' &&
  config.SMTP_PORT === 1025 &&
  !resendApiKey;

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    resend = new Resend(resendApiKey);
  }
  return resend;
}

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
  const greetingName = input.toName?.trim() || 'there';

  if (usingDefaultLocalSmtp) {
    // In local/dev environments without configured SMTP, surface the reset link in logs.
    console.info('[auth-service] Password reset email not sent (default local SMTP).');
    console.info(`[auth-service] Reset URL for ${input.toEmail}: ${input.resetUrl}`);
    return;
  }

  const { error } = await getResend().emails.send({
    from: config.EMAIL_FROM,
    to: input.toEmail,
    subject: 'Reset your Arda password',
    text: [
      `Hi ${greetingName},`,
      '',
      'We received a request to reset your Arda password.',
      `Use this link to set a new password: ${input.resetUrl}`,
      '',
      `This link expires in ${input.expiresInMinutes} minutes.`,
      '',
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `
      <p>Hi ${escapeHtml(greetingName)},</p>
      <p>We received a request to reset your Arda password.</p>
      <p><a href="${escapeHtml(input.resetUrl)}">Reset password</a></p>
      <p>This link expires in ${input.expiresInMinutes} minutes.</p>
      <p>If you did not request this, you can ignore this email.</p>
    `,
  });

  if (error) {
    throw new Error(`Failed to send password reset email: ${error.message}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
