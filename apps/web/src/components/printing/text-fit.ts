export interface FitTextOptions {
  text: string;
  containerWidthPx: number;
  containerHeightPx: number;
  minFontSizePx: number;
  maxFontSizePx: number;
  lineHeight: number;
  maxLines: number;
  avgCharWidthFactor?: number;
}

export interface FitTextResult {
  fontSizePx: number;
  lines: string[];
  clamped: boolean;
}

interface WrapResult {
  lines: string[];
  charsPerLine: number;
}

function wrapText(text: string, charsPerLine: number): string[] {
  if (!text.trim()) return [""];
  const tokens = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    if (token.length > charsPerLine) {
      if (current) {
        lines.push(current);
        current = "";
      }
      let remainder = token;
      while (remainder.length > charsPerLine) {
        lines.push(remainder.slice(0, charsPerLine));
        remainder = remainder.slice(charsPerLine);
      }
      current = remainder;
      continue;
    }

    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length <= charsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = token;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function measureAtSize(text: string, sizePx: number, options: FitTextOptions): WrapResult {
  const widthFactor = options.avgCharWidthFactor ?? 0.54;
  const charsPerLine = Math.max(1, Math.floor(options.containerWidthPx / (sizePx * widthFactor)));
  return {
    lines: wrapText(text, charsPerLine),
    charsPerLine,
  };
}

function clampLines(lines: string[], maxLines: number, charsPerLine: number): string[] {
  if (lines.length <= maxLines) return lines;
  const clamped = lines.slice(0, maxLines);
  const last = clamped[maxLines - 1] || "";
  const keepCount = Math.max(0, charsPerLine - 1);
  clamped[maxLines - 1] = `${last.slice(0, keepCount)}…`;
  return clamped;
}

function fits(lines: string[], fontSizePx: number, options: FitTextOptions): boolean {
  const lineCountOk = lines.length <= options.maxLines;
  const heightPx = lines.length * fontSizePx * options.lineHeight;
  return lineCountOk && heightPx <= options.containerHeightPx;
}

export function fitText(options: FitTextOptions): FitTextResult {
  const text = options.text.trim();
  if (!text) {
    return {
      fontSizePx: options.minFontSizePx,
      lines: [""],
      clamped: false,
    };
  }

  let low = Math.floor(options.minFontSizePx);
  let high = Math.floor(options.maxFontSizePx);
  let best = low;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const measured = measureAtSize(text, mid, options);
    if (fits(measured.lines, mid, options)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const measuredAtBest = measureAtSize(text, best, options);
  if (fits(measuredAtBest.lines, best, options)) {
    return {
      fontSizePx: best,
      lines: measuredAtBest.lines,
      clamped: false,
    };
  }

  const measuredAtMin = measureAtSize(text, options.minFontSizePx, options);
  const clampedLines = clampLines(
    measuredAtMin.lines,
    options.maxLines,
    measuredAtMin.charsPerLine,
  );
  return {
    fontSizePx: options.minFontSizePx,
    lines: clampedLines,
    clamped: true,
  };
}

