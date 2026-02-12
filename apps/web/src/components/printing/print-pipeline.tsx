// ─── Print Pipeline ──────────────────────────────────────────────────
// Handles print preview, configuration, stylesheet generation,
// and dispatching to the browser print dialog.
// Uses DOMParser + importNode instead of document.write for security.

import { useState, useCallback } from 'react';
import type { CardFormat } from '@arda/shared-types';
import type { KanbanPrintData, FormatConfig } from './types';
import { FORMAT_CONFIGS } from './types';
import { KanbanPrintRenderer } from './kanban-print-renderer';
import { renderOrderCard3x5Html } from './order-card-3x5-template';

// ─── Print Settings ──────────────────────────────────────────────────

export type PrinterClass = 'standard' | 'thermal';
export type ColorMode = 'color' | 'monochrome';
export type Orientation = 'portrait' | 'landscape';

export interface PrintMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PrintSettings {
  printerClass: PrinterClass;
  colorMode: ColorMode;
  margins: PrintMargins;
  scale: number;
  orientation: Orientation;
  cardsPerPage: number;
}

// ─── Default Settings ────────────────────────────────────────────────

export function getDefaultSettings(format: CardFormat): PrintSettings {
  const config = FORMAT_CONFIGS[format];
  const isThermal = config.printerClass === 'thermal';

  const marginValue = isThermal ? 2 : 10;
  const orientation: Orientation = config.widthIn > config.heightIn ? 'landscape' : 'portrait';

  return {
    printerClass: config.printerClass,
    colorMode: isThermal ? 'monochrome' : 'color',
    margins: { top: marginValue, right: marginValue, bottom: marginValue, left: marginValue },
    scale: 1.0,
    orientation,
    cardsPerPage: isThermal ? 1 : calculateCardsPerPage(config),
  };
}

// ─── Cards Per Page Calculation ──────────────────────────────────────
// Calculates how many cards fit on US Letter paper (8.5 x 11 in).

export function calculateCardsPerPage(config: FormatConfig): number {
  const pageWidth = 8.5;
  const pageHeight = 11;
  const cols = Math.floor(pageWidth / config.widthIn);
  const rows = Math.floor(pageHeight / config.heightIn);
  return Math.max(1, cols * rows);
}

// ─── Print Stylesheet Builder ────────────────────────────────────────

export function buildPrintStylesheet(settings: PrintSettings, config: FormatConfig): string {
  const { margins } = settings;
  const marginStr = `${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm`;

  let css = `
@page {
  size: ${config.widthIn}in ${config.heightIn}in;
  margin: ${marginStr};
}

@media print {
  * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  body {
    background: white !important;
    margin: 0;
    padding: 0;
  }
  .print-card {
    break-inside: avoid;
    box-shadow: none !important;
  }
  .no-print {
    display: none !important;
  }
}
`;

  // Monochrome rules for thermal printers
  if (settings.colorMode === 'monochrome') {
    css += `
.print-band-solid {
  background: #000 !important;
}
.print-band-dashed {
  background: repeating-linear-gradient(
    90deg,
    #000 0px, #000 4px,
    transparent 4px, transparent 8px
  ) !important;
}
.print-band-dotted {
  background: repeating-linear-gradient(
    90deg,
    #000 0px, #000 2px,
    transparent 2px, transparent 6px
  ) !important;
}
`;
  }

  return css;
}

// ─── Print Preview Component ─────────────────────────────────────────

interface PrintPreviewProps {
  data: KanbanPrintData;
  format: CardFormat;
  scale?: number;
}

export function PrintPreview({ data, format, scale = 0.8 }: PrintPreviewProps) {
  return (
    <div
      className="inline-block border border-dashed border-muted-foreground/30 bg-white"
      style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
    >
      <KanbanPrintRenderer data={data} format={format} />
    </div>
  );
}

// ─── Print Controls Component ────────────────────────────────────────

