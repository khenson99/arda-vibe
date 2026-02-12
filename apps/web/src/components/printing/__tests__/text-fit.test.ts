import { describe, expect, it } from 'vitest';
import { fitText } from '../text-fit';

describe('fitText', () => {
  it('uses a larger font size for shorter text', () => {
    const short = fitText({
      text: 'Bolt',
      containerWidthPx: 220,
      containerHeightPx: 52,
      minFontSizePx: 12,
      maxFontSizePx: 34,
      lineHeight: 1.15,
      maxLines: 2,
    });

    const long = fitText({
      text: 'High performance stainless steel flange bolt with anti-corrosion coating',
      containerWidthPx: 220,
      containerHeightPx: 52,
      minFontSizePx: 12,
      maxFontSizePx: 34,
      lineHeight: 1.15,
      maxLines: 2,
    });

    expect(short.fontSizePx).toBeGreaterThanOrEqual(long.fontSizePx);
  });

  it('clamps with ellipsis when text cannot fit at minimum font', () => {
    const result = fitText({
      text: 'A'.repeat(200),
      containerWidthPx: 90,
      containerHeightPx: 16,
      minFontSizePx: 10,
      maxFontSizePx: 20,
      lineHeight: 1.1,
      maxLines: 1,
    });

    expect(result.clamped).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.endsWith('…')).toBe(true);
  });

  it('respects maxLines for multi-line notes', () => {
    const result = fitText({
      text: 'Line one line two line three line four line five line six line seven',
      containerWidthPx: 180,
      containerHeightPx: 30,
      minFontSizePx: 10,
      maxFontSizePx: 14,
      lineHeight: 1.2,
      maxLines: 2,
    });

    expect(result.lines.length).toBeLessThanOrEqual(2);
  });
});

