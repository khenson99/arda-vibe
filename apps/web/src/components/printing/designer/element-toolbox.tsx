import * as React from 'react';
import { Button } from '@/components/ui';
import type { CardTemplateElement } from '@arda/shared-types';

interface ElementToolboxProps {
  onAddElement: (factory: () => CardTemplateElement) => void;
}

const TOOL_DEFS: Array<{ label: string; factory: () => CardTemplateElement }> = [
  {
    label: 'Text',
    factory: () => ({ id: `el-text-${crypto.randomUUID()}`, type: 'text', text: 'New text', x: 24, y: 24, w: 140, h: 30, z: 50 }),
  },
  {
    label: 'Bound Text',
    factory: () => ({ id: `el-bound-${crypto.randomUUID()}`, type: 'bound_text', token: 'title', fallbackText: 'Bound text', x: 24, y: 60, w: 160, h: 30, z: 50 }),
  },
  {
    label: 'Image',
    factory: () => ({ id: `el-image-${crypto.randomUUID()}`, type: 'image', token: 'imageUrl', fit: 'contain', x: 24, y: 96, w: 120, h: 80, z: 50 }),
  },
  {
    label: 'QR',
    factory: () => ({ id: `el-qr-${crypto.randomUUID()}`, type: 'qr', x: 24, y: 182, w: 60, h: 60, z: 50 }),
  },
  {
    label: 'Icon',
    factory: () => ({ id: `el-icon-${crypto.randomUUID()}`, type: 'icon', iconName: 'minimum', x: 24, y: 248, w: 24, h: 24, z: 50 }),
  },
  {
    label: 'Line',
    factory: () => ({ id: `el-line-${crypto.randomUUID()}`, type: 'line', orientation: 'horizontal', x: 24, y: 278, w: 120, h: 4, z: 50, style: { strokeColor: '#2F6FCC', strokeWidth: 2 } }),
  },
  {
    label: 'Rectangle',
    factory: () => ({ id: `el-rect-${crypto.randomUUID()}`, type: 'rect', x: 24, y: 286, w: 120, h: 24, z: 50, style: { backgroundColor: '#2F6FCC' } }),
  },
  {
    label: 'Notes Box',
    factory: () => ({ id: `el-notes-${crypto.randomUUID()}`, type: 'notes_box', token: 'notesText', x: 24, y: 316, w: 180, h: 36, z: 50 }),
  },
  {
    label: 'Field Row',
    factory: () => ({ id: `el-row-${crypto.randomUUID()}`, type: 'field_row_group', iconName: 'minimum', label: 'Minimum', token: 'minimumText', x: 24, y: 358, w: 220, h: 32, z: 50 }),
  },
];

export function ElementToolbox({ onAddElement }: ElementToolboxProps) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="text-xs font-semibold text-muted-foreground">Add Elements</div>
      <div className="grid grid-cols-2 gap-2">
        {TOOL_DEFS.map((tool) => (
          <Button
            key={tool.label}
            size="sm"
            variant="outline"
            className="justify-start"
            onClick={() => onAddElement(tool.factory)}
          >
            {tool.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
