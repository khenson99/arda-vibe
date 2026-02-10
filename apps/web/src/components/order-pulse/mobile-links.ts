import type { ImportModuleId } from "./types";

function parseOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  );
}

export function resolvePublicAppOrigin(): string {
  const configuredOrigin = parseOrigin(import.meta.env.VITE_PUBLIC_APP_URL?.trim());
  if (configuredOrigin) return configuredOrigin;

  if (typeof window === "undefined") return "";

  if (!isLocalHostname(window.location.hostname)) {
    return window.location.origin;
  }

  // Local dev links are not reachable from a physical phone unless a public
  // tunnel URL is configured.
  const devPublicOrigin = parseOrigin(import.meta.env.VITE_DEV_PUBLIC_URL?.trim());
  return devPublicOrigin ?? window.location.origin;
}

export function buildMobileImportUrl(module: ImportModuleId): string {
  const baseOrigin = resolvePublicAppOrigin();
  if (!baseOrigin) return "";

  const url = new URL(baseOrigin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("import", module);
  url.searchParams.set("mobile", "1");
  return url.toString();
}

export function isMobileImportMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("mobile") === "1";
}

export function buildQrCodeImageUrl(targetUrl: string, size = 180): string {
  const encoded = encodeURIComponent(targetUrl);
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}`;
}
