import * as React from 'react';
import { Button, Input } from '@/components/ui';
import type { CardTemplateBindingToken, CardTemplateDefinition, CardTemplateElement } from '@arda/shared-types';
import { normalizeUrl, STOCK_ICON_NAMES, type StockIconName } from './icon-library';

const TOKENS: Array<{ token: CardTemplateBindingToken; label: string }> = [
  { token: 'title', label: 'Title' },
  { token: 'itemName', label: 'Item name' },
  { token: 'sku', label: 'SKU' },
  { token: 'partNumberText', label: 'Part number' },
  { token: 'minimumText', label: 'Minimum (formatted)' },
  { token: 'locationText', label: 'Location (formatted)' },
  { token: 'orderText', label: 'Order (formatted)' },
  { token: 'supplierText', label: 'Supplier (formatted)' },
  { token: 'supplierNameText', label: 'Supplier name' },
  { token: 'unitPriceText', label: 'Unit price' },
  { token: 'orderQuantityValue', label: 'Order quantity' },
  { token: 'orderUnitsText', label: 'Order units' },
  { token: 'minQuantityValue', label: 'Min quantity' },
  { token: 'minUnitsText', label: 'Min units' },
  { token: 'cardsCountText', label: 'Card count' },
  { token: 'orderMethodText', label: 'Order method' },
  { token: 'itemLocationText', label: 'Item location' },
  { token: 'statusText', label: 'Status' },
  { token: 'updatedAtText', label: 'Updated date' },
  { token: 'glCodeText', label: 'GL code' },
  { token: 'itemTypeText', label: 'Item type' },
  { token: 'itemSubtypeText', label: 'Item subtype' },
  { token: 'uomText', label: 'UOM' },
  { token: 'facilityNameText', label: 'Facility name' },
  { token: 'sourceFacilityNameText', label: 'Source facility' },
  { token: 'storageLocationText', label: 'Storage location' },
  { token: 'scanUrlText', label: 'Scan URL' },
  { token: 'notesText', label: 'Notes' },
  { token: 'imageUrl', label: 'Image URL' },
  { token: 'qrCodeDataUrl', label: 'QR data URL' },
];

interface InspectorPanelProps {
  definition: CardTemplateDefinition;
  selectedElementId: string | null;
  onDefinitionChange: (definition: CardTemplateDefinition) => void;
  customIconUrls: string[];
  onCustomIconUrlsChange: (urls: string[]) => void;
}

