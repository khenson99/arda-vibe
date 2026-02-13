import { baseLayout, actionButton, resolveActionUrl, escapeHtml } from './base-layout.js';

export interface SystemAlertTemplateData {
  /** Alert title */
  title: string;
  /** Alert message body */
  message: string;
  /** Severity level */
  severity?: 'info' | 'warning' | 'error';
  /** Relative action URL path (optional) */
  actionUrl?: string;
  /** Button label (defaults to "View Details") */
  actionLabel?: string;
}

const severityConfig: Record<string, { color: string; bg: string; icon: string }> = {
  info: { color: '#0a68f3', bg: '#eff6ff', icon: 'Info' },
  warning: { color: '#f59e0b', bg: '#fffbeb', icon: 'Warning' },
  error: { color: '#ef4444', bg: '#fef2f2', icon: 'Error' },
};

export function renderSystemAlert(data: SystemAlertTemplateData): { subject: string; html: string } {
  const severity = data.severity || 'info';
  const cfg = severityConfig[severity] || severityConfig.info;

  const content = `
<h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#0a0a0a;">
  System Alert
</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr>
    <td style="padding:12px;background-color:${cfg.bg};border-left:4px solid ${cfg.color};border-radius:4px;">
      <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#0a0a0a;">
        ${escapeHtml(data.title)}
      </p>
      <p style="margin:0;font-size:13px;color:#737373;">
        ${escapeHtml(data.message)}
      </p>
    </td>
  </tr>
</table>
${data.actionUrl ? actionButton(data.actionLabel || 'View Details', resolveActionUrl(data.actionUrl)) : ''}`;

  const prefix = severity === 'error' ? 'ALERT' : severity === 'warning' ? 'Warning' : 'Info';

  return {
    subject: `[Arda] ${prefix}: ${data.title}`,
    html: baseLayout({
      content,
      preheaderText: data.message.slice(0, 100),
    }),
  };
}
