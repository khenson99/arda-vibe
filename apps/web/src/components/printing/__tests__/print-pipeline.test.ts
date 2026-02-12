import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CardFormat } from '@arda/shared-types';
import {
  getDefaultSettings,
  calculateCardsPerPage,
  buildPrintStylesheet,
  dispatchPrint,
} from '../print-pipeline';
import { FORMAT_CONFIGS } from '../types';
import type { KanbanPrintData } from '../types';

// ─── Print Pipeline Utility Tests ─────────────────────────────────────
// Tests for the non-DOM utility functions in the print pipeline.

describe('getDefaultSettings', () => {
  describe('printer class detection', () => {
    const standardFormats: CardFormat[] = ['order_card_3x5_portrait', '3x5_card', '4x6_card', 'business_card'];
    const thermalFormats: CardFormat[] = ['business_label', '1x3_label', 'bin_label', '1x1_label'];

    it.each(standardFormats)('%s defaults to standard printer class', (format) => {
      const settings = getDefaultSettings(format);
      expect(settings.printerClass).toBe('standard');
    });

    it.each(thermalFormats)('%s defaults to thermal printer class', (format) => {
      const settings = getDefaultSettings(format);
      expect(settings.printerClass).toBe('thermal');
    });
  });

  describe('color mode', () => {
    it('standard formats default to color', () => {
      const settings = getDefaultSettings('3x5_card');
      expect(settings.colorMode).toBe('color');
    });

    it('thermal formats default to monochrome', () => {
      const settings = getDefaultSettings('business_label');
      expect(settings.colorMode).toBe('monochrome');
    });
  });

  describe('margins', () => {
    it('standard formats use 10mm margins', () => {
      const settings = getDefaultSettings('3x5_card');
      expect(settings.margins.top).toBe(10);
      expect(settings.margins.right).toBe(10);
      expect(settings.margins.bottom).toBe(10);
      expect(settings.margins.left).toBe(10);
    });

    it('thermal formats use 2mm margins', () => {
      const settings = getDefaultSettings('1x3_label');
      expect(settings.margins.top).toBe(2);
      expect(settings.margins.right).toBe(2);
      expect(settings.margins.bottom).toBe(2);
      expect(settings.margins.left).toBe(2);
    });
  });

  describe('scale', () => {
    it('defaults to 1.0 (100%)', () => {
      const settings = getDefaultSettings('3x5_card');
      expect(settings.scale).toBe(1.0);
    });
  });

  describe('thermal cards per page', () => {
    it('thermal formats default to 1 card per page', () => {
      const settings = getDefaultSettings('bin_label');
      expect(settings.cardsPerPage).toBe(1);
    });
  });

  describe('orientation', () => {
    it('landscape for wider-than-tall formats', () => {
      // 3x5_card is 5in wide x 3in tall
      const settings = getDefaultSettings('3x5_card');
      expect(settings.orientation).toBe('landscape');
    });

    it('portrait for taller-than-wide formats (or square)', () => {
      // 1x1_label is 1in x 1in — widthIn == heightIn, so not > => portrait
      const settings = getDefaultSettings('1x1_label');
      expect(settings.orientation).toBe('portrait');
    });
  });
});