export function InspectorPanel({
  definition,
  selectedElementId,
  onDefinitionChange,
  customIconUrls,
  onCustomIconUrlsChange,
}: InspectorPanelProps) {
  const [newIconUrl, setNewIconUrl] = React.useState('');
  const selectedElement = React.useMemo(
    () => definition.elements.find((element) => element.id === selectedElementId) ?? null,
    [definition.elements, selectedElementId],
  );

  const updateSelected = React.useCallback((updater: (element: CardTemplateElement) => CardTemplateElement) => {
    if (!selectedElement) return;
    const next = definition.elements.map((element) => (element.id === selectedElement.id ? updater(element) : element));
    onDefinitionChange({ ...definition, elements: next });
  }, [definition, onDefinitionChange, selectedElement]);

  const removeSelected = React.useCallback(() => {
    if (!selectedElement) return;
    if (selectedElement.key && definition.requiredElementKeys.includes(selectedElement.key)) return;
    onDefinitionChange({
      ...definition,
      elements: definition.elements.filter((element) => element.id !== selectedElement.id),
    });
  }, [definition, onDefinitionChange, selectedElement]);

  if (!selectedElement) {
    return (
      <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        Select an element to edit properties.
      </div>
    );
  }

  const required = !!selectedElement.key && definition.requiredElementKeys.includes(selectedElement.key);
  const selectedIconValue =
    (selectedElement.type === 'icon' || selectedElement.type === 'field_row_group') && selectedElement.iconUrl
      ? `custom:${selectedElement.iconUrl}`
      : (selectedElement.type === 'icon' || selectedElement.type === 'field_row_group')
        ? `stock:${selectedElement.iconName}`
        : '';

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold">Inspector</div>
          <div className="text-[11px] text-muted-foreground">{selectedElement.type}</div>
        </div>
        <Button size="sm" variant="outline" onClick={removeSelected} disabled={required}>Delete</Button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <LabelValue label="X">
          <Input type="number" value={selectedElement.x} onChange={(e) => updateSelected((el) => ({ ...el, x: Number(e.target.value) || 0 }))} />
        </LabelValue>
        <LabelValue label="Y">
          <Input type="number" value={selectedElement.y} onChange={(e) => updateSelected((el) => ({ ...el, y: Number(e.target.value) || 0 }))} />
        </LabelValue>
        <LabelValue label="W">
          <Input type="number" value={selectedElement.w} onChange={(e) => updateSelected((el) => ({ ...el, w: Math.max(1, Number(e.target.value) || 1) }))} />
        </LabelValue>
        <LabelValue label="H">
          <Input type="number" value={selectedElement.h} onChange={(e) => updateSelected((el) => ({ ...el, h: Math.max(1, Number(e.target.value) || 1) }))} />
        </LabelValue>
        <LabelValue label="Z">
          <Input type="number" value={selectedElement.z} onChange={(e) => updateSelected((el) => ({ ...el, z: Math.max(0, Number(e.target.value) || 0) }))} />
        </LabelValue>
        <LabelValue label="Locked">
          <select
            value={selectedElement.locked ? 'yes' : 'no'}
            onChange={(e) => updateSelected((el) => ({ ...el, locked: e.target.value === 'yes' }))}
            className="h-9 rounded-md border border-input bg-background px-2"
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </LabelValue>
      </div>

      {(selectedElement.type === 'bound_text' || selectedElement.type === 'image' || selectedElement.type === 'notes_box') && (
        <LabelValue label="Binding Token">
          <select
            value={selectedElement.type === 'bound_text' ? selectedElement.token : selectedElement.type === 'image' ? (selectedElement.token ?? '') : (selectedElement.token ?? 'notesText')}
            onChange={(e) => {
              const token = e.target.value as CardTemplateBindingToken;
              updateSelected((el) => {
                if (el.type === 'bound_text') return { ...el, token };
                if (el.type === 'image') return { ...el, token: token === 'imageUrl' ? 'imageUrl' : undefined };
                if (el.type === 'notes_box') return { ...el, token: token === 'notesText' ? 'notesText' : undefined };
                return el;
              });
            }}
            className="h-9 rounded-md border border-input bg-background px-2"
          >
            {TOKENS.map(({ token, label }) => (
              <option key={token} value={token}>{label}</option>
            ))}
          </select>
        </LabelValue>
      )}

      {(selectedElement.type === 'icon' || selectedElement.type === 'field_row_group') && (
        <>
          <LabelValue label="Icon">
            <select
              value={selectedIconValue}
              onChange={(e) =>
                updateSelected((el) => {
                  if (el.type !== 'icon' && el.type !== 'field_row_group') return el;
                  if (e.target.value.startsWith('custom:')) {
                    return { ...el, iconUrl: e.target.value.slice('custom:'.length) };
                  }
                  const stock = e.target.value.slice('stock:'.length) as StockIconName;
                  return { ...el, iconName: stock, iconUrl: undefined };
                })
              }
              className="h-9 rounded-md border border-input bg-background px-2"
            >
              {STOCK_ICON_NAMES.map((iconName) => (
                <option key={iconName} value={`stock:${iconName}`}>
                  Stock: {iconName}
                </option>
              ))}
              {customIconUrls.map((iconUrl) => (
                <option key={iconUrl} value={`custom:${iconUrl}`}>
                  Custom: {iconUrl}
                </option>
              ))}
            </select>
          </LabelValue>

          <LabelValue label="Custom icon URL">
            <div className="flex gap-2">
              <Input value={newIconUrl} onChange={(e) => setNewIconUrl(e.target.value)} placeholder="https://..." />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const normalized = normalizeUrl(newIconUrl);
                  if (!normalized) return;
                  const next = customIconUrls.includes(normalized) ? customIconUrls : [...customIconUrls, normalized];
                  onCustomIconUrlsChange(next);
                  updateSelected((el) => (el.type === 'icon' || el.type === 'field_row_group'
                    ? { ...el, iconUrl: normalized }
                    : el));
                  setNewIconUrl('');
                }}
              >
                Add
              </Button>
            </div>
          </LabelValue>
        </>
      )}

      {selectedElement.type === 'field_row_group' && (
        <>
          <LabelValue label="Label">
            <Input value={selectedElement.label} onChange={(e) => updateSelected((el) => el.type === 'field_row_group' ? { ...el, label: e.target.value } : el)} />
          </LabelValue>
          <LabelValue label="Token">
            <select
              value={selectedElement.token}
              onChange={(e) => updateSelected((el) => el.type === 'field_row_group' ? { ...el, token: e.target.value as typeof selectedElement.token } : el)}
              className="h-9 rounded-md border border-input bg-background px-2"
            >
              {TOKENS.map(({ token, label }) => (
                <option key={token} value={token}>{label}</option>
              ))}
            </select>
          </LabelValue>
        </>
      )}

      {selectedElement.type === 'text' && (
        <LabelValue label="Text">
          <textarea
            value={selectedElement.text}
            onChange={(e) => updateSelected((el) => (el.type === 'text' ? { ...el, text: e.target.value } : el))}
            className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
        </LabelValue>
      )}

      <div className="grid grid-cols-2 gap-2">
        <LabelValue label="Font size">
          <Input
            type="number"
            value={selectedElement.style?.fontSize ?? ''}
            onChange={(e) => updateSelected((el) => ({ ...el, style: { ...el.style, fontSize: Number(e.target.value) || undefined } }))}
          />
        </LabelValue>
        <LabelValue label="Weight">
          <Input
            type="number"
            value={selectedElement.style?.fontWeight ?? ''}
            onChange={(e) => updateSelected((el) => ({ ...el, style: { ...el.style, fontWeight: Number(e.target.value) || undefined } }))}
          />
        </LabelValue>
        <LabelValue label="Text color">
          <Input
            type="color"
            value={selectedElement.style?.color ?? '#111111'}
            onChange={(e) => updateSelected((el) => ({ ...el, style: { ...el.style, color: e.target.value } }))}
          />
        </LabelValue>
        <LabelValue label="Background">
          <Input
            type="color"
            value={selectedElement.style?.backgroundColor ?? '#ffffff'}
            onChange={(e) => updateSelected((el) => ({ ...el, style: { ...el.style, backgroundColor: e.target.value } }))}
          />
        </LabelValue>
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => updateSelected((el) => ({ ...el, z: el.z + 1 }))}>Bring forward</Button>
        <Button size="sm" variant="outline" onClick={() => updateSelected((el) => ({ ...el, z: Math.max(0, el.z - 1) }))}>Send backward</Button>
      </div>
    </div>
  );
}

function LabelValue(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}
