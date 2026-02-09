import QRCode from 'qrcode';
import { config } from '@arda/config';

// ─── QR Code URL Format ──────────────────────────────────────────────
// QR encodes: https://{tenant-slug}.arda.cards/scan/{card-uuid}
// For development: http://localhost:3000/scan/{card-uuid}

export function buildScanUrl(cardId: string, tenantSlug?: string): string {
  if (config.NODE_ENV === 'development') {
    return `${config.APP_URL}/scan/${cardId}`;
  }
  if (tenantSlug) {
    return `https://${tenantSlug}.arda.cards/scan/${cardId}`;
  }
  return `https://app.arda.cards/scan/${cardId}`;
}

// ─── Generate QR Code as Data URL (for embedding in HTML/PDF) ────────
export async function generateQRDataUrl(
  cardId: string,
  tenantSlug?: string,
  options?: { width?: number; margin?: number; errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }
): Promise<string> {
  const url = buildScanUrl(cardId, tenantSlug);
  return QRCode.toDataURL(url, {
    width: options?.width ?? 200,
    margin: options?.margin ?? 2,
    errorCorrectionLevel: options?.errorCorrectionLevel ?? 'M',
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
}

// ─── Generate QR Code as SVG String (for card printing) ──────────────
export async function generateQRSvg(
  cardId: string,
  tenantSlug?: string,
  options?: { width?: number; margin?: number }
): Promise<string> {
  const url = buildScanUrl(cardId, tenantSlug);
  return QRCode.toString(url, {
    type: 'svg',
    width: options?.width ?? 200,
    margin: options?.margin ?? 2,
    errorCorrectionLevel: 'M',
  });
}

// ─── Generate QR Code as PNG Buffer (for PDF generation) ─────────────
export async function generateQRBuffer(
  cardId: string,
  tenantSlug?: string,
  options?: { width?: number; margin?: number }
): Promise<Buffer> {
  const url = buildScanUrl(cardId, tenantSlug);
  return QRCode.toBuffer(url, {
    width: options?.width ?? 300,
    margin: options?.margin ?? 2,
    errorCorrectionLevel: 'H', // High correction for printed cards
  });
}
