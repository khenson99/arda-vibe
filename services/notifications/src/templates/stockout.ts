import { baseLayout, actionButton, resolveActionUrl, escapeHtml } from './base-layout.js';

export interface StockoutTemplateData {
  /** Part name or identifier */
  partName: string;
  /** Risk level */
  riskLevel: 'medium' | 'high';
  /** How long the card has been in triggered state (hours) */
  triggeredAgeHours: number;
  /** Estimated days of supply remaining */
  estimatedDaysOfSupply: number;
  /** Human-readable reason for the alert */
  reason: string;
  /** Relative action URL path, e.g. "/queue?loopType=procurement" */
  actionUrl: string;
}

export function renderStockout(data: StockoutTemplateData): { subject: string; html: string } {
  const fullUrl = resolveActionUrl(data.actionUrl);
  const isHigh = data.riskLevel === 'high';
  const alertColor = isHigh ? '#dc2626' : '#f59e0b';
  const alertBg = isHigh ? '#fef2f2' : '#fffbeb';

  const content = `
<h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#0a0a0a;">
  Stockout Risk Alert
</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr>
    <td style="padding:12px;background-color:${alertBg};border-left:4px solid ${alertColor};border-radius:4px;">
      <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#0a0a0a;">
        ${escapeHtml(data.partName)}
      </p>
      <p style="margin:0;font-size:13px;color:#737373;">
        Risk Level: <strong style="color:${alertColor};">${escapeHtml(data.riskLevel.toUpperCase())}</strong>
      </p>
    </td>
  </tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
  <tr>
    <td style="padding:8px 0;">
      <p style="margin:0 0 4px;font-size:13px;color:#737373;">Triggered Age</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:#0a0a0a;">${data.triggeredAgeHours}h</p>
    </td>
    <td style="padding:8px 0;">
      <p style="margin:0 0 4px;font-size:13px;color:#737373;">Est. Days of Supply</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:#0a0a0a;">${data.estimatedDaysOfSupply.toFixed(1)}</p>
    </td>
  </tr>
</table>
<p style="margin:0 0 16px;font-size:14px;color:#0a0a0a;">
  ${escapeHtml(data.reason)}
</p>
${actionButton('View Queue', fullUrl)}`;

  return {
    subject: `[Arda] ${isHigh ? 'HIGH' : 'MEDIUM'} Stockout Risk: ${data.partName}`,
    html: baseLayout({
      content,
      preheaderText: `${data.riskLevel.toUpperCase()} stockout risk for ${data.partName}`,
    }),
  };
}
