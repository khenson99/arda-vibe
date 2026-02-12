import type { CardTemplateDefinition } from '@arda/shared-types';

export const CARD_TEMPLATE_REQUIRED_KEYS = [
  'title',
  'sku',
  'qr',
  'minimum',
  'location',
  'order',
  'supplier',
  'image',
  'notes',
  'top_line',
  'bottom_bar',
] as const;

export function createDefaultCardTemplateDefinition(): CardTemplateDefinition {
  return {
    version: 1,
    canvas: {
      width: 288,
      height: 480,
      background: '#ffffff',
    },
    grid: {
      enabled: true,
      size: 8,
      snapThreshold: 4,
    },
    safeArea: {
      top: 13,
      right: 13,
      bottom: 13,
      left: 13,
    },
    requiredElementKeys: [...CARD_TEMPLATE_REQUIRED_KEYS],
    elements: [
      { id: 'el-title', key: 'title', type: 'bound_text', token: 'title', fallbackText: 'Untitled item', x: 13, y: 13, w: 190, h: 62, z: 10, style: { fontSize: 20, fontWeight: 700, lineHeight: 1.1, color: '#111111' } },
      { id: 'el-sku', key: 'sku', type: 'bound_text', token: 'sku', x: 13, y: 78, w: 190, h: 20, z: 10, style: { fontSize: 13, color: '#595959' } },
      { id: 'el-qr', key: 'qr', type: 'qr', x: 213, y: 13, w: 62, h: 62, z: 11 },
      { id: 'el-top-line', key: 'top_line', type: 'line', orientation: 'horizontal', x: 13, y: 98, w: 262, h: 2, z: 9, style: { strokeColor: '#2F6FCC', strokeWidth: 1 } },
      { id: 'el-minimum', key: 'minimum', type: 'field_row_group', iconName: 'minimum', label: 'Minimum', token: 'minimumText', x: 13, y: 109, w: 262, h: 33, z: 10, style: { fontSize: 16 } },
      { id: 'el-location', key: 'location', type: 'field_row_group', iconName: 'location', label: 'Location', token: 'locationText', x: 13, y: 142, w: 262, h: 33, z: 10, style: { fontSize: 16 } },
      { id: 'el-order', key: 'order', type: 'field_row_group', iconName: 'order', label: 'Order', token: 'orderText', x: 13, y: 175, w: 262, h: 33, z: 10, style: { fontSize: 16 } },
      { id: 'el-supplier', key: 'supplier', type: 'field_row_group', iconName: 'supplier', label: 'Supplier', token: 'supplierText', x: 13, y: 208, w: 262, h: 33, z: 10, style: { fontSize: 16 } },
      { id: 'el-image', key: 'image', type: 'image', token: 'imageUrl', fit: 'contain', x: 13, y: 246, w: 262, h: 142, z: 5, style: { backgroundColor: '#efefef' } },
      { id: 'el-notes', key: 'notes', type: 'notes_box', token: 'notesText', x: 13, y: 393, w: 262, h: 24, z: 10, style: { fontSize: 12, color: '#7b7b7b' } },
      { id: 'el-bottom-bar', key: 'bottom_bar', type: 'rect', x: 13, y: 423, w: 262, h: 17, z: 10, style: { backgroundColor: '#2F6FCC' } },
      { id: 'el-brand', key: 'brand', type: 'text', text: 'Arda', x: 118, y: 448, w: 52, h: 17, z: 10, style: { fontSize: 15, color: '#e2e2e2', textAlign: 'center' } },
      { id: 'el-qr-brand', key: 'qr_brand', type: 'text', text: 'Arda', x: 228, y: 77, w: 32, h: 12, z: 11, style: { fontSize: 10, color: '#222222', textAlign: 'center' } },
    ],
  };
}
