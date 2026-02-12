import type { CardTemplateBindingToken, CardTemplateDefinition, CardTemplateElement } from '@arda/shared-types';
import type { KanbanPrintData, FormatConfig } from '../types';
import { normalizeUrl, renderIconMarkup } from './icon-library';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function normalizeImageUrl(value?: string): string | null {
  return normalizeUrl(value);
}

export function resolveBindingToken(token: CardTemplateBindingToken, data: KanbanPrintData): string {
  switch (token) {
    case 'title':
      return data.partDescription || data.partNumber;
    case 'itemName':
      return data.partDescription || data.partNumber;
    case 'sku':
      return data.sku || data.partNumber;
    case 'partNumberText':
      return data.partNumber || '';
    case 'minimumText':
      return data.minimumText || '';
    case 'locationText':
      return data.locationText || '';
    case 'orderText':
      return data.orderText || '';
    case 'supplierText':
      return data.supplierText || '';
    case 'supplierNameText':
      return data.supplierName || '';
    case 'unitPriceText':
      return data.unitPriceText || '';
    case 'orderQuantityValue':
      return data.orderQuantityValue || '';
    case 'orderUnitsText':
      return data.orderUnitsText || '';
    case 'minQuantityValue':
      return data.minQuantityValue || '';
    case 'minUnitsText':
      return data.minUnitsText || '';
    case 'cardsCountText':
      return data.cardsCountText || '';
    case 'orderMethodText':
      return data.orderMethodText || '';
    case 'itemLocationText':
      return data.itemLocationText || '';
    case 'statusText':
      return data.statusText || '';
    case 'updatedAtText':
      return data.updatedAtText || '';
    case 'glCodeText':
      return data.glCodeText || '';
    case 'itemTypeText':
      return data.itemTypeText || '';
    case 'itemSubtypeText':
      return data.itemSubtypeText || '';
    case 'uomText':
      return data.uomText || '';
    case 'facilityNameText':
      return data.facilityName || '';
    case 'sourceFacilityNameText':
      return data.sourceFacilityName || '';
    case 'storageLocationText':
      return data.storageLocation || '';
    case 'scanUrlText':
      return data.scanUrl || '';
    case 'notesText':
      return data.notesText || '';
    case 'imageUrl':
      return data.imageUrl || '';
    case 'qrCodeDataUrl':
      return data.qrCodeDataUrl || '';
    default:
      return '';
  }
}

function styleForElement(element: CardTemplateElement): string {
  const style = element.style ?? {};
  const declarations = [
    `position:absolute`,
    `left:${element.x}px`,
    `top:${element.y}px`,
    `width:${element.w}px`,
    `height:${element.h}px`,
    `z-index:${element.z}`,
    `box-sizing:border-box`,
    `overflow:hidden`,
  ];

  if (typeof element.rotation === 'number' && element.rotation !== 0) {
    declarations.push(`transform:rotate(${element.rotation}deg)`);
    declarations.push('transform-origin:center center');
  }
  if (style.fontFamily) declarations.push(`font-family:${style.fontFamily}`);
  if (style.fontSize) declarations.push(`font-size:${style.fontSize}px`);
  if (style.fontWeight) declarations.push(`font-weight:${style.fontWeight}`);
  if (style.color) declarations.push(`color:${style.color}`);
  if (style.textAlign) declarations.push(`text-align:${style.textAlign}`);
  if (style.lineHeight) declarations.push(`line-height:${style.lineHeight}`);
  if (style.backgroundColor) declarations.push(`background:${style.backgroundColor}`);
  if (style.borderColor && style.borderWidth) declarations.push(`border:${style.borderWidth}px solid ${style.borderColor}`);
  if (style.borderRadius) declarations.push(`border-radius:${style.borderRadius}px`);
  if (typeof style.padding === 'number') declarations.push(`padding:${style.padding}px`);
  if (typeof style.opacity === 'number') declarations.push(`opacity:${style.opacity}`);
  return declarations.join(';');
}

function renderElementHtml(element: CardTemplateElement, data: KanbanPrintData): string {
  const baseStyle = styleForElement(element);

  if (element.type === 'bound_text') {
    const value = resolveBindingToken(element.token, data) || element.fallbackText || '';
    return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};white-space:pre-wrap;">${escapeHtml(value)}</div>`;
  }

  if (element.type === 'text') {
    return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};white-space:pre-wrap;">${escapeHtml(element.text)}</div>`;
  }

  if (element.type === 'image') {
    const resolved = element.token ? resolveBindingToken(element.token, data) : (element.src ?? '');
    const imageUrl = normalizeImageUrl(resolved);
    if (!imageUrl) {
      return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};display:flex;align-items:center;justify-content:center;background:#efefef;color:#8a8a8a;font-size:11px;">No image</div>`;
    }
    const fit = element.fit ?? 'contain';
    return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};display:flex;align-items:center;justify-content:center;"><img src="${escapeHtml(imageUrl)}" alt="Item image" style="display:block;width:100%;height:100%;object-fit:${fit};"/></div>`;
  }

  if (element.type === 'qr') {
    return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};"><img src="${escapeHtml(data.qrCodeDataUrl)}" alt="QR Code" style="display:block;width:100%;height:100%;object-fit:contain;"/></div>`;
  }

  if (element.type === 'icon') {
    return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};display:flex;align-items:center;justify-content:center;color:#4b5563;">${renderIconMarkup(element.iconName, element.iconUrl)}</div>`;
  }

  if (element.type === 'line') {
    const stroke = element.style?.strokeColor ?? '#2F6FCC';
    const width = element.style?.strokeWidth ?? 1;
    if (element.orientation === 'horizontal') {
      return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};height:${width}px;background:${stroke};"></div>`;
    }
    return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};width:${width}px;background:${stroke};"></div>`;
  }

  if (element.type === 'rect') {
    const bg = element.style?.backgroundColor ?? '#2F6FCC';
    return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};background:${bg};"></div>`;
  }

  if (element.type === 'notes_box') {
    const value = element.token ? resolveBindingToken(element.token, data) : data.notesText || '';
    return `<div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};white-space:pre-wrap;">${escapeHtml(value)}</div>`;
  }

  if (element.type === 'field_row_group') {
    const value = resolveBindingToken(element.token, data);
    return `
      <div data-el-id="${escapeHtml(element.id)}" style="${baseStyle};display:flex;align-items:flex-start;gap:8px;">
        <div style="width:30px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;color:#4b5563;">
          ${renderIconMarkup(element.iconName, element.iconUrl)}
          <div style="margin-top:2px;font-size:8px;line-height:1;color:#2F6FCC;">${escapeHtml(element.label)}</div>
        </div>
        <div style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(value)}</div>
      </div>
    `;
  }

  return '';
}

export function renderTemplateToHtml(
  definition: CardTemplateDefinition,
  data: KanbanPrintData,
  config: FormatConfig,
): string {
  const elements = [...definition.elements].sort((a, b) => a.z - b.z);
  const children = elements.map((el) => renderElementHtml(el, data)).join('\n');

  return `
    <div class="print-card" style="position:relative;box-sizing:border-box;width:${config.widthPx}px;height:${config.heightPx}px;background:${escapeHtml(definition.canvas.background)};overflow:hidden;border:1px solid #ddd;font-family:'Open Sans',Arial,sans-serif;">
      ${children}
    </div>
  `;
}
