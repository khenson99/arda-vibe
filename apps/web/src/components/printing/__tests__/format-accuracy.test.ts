import { describe, it, expect } from 'vitest';
import type { CardFormat } from '@arda/shared-types';
import { FORMAT_CONFIGS, STAGE_LABELS, LOOP_TYPE_LABELS } from '../types';
import type { FormatConfig, KanbanPrintData } from '../types';
import {
  PROCUREMENT_CARD_FIXTURE,
  PRODUCTION_CARD_FIXTURE,
  TRANSFER_CARD_FIXTURE,
  MINIMAL_CARD_FIXTURE,
  ALL_LOOP_TYPE_FIXTURES,
  createFixtureForStage,
} from './fixtures';

// ─── Format-Accuracy Validation Tests ─────────────────────────────────
// Verifies that format configurations, dimensional specs, and field visibility
// rules match the layout specification in docs/spec/printing/layout-specs.md.

describe('FORMAT_CONFIGS accuracy', () => {
  describe('dimensional specifications', () => {
    it('3x5_card is 5in wide x 3in tall', () => {
      const config = FORMAT_CONFIGS['3x5_card'];
      expect(config.widthIn).toBe(5);
      expect(config.heightIn).toBe(3);
    });

    it('4x6_card is 6in wide x 4in tall', () => {
      const config = FORMAT_CONFIGS['4x6_card'];
      expect(config.widthIn).toBe(6);
      expect(config.heightIn).toBe(4);
    });

    it('business_card is 3.5in wide x 2in tall', () => {
      const config = FORMAT_CONFIGS['business_card'];
      expect(config.widthIn).toBe(3.5);
      expect(config.heightIn).toBe(2);
    });

    it('business_label is 3.5in wide x 1.125in tall', () => {
      const config = FORMAT_CONFIGS['business_label'];
      expect(config.widthIn).toBe(3.5);
      expect(config.heightIn).toBe(1.125);
    });

    it('1x3_label is 3in wide x 1in tall', () => {
      const config = FORMAT_CONFIGS['1x3_label'];
      expect(config.widthIn).toBe(3);
      expect(config.heightIn).toBe(1);
    });

    it('bin_label is 2in wide x 1in tall', () => {
      const config = FORMAT_CONFIGS['bin_label'];
      expect(config.widthIn).toBe(2);
      expect(config.heightIn).toBe(1);
    });

    it('1x1_label is 1in wide x 1in tall', () => {
      const config = FORMAT_CONFIGS['1x1_label'];
      expect(config.widthIn).toBe(1);
      expect(config.heightIn).toBe(1);
    });
  });

  describe('printer class assignment', () => {
    const standardFormats: CardFormat[] = ['3x5_card', '4x6_card', 'business_card'];
    const thermalFormats: CardFormat[] = ['business_label', '1x3_label', 'bin_label', '1x1_label'];

    it.each(standardFormats)('%s is assigned to standard printer class', (format) => {
      expect(FORMAT_CONFIGS[format].printerClass).toBe('standard');
    });

    it.each(thermalFormats)('%s is assigned to thermal printer class', (format) => {
      expect(FORMAT_CONFIGS[format].printerClass).toBe('thermal');
    });
  });

  describe('logo visibility', () => {
    it('card formats show logo', () => {
      expect(FORMAT_CONFIGS['3x5_card'].showLogo).toBe(true);
      expect(FORMAT_CONFIGS['4x6_card'].showLogo).toBe(true);
      expect(FORMAT_CONFIGS['business_card'].showLogo).toBe(true);
    });

    it('label formats hide logo (per layout spec)', () => {
      expect(FORMAT_CONFIGS['business_label'].showLogo).toBe(false);
      expect(FORMAT_CONFIGS['1x3_label'].showLogo).toBe(false);
      expect(FORMAT_CONFIGS['bin_label'].showLogo).toBe(false);
      expect(FORMAT_CONFIGS['1x1_label'].showLogo).toBe(false);
    });
  });

  describe('description visibility', () => {
    it('most formats show description', () => {
      expect(FORMAT_CONFIGS['3x5_card'].showDescription).toBe(true);
      expect(FORMAT_CONFIGS['4x6_card'].showDescription).toBe(true);
      expect(FORMAT_CONFIGS['business_card'].showDescription).toBe(true);
      expect(FORMAT_CONFIGS['business_label'].showDescription).toBe(true);
      expect(FORMAT_CONFIGS['1x3_label'].showDescription).toBe(true);
    });

    it('bin_label and 1x1_label hide description', () => {
      expect(FORMAT_CONFIGS['bin_label'].showDescription).toBe(false);
      expect(FORMAT_CONFIGS['1x1_label'].showDescription).toBe(false);
    });
  });

  describe('extended fields (lead time, safety stock, notes)', () => {
    it('only 4x6_card shows extended fields', () => {
      expect(FORMAT_CONFIGS['4x6_card'].showExtendedFields).toBe(true);
      expect(FORMAT_CONFIGS['4x6_card'].showNotes).toBe(true);
    });

    const nonExtendedFormats: CardFormat[] = [
      '3x5_card', 'business_card', 'business_label', '1x3_label', 'bin_label', '1x1_label',
    ];

    it.each(nonExtendedFormats)('%s does NOT show extended fields', (format) => {
      expect(FORMAT_CONFIGS[format].showExtendedFields).toBe(false);
      expect(FORMAT_CONFIGS[format].showNotes).toBe(false);
    });
  });

  describe('scan URL visibility', () => {
    it('standard cards show scan URL', () => {
      expect(FORMAT_CONFIGS['3x5_card'].showScanUrl).toBe(true);
      expect(FORMAT_CONFIGS['4x6_card'].showScanUrl).toBe(true);
    });

    it('business_card does not show scan URL (too small)', () => {
      expect(FORMAT_CONFIGS['business_card'].showScanUrl).toBe(false);
    });

    it('labels do not show scan URL', () => {
      expect(FORMAT_CONFIGS['business_label'].showScanUrl).toBe(false);
      expect(FORMAT_CONFIGS['1x3_label'].showScanUrl).toBe(false);
      expect(FORMAT_CONFIGS['bin_label'].showScanUrl).toBe(false);
      expect(FORMAT_CONFIGS['1x1_label'].showScanUrl).toBe(false);
    });
  });

  describe('safe inset', () => {
    it('card formats use 12px inset (0.125in at 96dpi)', () => {
      expect(FORMAT_CONFIGS['3x5_card'].safeInsetPx).toBe(12);
      expect(FORMAT_CONFIGS['4x6_card'].safeInsetPx).toBe(12);
      expect(FORMAT_CONFIGS['business_card'].safeInsetPx).toBe(12);
    });

    it('label formats use 6px inset (tighter margins)', () => {
      expect(FORMAT_CONFIGS['business_label'].safeInsetPx).toBe(6);
      expect(FORMAT_CONFIGS['1x3_label'].safeInsetPx).toBe(6);
      expect(FORMAT_CONFIGS['bin_label'].safeInsetPx).toBe(6);
      expect(FORMAT_CONFIGS['1x1_label'].safeInsetPx).toBe(6);
    });
  });
});

