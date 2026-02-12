export const STOCK_ICON_NAMES = ['minimum', 'location', 'order', 'supplier'] as const;

export type StockIconName = (typeof STOCK_ICON_NAMES)[number];

const STOCK_ICON_SVGS: Record<StockIconName, string> = {
  minimum:
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/><path d="M16.8 16.4l2.7 4.7H14z"/><path d="M16.8 18.1v1.1"/></svg>',
  location:
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  order:
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 10-2.3 5.7"/><path d="M19.8 8.6l.2 3.6-3.5-.4"/><path d="M8.5 9.5h7v7h-7z"/></svg>',
  supplier:
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.6"/><circle cx="17" cy="20" r="1.6"/><path d="M2.5 4h2l2.1 10.6h11.9l2-7.2H6"/><path d="M10 8h10"/></svg>',
};

export function normalizeUrl(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderIconMarkup(iconName: StockIconName, iconUrl?: string): string {
  const normalizedUrl = normalizeUrl(iconUrl);
  if (normalizedUrl) {
    return `<img src="${escapeHtml(normalizedUrl)}" alt="Icon" style="display:block;width:100%;height:100%;object-fit:contain;"/>`;
  }
  return STOCK_ICON_SVGS[iconName];
}