interface PrintControlsProps {
  settings: PrintSettings;
  onSettingsChange: (settings: PrintSettings) => void;
  onPrint: () => void;
}

export function PrintControls({ settings, onSettingsChange, onPrint }: PrintControlsProps) {
  return (
    <div className="flex flex-col gap-3 p-4 border border-border rounded-md bg-muted/5">
      {/* Scale */}
      <div className="flex items-center gap-2 text-sm">
        <label className="text-muted-foreground w-20">Scale:</label>
        <input
          type="range"
          min="0.5"
          max="1.5"
          step="0.05"
          value={settings.scale}
          onChange={(e) => onSettingsChange({ ...settings, scale: parseFloat(e.target.value) })}
          className="flex-1"
        />
        <span className="w-12 text-right">{Math.round(settings.scale * 100)}%</span>
      </div>

      {/* Margins */}
      <div className="flex items-center gap-2 text-sm">
        <label className="text-muted-foreground w-20">Margins:</label>
        <input
          type="number"
          min="0"
          max="25"
          value={settings.margins.top}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10) || 0;
            onSettingsChange({
              ...settings,
              margins: { top: v, right: v, bottom: v, left: v },
            });
          }}
          className="w-16 px-2 py-1 border border-border rounded-md text-center"
        />
        <span className="text-muted-foreground">mm (all sides)</span>
      </div>

      {/* Color Mode */}
      <div className="flex items-center gap-2 text-sm">
        <label className="text-muted-foreground w-20">Color:</label>
        <select
          value={settings.colorMode}
          onChange={(e) => onSettingsChange({ ...settings, colorMode: e.target.value as ColorMode })}
          className="px-2 py-1 border border-border rounded-md"
        >
          <option value="color">Color</option>
          <option value="monochrome">Monochrome</option>
        </select>
      </div>

      {/* Print Button */}
      <button
        type="button"
        onClick={onPrint}
        className="mt-2 px-4 py-2 bg-primary text-white font-semibold rounded-md hover:bg-[hsl(var(--arda-orange-hover))] transition-colors"
      >
        Print
      </button>
    </div>
  );
}

// ─── Print Pipeline Component ────────────────────────────────────────

interface PrintPipelineProps {
  cards: KanbanPrintData[];
  format: CardFormat;
}

export function PrintPipeline({ cards, format }: PrintPipelineProps) {
  const [settings, setSettings] = useState<PrintSettings>(() => getDefaultSettings(format));

  const handlePrint = useCallback(() => {
    dispatchPrint(cards, format, settings);
  }, [cards, format, settings]);

  return (
    <div className="space-y-4">
      {/* Preview */}
      <div className="overflow-auto max-h-[400px] p-4 bg-muted/10 rounded-md">
        <div className="flex flex-wrap gap-4">
          {cards.map((card) => (
            <PrintPreview key={card.cardId} data={card} format={format} scale={0.6} />
          ))}
        </div>
      </div>

      {/* Controls */}
      <PrintControls settings={settings} onSettingsChange={setSettings} onPrint={handlePrint} />
    </div>
  );
}

// ─── Print Dispatch ──────────────────────────────────────────────────
// Opens a new window and renders cards using safe DOM manipulation.
// Uses DOMParser + importNode rather than document.write (XSS-safe).

export interface DispatchPrintOptions {
  printWindow?: Window | null;
  closeWindowAfterPrint?: boolean;
}

export function openPrintWindow(): Window | null {
  if (typeof window === 'undefined') return null;
  return window.open('', '_blank', 'width=800,height=600');
}

