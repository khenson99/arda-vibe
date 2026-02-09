// ─── Batch Print Selector ────────────────────────────────────────────
// UI for selecting multiple kanban cards, choosing a format,
// and dispatching a batch print job.

import { useState, useMemo } from 'react';
import type { CardFormat } from '@arda/shared-types';
import type { KanbanPrintData } from './types';
import { FORMAT_CONFIGS, LOOP_TYPE_LABELS } from './types';
import { PrintPipeline } from './print-pipeline';
import { cn } from '@/lib/utils';

type BatchState = 'selecting' | 'configuring' | 'printing';

interface BatchPrintSelectorProps {
  cards: KanbanPrintData[];
  onBatchPrintCreated?: (cardIds: string[], format: CardFormat) => void;
}

const FORMAT_OPTIONS: { value: CardFormat; label: string }[] = [
  { value: '3x5_card', label: '3x5 Card' },
  { value: '4x6_card', label: '4x6 Card' },
  { value: 'business_card', label: 'Business Card' },
  { value: 'business_label', label: 'Business Label' },
  { value: '1x3_label', label: '1x3 Label' },
  { value: 'bin_label', label: 'Bin Label' },
  { value: '1x1_label', label: '1x1 Label (QR Only)' },
];

export function BatchPrintSelector({ cards, onBatchPrintCreated }: BatchPrintSelectorProps) {
  const [state, setState] = useState<BatchState>('selecting');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<CardFormat>('3x5_card');

  const selectedCards = useMemo(
    () => cards.filter((c) => selectedIds.has(c.cardId)),
    [cards, selectedIds],
  );

  const toggleCard = (cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(cards.map((c) => c.cardId)));
  const clearAll = () => setSelectedIds(new Set());

  const handleStartConfig = () => {
    if (selectedIds.size === 0) return;
    setState('configuring');
  };

  const handleStartPrint = () => {
    onBatchPrintCreated?.([...selectedIds], format);
    setState('printing');
  };

  // ── Selecting State ──
  if (state === 'selecting') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Select Cards ({selectedIds.size} of {cards.length})
          </h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={selectAll}
              className="text-xs text-[hsl(var(--link))] hover:underline"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-muted-foreground hover:underline"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Card Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-[300px] overflow-y-auto">
          {cards.map((card) => {
            const isSelected = selectedIds.has(card.cardId);
            return (
              <button
                key={card.cardId}
                type="button"
                onClick={() => toggleCard(card.cardId)}
                className={cn(
                  'p-2 border rounded-md text-left text-xs transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground',
                )}
              >
                <div className="font-semibold truncate">{card.partNumber}</div>
                <div className="text-muted-foreground truncate">{card.partDescription}</div>
                <div className="text-muted-foreground mt-1">
                  {LOOP_TYPE_LABELS[card.loopType]} | {card.cardNumber}/{card.totalCards}
                </div>
              </button>
            );
          })}
        </div>

        {/* Format Picker + Continue */}
        <div className="flex items-center gap-3">
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as CardFormat)}
            className="px-3 py-1.5 border border-border rounded-md text-sm"
          >
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleStartConfig}
            disabled={selectedIds.size === 0}
            className={cn(
              'px-4 py-1.5 rounded-md text-sm font-semibold transition-colors',
              selectedIds.size > 0
                ? 'bg-primary text-white hover:bg-[hsl(var(--arda-orange-hover))]'
                : 'bg-muted text-muted-foreground cursor-not-allowed',
            )}
          >
            Configure Print ({selectedIds.size})
          </button>
        </div>
      </div>
    );
  }

  // ── Configuring / Printing State ──
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {state === 'configuring' ? 'Configure Print' : 'Printing...'}
          {' '}({selectedCards.length} cards as {FORMAT_OPTIONS.find((f) => f.value === format)?.label})
        </h3>
        {state === 'configuring' && (
          <button
            type="button"
            onClick={() => setState('selecting')}
            className="text-xs text-muted-foreground hover:underline"
          >
            Back to Selection
          </button>
        )}
      </div>

      <PrintPipeline cards={selectedCards} format={format} />

      {state === 'configuring' && (
        <button
          type="button"
          onClick={handleStartPrint}
          className="px-4 py-2 bg-[hsl(var(--link))] text-white font-semibold rounded-md hover:opacity-90 transition-opacity"
        >
          Create Print Job
        </button>
      )}
    </div>
  );
}
