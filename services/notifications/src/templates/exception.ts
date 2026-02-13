import { baseLayout, actionButton, resolveActionUrl, escapeHtml } from './base-layout.js';

export interface ExceptionTemplateData {
  /** Human-readable exception type, e.g. "Short Shipment" */
  exceptionType: string;
  /** Severity level */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Number of units affected */
  quantityAffected: number;
  /** Related receipt or order identifier */
  referenceNumber: string;
  /** Optional additional details */
  details?: string;
  /** Relative action URL path, e.g. "/receiving/exceptions/exc-123" */
  actionUrl: string;
}

const severityColors: Record<string, string> = {
  low: '#22c55e',
  medium: '#f59e0b',
  high: '#ef4444',
  critical: '#dc2626',
};

export function renderException(data: ExceptionTemplateData): { subject: string; html: string } {
  const color = severityColors[data.severity] || severityColors.medium;
  const fullUrl = resolveActionUrl(data.actionUrl);

  const content = `
<h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#0a0a0a;">
  Exception Alert
</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr>
    <td style="padding:12px;background-color:#fef2f2;border-left:4px solid ${color};border-radius:4px;">
      <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#0a0a0a;">
        ${escapeHtml(data.exceptionType)}
      </p>
      <p style="margin:0;font-size:13px;color:#737373;">
        Severity: <strong style="color:${color};">${escapeHtml(data.severity.toUpperCase())}</strong>
        &nbsp;&bull;&nbsp; ${data.quantityAffected} unit(s) affected
        &nbsp;&bull;&nbsp; Ref: ${escapeHtml(data.referenceNumber)}
      </p>
    </td>
  </tr>
</table>
${data.details ? `<p style="margin:0 0 16px;font-size:14px;color:#0a0a0a;">${escapeHtml(data.details)}</p>` : ''}
${actionButton('View Exception', fullUrl)}`;

  return {
    subject: `[Arda] ${data.severity.toUpperCase()} Exception: ${data.exceptionType}`,
    html: baseLayout({
      content,
      preheaderText: `${data.exceptionType} — ${data.quantityAffected} unit(s) affected`,
    }),
  };
}