export function dispatchPrint(
  cards: KanbanPrintData[],
  format: CardFormat,
  settings: PrintSettings,
  options: DispatchPrintOptions = {},
): void {
  const config = FORMAT_CONFIGS[format];
  const stylesheet = buildPrintStylesheet(settings, config);

  // Build the HTML content as a string
  const cardsHtml = cards
    .map(
      (card) => config.layoutVariant === 'order_card_3x5_portrait'
        ? renderOrderCard3x5Html(card, config)
        : `
    <div class="print-card" style="
      width: ${config.widthPx}px;
      height: ${config.heightPx}px;
      border: 1px solid #e5e5e5;
      background: white;
      box-shadow: none;
      break-inside: avoid;
      padding: ${config.safeInsetPx}px;
      margin-bottom: 8px;
      font-family: 'Open Sans', system-ui, sans-serif;
      font-size: 10px;
    ">
      <div style="font-weight: 700; font-size: 14px;">${escapeHtml(card.partNumber)}</div>
      ${config.showDescription ? `<div style="font-size: 12px;">${escapeHtml(card.partDescription)}</div>` : ''}
      <div style="margin-top: 4px;">
        <img src="${escapeHtml(card.qrCodeDataUrl)}" width="${config.qrSizePx}" height="${config.qrSizePx}" />
      </div>
      <div style="font-size: 9px; color: #737373; margin-top: 4px;">
        Card ${card.cardNumber} of ${card.totalCards}
      </div>
    </div>`,
    )
    .join('\n');

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Print Kanban Cards</title>
  <style>${stylesheet}</style>
</head>
<body>${cardsHtml}</body>
</html>`;

  // Open window and use safe DOM manipulation
  const printWindow = options.printWindow ?? openPrintWindow();
  if (!printWindow) {
    if (typeof window !== 'undefined') {
      alert('Pop-up blocked. Please allow pop-ups for this site to print.');
    }
    return;
  }

  // Parse the HTML safely using DOMParser
  const parser = new DOMParser();
  const doc = parser.parseFromString(fullHtml, 'text/html');

  // Copy parsed content into the print window
  const headContent = doc.head;
  const bodyContent = doc.body;

  // Reset existing content in case the window was reused.
  printWindow.document.head.innerHTML = '';
  printWindow.document.body.innerHTML = '';

  // Import and append head elements
  for (const child of Array.from(headContent.childNodes)) {
    const imported = printWindow.document.importNode(child, true);
    printWindow.document.head.appendChild(imported);
  }

  // Import and append body elements
  for (const child of Array.from(bodyContent.childNodes)) {
    const imported = printWindow.document.importNode(child, true);
    printWindow.document.body.appendChild(imported);
  }

  const shouldClose = options.closeWindowAfterPrint ?? true;

  // Wait for images to settle before printing for more reliable preview output.
  const images = Array.from(printWindow.document.images ?? []);
  const imageLoadPromises = images.map((img) => {
    if (img.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  });

  const triggerPrint = () => {
    try {
      printWindow.focus();
    } catch {
      // Ignore focus errors for browser-managed windows.
    }

    if (shouldClose) {
      let closed = false;
      const closeSafely = () => {
        if (closed) return;
        closed = true;
        try {
          printWindow.close();
        } catch {
          // Ignore close errors for browser-managed windows.
        }
      };

      if (typeof printWindow.addEventListener === 'function') {
        printWindow.addEventListener(
          'afterprint',
          () => {
            setTimeout(closeSafely, 50);
          },
          { once: true },
        );
      } else {
        // Minimal fallback for environments without afterprint events.
        setTimeout(closeSafely, 1_000);
      }

      // Fallback for browsers that do not reliably fire afterprint.
      setTimeout(closeSafely, 60_000);
    }

    printWindow.print();
  };

  const schedulePrint = () => {
    // Let layout settle one frame before printing.
    setTimeout(triggerPrint, 100);
  };

  if (imageLoadPromises.length === 0) {
    schedulePrint();
    return;
  }

  Promise.all(imageLoadPromises).finally(schedulePrint);
}

// ─── Standalone Print Function ───────────────────────────────────────
export function printCards(cards: KanbanPrintData[], format: CardFormat): void {
  const settings = getDefaultSettings(format);
  dispatchPrint(cards, format, settings);
}

// ─── HTML Escape Utility ─────────────────────────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