describe('STAGE_LABELS completeness', () => {
  const allStages: KanbanPrintData['currentStage'][] = [
    'created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked',
  ];

  it.each(allStages)('has a display label for stage "%s"', (stage) => {
    expect(STAGE_LABELS[stage]).toBeDefined();
    expect(typeof STAGE_LABELS[stage]).toBe('string');
    expect(STAGE_LABELS[stage].length).toBeGreaterThan(0);
  });
});

describe('LOOP_TYPE_LABELS completeness', () => {
  const allLoopTypes: KanbanPrintData['loopType'][] = [
    'procurement', 'production', 'transfer',
  ];

  it.each(allLoopTypes)('has a display label for loop type "%s"', (loopType) => {
    expect(LOOP_TYPE_LABELS[loopType]).toBeDefined();
    expect(typeof LOOP_TYPE_LABELS[loopType]).toBe('string');
    expect(LOOP_TYPE_LABELS[loopType].length).toBeGreaterThan(0);
  });
});

describe('fixture data integrity', () => {
  it('PROCUREMENT_CARD_FIXTURE has a valid UUID', () => {
    expect(PROCUREMENT_CARD_FIXTURE.cardId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('all fixtures have data: URLs for QR codes', () => {
    ALL_LOOP_TYPE_FIXTURES.forEach((fixture) => {
      expect(fixture.qrCodeDataUrl).toMatch(/^data:/);
    });
  });

  it('createFixtureForStage produces unique IDs per stage', () => {
    const created = createFixtureForStage('created');
    const triggered = createFixtureForStage('triggered');
    expect(created.cardId).not.toBe(triggered.cardId);
    expect(created.currentStage).toBe('created');
    expect(triggered.currentStage).toBe('triggered');
  });

  it('each loop type fixture has the correct loopType', () => {
    expect(PROCUREMENT_CARD_FIXTURE.loopType).toBe('procurement');
    expect(PRODUCTION_CARD_FIXTURE.loopType).toBe('production');
    expect(TRANSFER_CARD_FIXTURE.loopType).toBe('transfer');
  });

  it('procurement fixture has supplier but not source facility', () => {
    expect(PROCUREMENT_CARD_FIXTURE.supplierName).toBeDefined();
    expect(PROCUREMENT_CARD_FIXTURE.sourceFacilityName).toBeUndefined();
  });

  it('transfer fixture has source facility but not supplier', () => {
    expect(TRANSFER_CARD_FIXTURE.sourceFacilityName).toBeDefined();
    expect(TRANSFER_CARD_FIXTURE.supplierName).toBeUndefined();
  });

  it('production fixture has neither supplier nor source facility', () => {
    expect(PRODUCTION_CARD_FIXTURE.supplierName).toBeUndefined();
    expect(PRODUCTION_CARD_FIXTURE.sourceFacilityName).toBeUndefined();
  });

  it('MINIMAL_CARD_FIXTURE omits all optional fields', () => {
    expect(MINIMAL_CARD_FIXTURE.storageLocation).toBeUndefined();
    expect(MINIMAL_CARD_FIXTURE.supplierName).toBeUndefined();
    expect(MINIMAL_CARD_FIXTURE.sourceFacilityName).toBeUndefined();
    expect(MINIMAL_CARD_FIXTURE.statedLeadTimeDays).toBeUndefined();
    expect(MINIMAL_CARD_FIXTURE.safetyStockDays).toBeUndefined();
    expect(MINIMAL_CARD_FIXTURE.notes).toBeUndefined();
    expect(MINIMAL_CARD_FIXTURE.lastPrintedAt).toBeUndefined();
    expect(MINIMAL_CARD_FIXTURE.tenantLogoUrl).toBeUndefined();
  });
});

describe('pixel dimensions consistency', () => {
  const ALL_FORMATS = Object.keys(FORMAT_CONFIGS) as CardFormat[];

  it.each(ALL_FORMATS)('format %s has pixel width proportional to inch width', (format) => {
    const config = FORMAT_CONFIGS[format];
    // At 96 DPI, 1in = 96px. We allow up to 96px per inch.
    const expectedMinWidth = Math.floor(config.widthIn * 80); // loose lower bound
    const expectedMaxWidth = Math.ceil(config.widthIn * 100); // loose upper bound
    expect(config.widthPx).toBeGreaterThanOrEqual(expectedMinWidth);
    expect(config.widthPx).toBeLessThanOrEqual(expectedMaxWidth);
  });

  it.each(ALL_FORMATS)('format %s has positive QR size', (format) => {
    const config = FORMAT_CONFIGS[format];
    expect(config.qrSizePx).toBeGreaterThan(0);
  });

  it.each(ALL_FORMATS)('format %s QR size fits within width', (format) => {
    const config = FORMAT_CONFIGS[format];
    expect(config.qrSizePx).toBeLessThan(config.widthPx);
  });
});
