// ─── Scan API Client ────────────────────────────────────────────────
// Typed client for the kanban scan endpoints.
// Maps to routes defined in services/kanban/src/routes/scan.routes.ts
//
// Backend contract:
//   GET  /api/kanban/scan/:cardId          — Deep-link resolution (public)
//   POST /api/kanban/scan/:cardId/trigger  — Trigger card (JWT required)
//
// Idempotency:
//   The backend checks for duplicate idempotencyKey in transition metadata.
//   Replayed scans with the same key return the original transition result.

import type { QueuedScanEvent } from '@/lib/offline-queue';

// ─── Types ───────────────────────────────────────────────────────────

export interface ScanTriggerRequest {
  location?: {
    lat: number;
    lng: number;
  };
  idempotencyKey?: string;
}

export interface ScanTriggerResponse {
  success: boolean;
  card: {
    id: string;
    currentStage: string;
    loopId: string;
    tenantId: string;
    isActive: boolean;
    completedCycles: number;
    [key: string]: unknown;
  };
  loopType: string;
  partId: string;
  message: string;
}

export interface ScanDeepLinkResponse {
  cardId: string;
  action: string;
  redirectUrl: string;
  message: string;
}

export interface ScanApiError {
  success: false;
  error: string;
  code: string;
  statusCode: number;
}

export type ScanApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ScanApiError };

// ─── Configuration ──────────────────────────────────────────────────

export interface ScanApiConfig {
  /** Base URL for the API (e.g., '/api/kanban' or 'https://api.arda.io/api/kanban') */
  baseUrl: string;
  /** JWT token for authenticated requests */
  getToken: () => string | null;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

let globalConfig: ScanApiConfig = {
  baseUrl: '/api/kanban',
  getToken: () => null,
  timeout: 10000,
};

/** Configure the scan API client */
export function configureScanApi(config: Partial<ScanApiConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

// ─── HTTP Helpers ───────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function buildHeaders(authenticated: boolean): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (authenticated) {
    const token = globalConfig.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  return headers;
}

async function parseErrorResponse(response: Response): Promise<ScanApiError> {
  try {
    const body = await response.json();
    return {
      success: false,
      error: body.error ?? body.message ?? response.statusText,
      code: body.code ?? 'UNKNOWN_ERROR',
      statusCode: response.status,
    };
  } catch {
    return {
      success: false,
      error: response.statusText || 'Request failed',
      code: 'UNKNOWN_ERROR',
      statusCode: response.status,
    };
  }
}

// ─── API Methods ────────────────────────────────────────────────────

/**
 * Resolve a deep-link scan (public endpoint, no auth).
 * Returns card info and redirect URL.
 */
export async function resolveDeepLink(
  cardId: string,
): Promise<ScanApiResult<ScanDeepLinkResponse>> {
  try {
    const response = await fetchWithTimeout(
      `${globalConfig.baseUrl}/scan/${cardId}`,
      {
        method: 'GET',
        headers: buildHeaders(false),
      },
      globalConfig.timeout ?? 10000,
    );

    if (!response.ok) {
      const error = await parseErrorResponse(response);
      return { ok: false, error };
    }

    const data = await response.json();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        error: {
          success: false,
          error: 'Request timed out',
          code: 'TIMEOUT',
          statusCode: 0,
        },
      };
    }

    return {
      ok: false,
      error: {
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
        code: 'NETWORK_ERROR',
        statusCode: 0,
      },
    };
  }
}

/**
 * Trigger a card via scan (authenticated endpoint).
 * This is the primary method used by the PWA when online.
 */
export async function triggerScan(
  cardId: string,
  request?: ScanTriggerRequest,
): Promise<ScanApiResult<ScanTriggerResponse>> {
  try {
    const response = await fetchWithTimeout(
      `${globalConfig.baseUrl}/scan/${cardId}/trigger`,
      {
        method: 'POST',
        headers: buildHeaders(true),
        body: JSON.stringify(request ?? {}),
      },
      globalConfig.timeout ?? 10000,
    );

    if (!response.ok) {
      const error = await parseErrorResponse(response);
      return { ok: false, error };
    }

    const data = await response.json();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        error: {
          success: false,
          error: 'Request timed out',
          code: 'TIMEOUT',
          statusCode: 0,
        },
      };
    }

    return {
      ok: false,
      error: {
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
        code: 'NETWORK_ERROR',
        statusCode: 0,
      },
    };
  }
}

/**
 * Adapter function for the offline queue replay.
 * Wraps triggerScan in the shape expected by ReplayFn.
 */
export function createReplayAdapter(): (event: QueuedScanEvent) => Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}> {
  return async (event: QueuedScanEvent) => {
    const result = await triggerScan(event.cardId, {
      location: event.location,
      idempotencyKey: event.idempotencyKey,
    });

    if (result.ok) {
      return {
        success: true,
        data: result.data as unknown as Record<string, unknown>,
      };
    }

    return {
      success: false,
      errorCode: result.error.code,
      errorMessage: result.error.error,
    };
  };
}
