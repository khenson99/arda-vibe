// ─── Kanban Print Renderer ───────────────────────────────────────────
// Unified entry point that selects the correct template based on format.

import type { CardFormat } from '@arda/shared-types';
import type { KanbanPrintData } from './types';
import { FORMAT_CONFIGS } from './types';
import { KanbanCardTemplate } from './kanban-card-template';
import { KanbanLabelTemplate } from './kanban-label-template';
import { OrderCard3x5Template } from './order-card-3x5-template';
import { validatePrintData } from './validation';

const CARD_FORMATS: CardFormat[] = ['order_card_3x5_portrait', '3x5_card', '4x6_card', 'business_card'];
const LABEL_FORMATS: CardFormat[] = ['business_label', '1x3_label', 'bin_label', '1x1_label'];

export function isCardFormat(format: CardFormat): boolean {
  return CARD_FORMATS.includes(format);
}

export function isLabelFormat(format: CardFormat): boolean {
  return LABEL_FORMATS.includes(format);
}

interface KanbanPrintRendererProps {
  data: KanbanPrintData;
  format: CardFormat;
}

export function KanbanPrintRenderer({ data, format }: KanbanPrintRendererProps) {
  const config = FORMAT_CONFIGS[format];

  // Validate before rendering
  const validation = validatePrintData(data, format);
  if (!validation.valid) {
    return (
      <div className="text-destructive text-xs p-2 border border-destructive rounded-md">
        <p className="font-semibold">Print validation errors:</p>
        <ul className="list-disc pl-4 mt-1">
          {validation.errors.map((err, i) => (
            <li key={i}>{err}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (isCardFormat(format)) {
    if (config.layoutVariant === 'order_card_3x5_portrait') {
      return <OrderCard3x5Template data={data} format={format} config={config} />;
    }
    return <KanbanCardTemplate data={data} format={format} config={config} />;
  }

  return <KanbanLabelTemplate data={data} format={format} config={config} />;
}
