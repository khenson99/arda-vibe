import { baseLayout, actionButton, resolveActionUrl, escapeHtml } from './base-layout.js';

export interface OrderStatusTemplateData {
  /** Order number, e.g. "WO-1001" or "TO-2001" */
  orderNumber: string;
  /** Order type label, e.g. "Work Order", "Transfer Order" */
  orderType: string;
  /** Previous status */
  fromStatus: string;
  /** New status */
  toStatus: string;
  /** Optional additional context */
  notes?: string;
  /** Relative action URL path */
  actionUrl: string;
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function renderOrderStatus(data: OrderStatusTemplateData): { subject: string; html: string } {
  const fullUrl = resolveActionUrl(data.actionUrl);
  const fromLabel = formatStatus(data.fromStatus);
  const toLabel = formatStatus(data.toStatus);

  const content = `
<h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#0a0a0a;">
  ${escapeHtml(data.orderType)} Status Update
</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
  <tr>
    <td style="padding:12px 16px;">
      <p style="margin:0 0 4px;font-size:13px;color:#737373;">Order</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:#0a0a0a;">${escapeHtml(data.orderNumber)}</p>
    </td>
    <td style="padding:12px 16px;">
      <p style="margin:0 0 4px;font-size:13px;color:#737373;">Status Change</p>
      <p style="margin:0;font-size:14px;color:#0a0a0a;">
        <span style="color:#737373;">${escapeHtml(fromLabel)}</span>
        &nbsp;&rarr;&nbsp;
        <strong>${escapeHtml(toLabel)}</strong>
      </p>
    </td>
  </tr>
</table>
${data.notes ? `<p style="margin:0 0 16px;font-size:14px;color:#0a0a0a;">${escapeHtml(data.notes)}</p>` : ''}
${actionButton('View Order', fullUrl)}`;

  return {
    subject: `[Arda] ${data.orderType} ${data.orderNumber} — ${toLabel}`,
    html: baseLayout({
      content,
      preheaderText: `${data.orderNumber} moved to ${toLabel}`,
    }),
  };
}
