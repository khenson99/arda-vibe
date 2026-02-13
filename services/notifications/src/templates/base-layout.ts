/**
 * Reusable HTML email base layout wrapper.
 *
 * All notification templates use this to wrap their content in a consistent
 * email structure with header, footer, and inline styles suitable for
 * major email clients.
 */

export interface BaseLayoutOptions {
  /** Main content HTML placed inside the body area */
  content: string;
  /** Optional footer text (defaults to standard Arda footer) */
  footerText?: string;
  /** Optional preview / pre-header text (hidden in the email body but shown in inbox previews) */
  preheaderText?: string;
}

export function baseLayout(options: BaseLayoutOptions): string {
  const { content, footerText, preheaderText } = options;

  const preheader = preheaderText
    ? `<span style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheaderText)}</span>`
    : '';

  const footer = footerText || 'You are receiving this because of your notification preferences in Arda.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Arda Notification</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td { font-family: Arial, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:'Open Sans',Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  ${preheader}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <!-- Main container -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5;">
          <!-- Header -->
          <tr>
            <td style="background-color:#0a0a0a;padding:16px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px;">
                    Arda
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:24px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e5e5e5;background-color:#fafafa;">
              <p style="margin:0;font-size:12px;line-height:18px;color:#737373;">
                ${escapeHtml(footer)}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Resolve a relative action path into a full URL using APP_URL.
 * Falls back to the path itself if APP_URL is not set.
 */
export function resolveActionUrl(path: string): string {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  // Strip trailing slash from base and ensure path starts with /
  const base = appUrl.replace(/\/+$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
}

/**
 * Render a "call to action" button block for emails.
 */
export function actionButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr>
    <td style="border-radius:8px;background-color:#fc5a29;">
      <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
        ${escapeHtml(label)}
      </a>
    </td>
  </tr>
</table>`;
}
