import { baseLayout, actionButton, resolveActionUrl, escapeHtml } from './base-layout.js';

export type POLifecycleStatus = 'created' | 'approved' | 'sent' | 'received' | 'partially_received' | 'cancelled';

export interface POLifecycleTemplateData {
  /** PO number, e.g. "PO-1001" */
  orderNumber: string;
  /** Current lifecycle status */
  status: POLifecycleStatus;
  /** Supplier name (optional) */
  supplierName?: string;
  /** Number of linked cards (optional) */
  linkedCardCount?: number;
  /** Optional notes */
  notes?: string;
  /** Relative action URL path, e.g. "/orders/po-123" */
  actionUrl: string;
}

const statusLabels: Record<POLifecycleStatus, string> = {
  created: 'Created',
  approved: 'Approved',
  sent: 'Sent to Supplier',
  received: 'Received',
  partially_received: 'Partially Received',
  cancelled: 'Cancelled',
};

const statusColors: Record<POLifecycleStatus, string> = {
  created: '#0a68f3',
  approved: '#22c55e',
  sent: '#8b5cf6',
  received: '#22c55e',
  partially_received: '#f59e0b',
  cancelled: '#ef4444',
};

export function renderPOLifecycle(data: POLifecycleTemplateData): { subject: string; html: string } {
  const fullUrl = resolveActionUrl(data.actionUrl);
  const label = statusLabels[data.status] || data.status;
  const color = statusColors[data.status] || '#737373';

  const content = `
<h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#0a0a0a;">
  Purchase Order ${escapeHtml(label)}
</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
  <tr>
    <td style="padding:12px 16px;border-bottom:1px solid #e5e5e5;">
      <p style="margin:0 0 4px;font-size:13px;color:#737373;">Order Number</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:#0a0a0a;">${escapeHtml(data.orderNumber)}</p>
    </td>
    <td style="padding:12px 16px;border-bottom:1px solid #e5e5e5;">
      <p style="margin:0 0 4px;font-size:13px;color:#737373;">Status</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:${color};">${escapeHtml(label)}</p>
    </td>
  </tr>
  ${data.supplierName || data.linkedCardCount !== undefined ? `<tr>
    ${data.supplierName ? `<td style="padding:12px 16px;">
      <p style="margin:0 0 4px;font-size:13px;color:#737373;">Supplier</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:#0a0a0a;">${escapeHtml(data.supplierName)}</p>
    </td>` : '<td></td>'}
    ${data.linkedCardCount !== undefined ? `<td style="padding:12px 16px;">
      <p style="margin:0 0 4px;font-size:13px;color:#737373;">Linked Cards</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:#0a0a0a;">${data.linkedCardCount}</p>
    </td>` : '<td></td>'}
  </tr>` : ''}
</table>
${data.notes ? `<p style="margin:0 0 16px;font-size:14px;color:#0a0a0a;">${escapeHtml(data.notes)}</p>` : ''}
${actionButton('View Purchase Order', fullUrl)}`;

  return {
    subject: `[Arda] PO ${data.orderNumber} — ${label}`,
    html: baseLayout({
      content,
      preheaderText: `Purchase Order ${data.orderNumber} is now ${label}`,
    }),
  };
}