describe('calculateCardsPerPage', () => {
  it('calculates correctly for 3x5 cards on letter paper', () => {
    const config = FORMAT_CONFIGS['3x5_card'];
    const count = calculateCardsPerPage(config);
    // Letter = 8.5 x 11. 3x5 card is 5w x 3h.
    // cols = floor(8.5/5) = 1, rows = floor(11/3) = 3 → 3
    expect(count).toBe(3);
  });

  it('calculates correctly for business cards on letter paper', () => {
    const config = FORMAT_CONFIGS['business_card'];
    const count = calculateCardsPerPage(config);
    // Letter = 8.5 x 11. Business card is 3.5w x 2h.
    // cols = floor(8.5/3.5) = 2, rows = floor(11/2) = 5 → 10
    expect(count).toBe(10);
  });

  it('returns at least 1', () => {
    const config = FORMAT_CONFIGS['4x6_card'];
    const count = calculateCardsPerPage(config);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('buildPrintStylesheet', () => {
  it('includes @page directive with correct dimensions', () => {
    const config = FORMAT_CONFIGS['3x5_card'];
    const settings = getDefaultSettings('3x5_card');
    const css = buildPrintStylesheet(settings, config);

    expect(css).toContain('@page');
    expect(css).toContain('5in');
    expect(css).toContain('3in');
  });

  it('includes margin values', () => {
    const config = FORMAT_CONFIGS['3x5_card'];
    const settings = getDefaultSettings('3x5_card');
    const css = buildPrintStylesheet(settings, config);

    expect(css).toContain('10mm');
  });

  it('includes monochrome rules for thermal formats', () => {
    const config = FORMAT_CONFIGS['business_label'];
    const settings = getDefaultSettings('business_label');
    const css = buildPrintStylesheet(settings, config);

    expect(css).toContain('print-band-solid');
    expect(css).toContain('print-band-dashed');
    expect(css).toContain('print-band-dotted');
  });

  it('omits monochrome rules for color mode', () => {
    const config = FORMAT_CONFIGS['3x5_card'];
    const settings = { ...getDefaultSettings('3x5_card'), colorMode: 'color' as const };
    const css = buildPrintStylesheet(settings, config);

    expect(css).not.toContain('print-band-solid');
  });

  it('forces white background for print', () => {
    const config = FORMAT_CONFIGS['3x5_card'];
    const settings = getDefaultSettings('3x5_card');
    const css = buildPrintStylesheet(settings, config);

    expect(css).toContain('background: white');
  });

  it('removes box-shadow for print', () => {
    const config = FORMAT_CONFIGS['3x5_card'];
    const settings = getDefaultSettings('3x5_card');
    const css = buildPrintStylesheet(settings, config);

    expect(css).toContain('box-shadow: none');
  });
});

describe('dispatchPrint', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).DOMParser;
  });

  const sampleCard: KanbanPrintData = {
    cardId: '3c82402b-5f53-4a6c-bbb7-76416519a02f',
    cardNumber: 1,
    totalCards: 3,
    partNumber: 'PN-100',
    partDescription: 'Widget',
    sku: 'PN-100',
    loopType: 'procurement',
    currentStage: 'created',
    facilityName: 'Plant A',
    orderQuantity: 10,
    minQuantity: 5,
    qrCodeDataUrl: 'data:image/png;base64,abc123',
    scanUrl: '',
    tenantName: 'Arda',
    notesText: '',
    imageUrl: '',
    minimumText: '5 each',
    locationText: 'Plant A',
    orderText: '10 each',
    supplierText: 'Test Supplier',
    accentColor: '#2F6FCC',
    showArdaWatermark: false,
  };

  function installDomParserStub() {
    class FakeDOMParser {
      parseFromString() {
        return {
          head: { childNodes: [{ id: 'head-node' }] },
          body: { childNodes: [{ id: 'body-node' }] },
        };
      }
    }

    (globalThis as Record<string, unknown>).DOMParser = FakeDOMParser;
  }

  function createPrintWindowStub() {
    const headAppend = vi.fn();
    const bodyAppend = vi.fn();
    const importNode = vi.fn((node: unknown) => node);
    const print = vi.fn();
    const close = vi.fn();

    return {
      window: {
        document: {
          head: { appendChild: headAppend },
          body: { appendChild: bodyAppend },
          importNode,
        },
        print,
        close,
      },
      spies: { headAppend, bodyAppend, importNode, print, close },
    };
  }

  it('uses provided printWindow and honors closeWindowAfterPrint=false', () => {
    vi.useFakeTimers();
    installDomParserStub();

    const provided = createPrintWindowStub();
    const openSpy = vi.fn();
    (globalThis as Record<string, unknown>).window = { open: openSpy };

    dispatchPrint(
      [sampleCard],
      '3x5_card',
      getDefaultSettings('3x5_card'),
      { printWindow: provided.window as unknown as Window, closeWindowAfterPrint: false },
    );

    vi.runAllTimers();

    expect(openSpy).not.toHaveBeenCalled();
    expect(provided.spies.importNode).toHaveBeenCalled();
    expect(provided.spies.print).toHaveBeenCalledTimes(1);
    expect(provided.spies.close).not.toHaveBeenCalled();
  });

  it('opens a window when no printWindow is passed and closes after print by default', () => {
    vi.useFakeTimers();
    installDomParserStub();

    const opened = createPrintWindowStub();
    const openSpy = vi.fn(() => opened.window);
    (globalThis as Record<string, unknown>).window = { open: openSpy, alert: vi.fn() };

    dispatchPrint(
      [sampleCard],
      '3x5_card',
      getDefaultSettings('3x5_card'),
    );

    vi.runAllTimers();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(opened.spies.print).toHaveBeenCalledTimes(1);
    expect(opened.spies.close).toHaveBeenCalledTimes(1);
  });
});
