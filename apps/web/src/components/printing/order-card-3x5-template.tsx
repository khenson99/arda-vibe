import type { KanbanPrintData, FormatConfig, PrintTemplateProps } from './types';
import { fitText } from './text-fit';

const DEFAULT_ACCENT_COLOR = '#2F6FCC';
const PLACEHOLDER_BG = '#efefef';
const CARD_BG = '#eeeeee';

interface FieldRenderModel {
  key: string;
  label: string;
  value: string;
  iconSvg: string;
  fontSizePx: number;
}

interface OrderCard3x5LayoutModel {
  titleLines: string[];
  titleFontSizePx: number;
  skuLines: string[];
  skuFontSizePx: number;
  notesLines: string[];
  notesFontSizePx: number;
  fields: FieldRenderModel[];
  accentColor: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeColor(value: string | undefined): string {
  if (!value) return DEFAULT_ACCENT_COLOR;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{3}$/.test(trimmed)
    ? trimmed
    : DEFAULT_ACCENT_COLOR;
}

const ICON_SVGS = {
  minimum:
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>',
  location:
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  order:
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>',
  supplier:
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1 1 0 00.2 1.1l.1.1a1 1 0 010 1.4l-1 1a1 1 0 01-1.4 0l-.1-.1a1 1 0 00-1.1-.2 1 1 0 00-.6.9V20a1 1 0 01-1 1h-1.5a1 1 0 01-1-1v-.1a1 1 0 00-.6-.9 1 1 0 00-1.1.2l-.1.1a1 1 0 01-1.4 0l-1-1a1 1 0 010-1.4l.1-.1a1 1 0 00.2-1.1 1 1 0 00-.9-.6H4a1 1 0 01-1-1v-1.5a1 1 0 011-1h.1a1 1 0 00.9-.6 1 1 0 00-.2-1.1l-.1-.1a1 1 0 010-1.4l1-1a1 1 0 011.4 0l.1.1a1 1 0 001.1.2 1 1 0 00.6-.9V4a1 1 0 011-1h1.5a1 1 0 011 1v.1a1 1 0 00.6.9 1 1 0 001.1-.2l.1-.1a1 1 0 011.4 0l1 1a1 1 0 010 1.4l-.1.1a1 1 0 00-.2 1.1 1 1 0 00.9.6h.1a1 1 0 011 1V13a1 1 0 01-1 1h-.1a1 1 0 00-.9.6z"/></svg>',
};

function buildOrderCard3x5LayoutModel(data: KanbanPrintData, config: FormatConfig): OrderCard3x5LayoutModel {
  const accentColor = normalizeColor(data.accentColor);
  const titleSource = data.partDescription || data.partNumber || 'Untitled item';
  const titleFit = fitText({
    text: titleSource,
    containerWidthPx: config.widthPx - (config.safeInsetPx * 2) - config.qrSizePx - 10,
    containerHeightPx: 72,
    minFontSizePx: 18,
    maxFontSizePx: 45,
    lineHeight: 1.1,
    maxLines: 2,
  });

  const skuFit = fitText({
    text: data.sku || data.partNumber,
    containerWidthPx: config.widthPx - (config.safeInsetPx * 2) - config.qrSizePx - 10,
    containerHeightPx: 20,
    minFontSizePx: 11,
    maxFontSizePx: 15,
    lineHeight: 1.1,
    maxLines: 1,
  });

  const notesFit = fitText({
    text: data.notesText ?? '',
    containerWidthPx: config.widthPx - (config.safeInsetPx * 2),
    containerHeightPx: 28,
    minFontSizePx: 10,
    maxFontSizePx: 13,
    lineHeight: 1.2,
    maxLines: 2,
  });

  const fields: FieldRenderModel[] = [
    { key: 'minimum', label: 'Minimum', value: data.minimumText, iconSvg: ICON_SVGS.minimum, fontSizePx: 14 },
    { key: 'location', label: 'Location', value: data.locationText, iconSvg: ICON_SVGS.location, fontSizePx: 14 },
    { key: 'order', label: 'Order', value: data.orderText, iconSvg: ICON_SVGS.order, fontSizePx: 14 },
    { key: 'supplier', label: 'Supplier', value: data.supplierText, iconSvg: ICON_SVGS.supplier, fontSizePx: 14 },
  ].map((field) => {
    const fit = fitText({
      text: field.value || '',
      containerWidthPx: config.widthPx - (config.safeInsetPx * 2) - 40,
      containerHeightPx: 34,
      minFontSizePx: 11,
      maxFontSizePx: 22,
      lineHeight: 1.1,
      maxLines: 1,
    });
    return {
      ...field,
      value: fit.lines.join(' ').trim(),
      fontSizePx: fit.fontSizePx,
    };
  });

  return {
    titleLines: titleFit.lines,
    titleFontSizePx: titleFit.fontSizePx,
    skuLines: skuFit.lines,
    skuFontSizePx: skuFit.fontSizePx,
    notesLines: notesFit.lines,
    notesFontSizePx: notesFit.fontSizePx,
    fields,
    accentColor,
  };
}

function renderFieldRow(field: FieldRenderModel): string {
  return `
    <div style="display:flex;align-items:flex-start;gap:10px;margin-top:3px;">
      <div style="width:32px;display:flex;flex-direction:column;align-items:center;">
        ${field.iconSvg}
        <div style="margin-top:2px;font-size:8px;color:${DEFAULT_ACCENT_COLOR};line-height:1;">${escapeHtml(field.label)}</div>
      </div>
      <div style="flex:1;min-width:0;padding-top:1px;font-size:${field.fontSizePx}px;line-height:1.15;color:#222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${escapeHtml(field.value)}
      </div>
    </div>
  `;
}

export function renderOrderCard3x5Html(data: KanbanPrintData, config: FormatConfig): string {
  const model = buildOrderCard3x5LayoutModel(data, config);
  const titleHtml = model.titleLines.map((line) => escapeHtml(line)).join('<br/>');
  const skuHtml = model.skuLines.map((line) => escapeHtml(line)).join('<br/>');
  const notesHtml = model.notesLines.map((line) => escapeHtml(line)).join('<br/>');
  const imageHtml = data.imageUrl
    ? `<img src="${escapeHtml(data.imageUrl)}" alt="Item image" style="display:block;max-width:100%;max-height:100%;object-fit:contain;"/>`
    : `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:${PLACEHOLDER_BG};color:#8a8a8a;font-size:11px;">No image</div>`;

  return `
    <div class="print-card" style="position:relative;box-sizing:border-box;width:${config.widthPx}px;height:${config.heightPx}px;padding:${config.safeInsetPx}px;background:${CARD_BG};font-family:'Open Sans',Arial,sans-serif;border:1px solid #ddd;overflow:hidden;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:${model.titleFontSizePx}px;font-weight:700;line-height:1.1;color:#111;max-height:72px;overflow:hidden;">${titleHtml}</div>
          <div style="margin-top:3px;font-size:${model.skuFontSizePx}px;color:#595959;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${skuHtml}</div>
        </div>
        <div style="width:${config.qrSizePx}px;flex:0 0 ${config.qrSizePx}px;text-align:center;">
          <img src="${escapeHtml(data.qrCodeDataUrl)}" alt="QR Code" width="${config.qrSizePx}" height="${config.qrSizePx}" style="display:block;width:${config.qrSizePx}px;height:${config.qrSizePx}px;object-fit:contain;"/>
          <div style="margin-top:2px;font-size:10px;line-height:1;color:#222;">Arda</div>
        </div>
      </div>
      <div style="margin-top:8px;height:1px;background:${model.accentColor};"></div>

      <div style="margin-top:8px;">
        ${model.fields.map(renderFieldRow).join('')}
      </div>

      <div style="margin-top:10px;height:166px;display:flex;align-items:center;justify-content:center;">
        ${imageHtml}
      </div>

      <div style="margin-top:3px;height:22px;font-size:${model.notesFontSizePx}px;line-height:1.2;color:#7b7b7b;overflow:hidden;">
        ${notesHtml}
      </div>

      <div style="margin-top:6px;height:17px;background:${model.accentColor};"></div>
      <div style="margin-top:8px;text-align:center;font-size:15px;line-height:1;color:#e2e2e2;">Arda</div>
    </div>
  `;
}

export function OrderCard3x5Template({ data, config }: PrintTemplateProps) {
  return <div dangerouslySetInnerHTML={{ __html: renderOrderCard3x5Html(data, config) }} />;
}
