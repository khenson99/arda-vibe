import { baseLayout, actionButton, resolveActionUrl, escapeHtml } from './base-layout.js';

export interface DigestItem {
  /** Notification type for grouping */
  type: string;
  /** Title of the notification */
  title: string;
  /** Body / summary text */
  body: string;
  /** Relative action URL path */
  actionUrl?: string;
  /** Timestamp string */
  timestamp: string;
}

export interface DigestTemplateData {
  /** Recipient name for personalization */
  recipientName?: string;
  /** Digest period label, e.g. "Daily" or "Weekly" */
  period: string;
  /** Grouped notification items */
  items: DigestItem[];
  /** Relative URL for viewing all notifications */
  allNotificationsUrl?: string;
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return ts;
  }
}

function renderDigestItem(item: DigestItem): string {
  const timeLabel = formatTimestamp(item.timestamp);
  const link = item.actionUrl
    ? `<a href="${escapeHtml(resolveActionUrl(item.actionUrl))}" style="color:#0a68f3;font-weight:600;text-decoration:none;font-size:13px;">View &rarr;</a>`
    : '';

  return `<tr>
  <td style="padding:12px 0;border-bottom:1px solid #f0f0f0;">
    <p style="margin:0 0 2px;font-size:14px;font-weight:600;color:#0a0a0a;">${escapeHtml(item.title)}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#737373;">${escapeHtml(item.body)}</p>
    <p style="margin:0;font-size:12px;color:#a3a3a3;">
      ${escapeHtml(timeLabel)}
      ${link ? `&nbsp;&bull;&nbsp;${link}` : ''}
    </p>
  </td>
</tr>`;
}

export function renderDigest(data: DigestTemplateData): { subject: string; html: string } {
  const greeting = data.recipientName
    ? `Hi ${escapeHtml(data.recipientName)},`
    : 'Hi,';

  const itemRows = data.items.map(renderDigestItem).join('');
  const allUrl = resolveActionUrl(data.allNotificationsUrl || '/notifications');

  const content = `
<p style="margin:0 0 8px;font-size:14px;color:#0a0a0a;">${greeting}</p>
<p style="margin:0 0 16px;font-size:14px;color:#737373;">
  Here is your ${escapeHtml(data.period.toLowerCase())} notification digest. You have
  <strong style="color:#0a0a0a;">${data.items.length}</strong> notification${data.items.length === 1 ? '' : 's'}.
</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  ${itemRows}
</table>
${actionButton('View All Notifications', allUrl)}`;

  return {
    subject: `[Arda] Your ${data.period} Digest — ${data.items.length} notification${data.items.length === 1 ? '' : 's'}`,
    html: baseLayout({
      content,
      preheaderText: `${data.items.length} notification${data.items.length === 1 ? '' : 's'} in your ${data.period.toLowerCase()} digest`,
    }),
  };
}
