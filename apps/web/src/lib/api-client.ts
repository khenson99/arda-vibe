import { API_BASE_URL, SESSION_STORAGE_KEY } from "./constants";
import type {
  AuthResponse,
  AuthSession,
  SessionUser,
  QueueSummary,
  QueueByLoop,
  QueueCard,
  LoopType,
  PartsResponse,
  PartRecord,
  OrderLineByItemSummary,
  NotificationRecord,
  DataAuthorityTimeCoordinates,
  DataAuthorityEntityRecord,
  DataAuthorityPageResult,
  DataAuthorityCreateRequest,
  ItemsServicePayload,
  ItemsServiceInputPayload,
  OrdersServiceOrderLinePayload,
} from "@/types";

/* ── Error handling ──────────────────────────────────────────── */

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function parseApiError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error.";
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/* ── Core request helpers ────────────────────────────────────── */

export function buildApiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    token?: string;
    body?: unknown;
  } = {},
): Promise<T> {
  const { method = "GET", token, body } = options;

  const response = await fetch(buildApiUrl(path), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as Record<string, unknown>)
    : ({ message: await response.text() } as Record<string, unknown>);

  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : `Request failed with status ${response.status}`;

    const code = typeof payload.code === "string" ? payload.code : undefined;
    throw new ApiError(response.status, message, code);
  }

  return payload as T;
}

/* ── Session storage ─────────────────────────────────────────── */

export function readStoredSession(): AuthSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.tokens?.accessToken || !parsed?.tokens?.refreshToken || !parsed?.user?.id) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

export function writeStoredSession(session: AuthSession | null) {
  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

/* ── Auth ─────────────────────────────────────────────────────── */

export async function login(input: { email: string; password: string }): Promise<AuthResponse> {
  return apiRequest<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: input,
  });
}

export async function register(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
}): Promise<AuthResponse> {
  return apiRequest<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: input,
  });
}

export async function requestPasswordReset(input: { email: string }): Promise<{ message: string }> {
  return apiRequest<{ message: string }>("/api/auth/forgot-password", {
    method: "POST",
    body: input,
  });
}

export async function resetPasswordWithToken(input: {
  token: string;
  newPassword: string;
}): Promise<{ message: string }> {
  return apiRequest<{ message: string }>("/api/auth/reset-password", {
    method: "POST",
    body: input,
  });
}

export async function initGoogleEmailLink(
  token: string,
  input: { origin?: string },
): Promise<{ authorizationUrl: string }> {
  return apiRequest<{ authorizationUrl: string }>('/api/auth/google/link/init', {
    method: 'POST',
    token,
    body: input,
  });
}

export interface GmailDiscoveredSupplier {
  vendorId: string;
  vendorName: string;
  domain: string;
  messageCount: number;
  lastSeenAt: string;
}

export interface GmailSupplierDiscoveryResponse {
  suppliers: GmailDiscoveredSupplier[];
  scannedMessages: number;
  hasMore: boolean;
}

export interface GmailDiscoveredOrderItem {
  name: string;
  quantity: number;
  sku?: string;
  asin?: string;
  upc?: string;
  unitPrice?: number;
  url?: string;
}

export interface GmailDiscoveredOrder {
  vendorId: string;
  vendorName: string;
  domain?: string;
  orderDate: string;
  orderNumber: string;
  summary?: string;
  confidence: number;
  items: GmailDiscoveredOrderItem[];
}

export interface GmailOrderDiscoveryResponse {
  orders: GmailDiscoveredOrder[];
  suppliers: GmailDiscoveredSupplier[];
  scannedMessages: number;
  hasMore: boolean;
  analysisMode: "ai" | "heuristic";
  analysisWarning?: string;
}

export interface AiEmailEnrichedProduct {
  name: string;
  sku?: string;
  asin?: string;
  upc?: string;
  imageUrl?: string;
  vendorId: string;
  vendorName: string;
  productUrl?: string;
  description?: string;
  unitPrice?: number;
  moq: number;
  orderCadenceDays?: number;
  confidence: number;
  needsReview: boolean;
}

export interface AiEmailEnrichmentResponse {
  products: AiEmailEnrichedProduct[];
  mode: "ai" | "heuristic";
  warning?: string;
}

export interface AiImagePredictionResponse {
  label: string;
  confidence: number;
  suggestedProduct?: Partial<AiEmailEnrichedProduct>;
}

export interface AiImageIdentifyResponse {
  predictions: AiImagePredictionResponse[];
}

export interface UpcLookupProduct {
  upc: string;
  name: string;
  brand?: string;
  description?: string;
  imageUrl?: string;
  category?: string;
  productUrl?: string;
  moq?: number;
  confidence: number;
}

export interface UpcLookupResponse {
  upc: string;
  found: boolean;
  provider: "barcodelookup" | "openfoodfacts" | "none";
  product?: UpcLookupProduct;
}

export type MobileImportModule = "scan-upcs" | "ai-identify";
export type MobileImportEvent =
  | {
      id: string;
      sequence: number;
      type: "upc";
      createdAt: string;
      payload: { upc: string };
    }
  | {
      id: string;
      sequence: number;
      type: "image";
      createdAt: string;
      payload: { imageDataUrl: string; fileName: string };
    };

export interface MobileImportSessionCreateResponse {
  sessionId: string;
  sessionToken: string;
  module: MobileImportModule;
  expiresAt: string;
}

export interface MobileImportSessionSnapshot {
  sessionId: string;
  module: MobileImportModule;
  updatedAt: string;
  expiresAt: string;
  nextSequence: number;
  events: MobileImportEvent[];
}

export async function discoverGmailSuppliers(
  token: string,
  input: { maxResults?: number; lookbackDays?: number } = {},
): Promise<GmailSupplierDiscoveryResponse> {
  const params = new URLSearchParams();
  if (typeof input.maxResults === "number") {
    params.set("maxResults", String(input.maxResults));
  }
  if (typeof input.lookbackDays === "number") {
    params.set("lookbackDays", String(input.lookbackDays));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";

  return apiRequest<GmailSupplierDiscoveryResponse>(`/api/auth/google/vendors/discover${suffix}`, {
    token,
  });
}

export async function discoverGmailOrders(
  token: string,
  input: { maxResults?: number; lookbackDays?: number; vendorIds?: string[] } = {},
): Promise<GmailOrderDiscoveryResponse> {
  const params = new URLSearchParams();
  if (typeof input.maxResults === "number") {
    params.set("maxResults", String(input.maxResults));
  }
  if (typeof input.lookbackDays === "number") {
    params.set("lookbackDays", String(input.lookbackDays));
  }
  if (input.vendorIds && input.vendorIds.length > 0) {
    params.set("vendorIds", input.vendorIds.join(","));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";

  return apiRequest<GmailOrderDiscoveryResponse>(`/api/auth/google/orders/discover${suffix}`, {
    token,
  });
}

export async function enrichEmailOrdersWithAi(
  token: string,
  input: {
    orders: Array<{
      vendorId: string;
      vendorName: string;
      orderDate: string;
      orderNumber: string;
      items: GmailDiscoveredOrderItem[];
    }>;
  },
): Promise<AiEmailEnrichmentResponse> {
  return apiRequest<AiEmailEnrichmentResponse>("/api/auth/ai/email/enrich", {
    method: "POST",
    token,
    body: input,
  });
}

export async function identifyImageWithAi(
  token: string,
  input: { imageDataUrl: string; fileName?: string },
): Promise<AiImageIdentifyResponse> {
  return apiRequest<AiImageIdentifyResponse>("/api/auth/ai/image-identify", {
    method: "POST",
    token,
    body: input,
  });
}

export async function lookupUpc(
  token: string,
  upc: string,
): Promise<UpcLookupResponse> {
  return apiRequest<UpcLookupResponse>(`/api/auth/upc/${encodeURIComponent(upc)}`, {
    token,
  });
}

export async function fetchMe(token: string): Promise<SessionUser> {
  return apiRequest<SessionUser>("/api/auth/me", { token });
}

export async function createMobileImportSession(
  token: string,
  input: { module: MobileImportModule },
): Promise<MobileImportSessionCreateResponse> {
  return apiRequest<MobileImportSessionCreateResponse>("/api/auth/mobile-import/sessions", {
    method: "POST",
    token,
    body: input,
  });
}

export async function fetchMobileImportSession(
  input: {
    sessionId: string;
    sinceSequence?: number;
    accessToken?: string;
    sessionToken?: string;
  },
): Promise<MobileImportSessionSnapshot> {
  const params = new URLSearchParams();
  if (typeof input.sinceSequence === "number" && Number.isFinite(input.sinceSequence)) {
    params.set("sinceSequence", String(Math.max(0, Math.trunc(input.sinceSequence))));
  }
  if (input.sessionToken) {
    params.set("token", input.sessionToken);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";

  return apiRequest<MobileImportSessionSnapshot>(
    `/api/auth/mobile-import/sessions/${encodeURIComponent(input.sessionId)}${suffix}`,
    {
      token: input.accessToken,
    },
  );
}

export async function submitMobileImportUpc(
  input: {
    sessionId: string;
    upc: string;
    accessToken?: string;
    sessionToken?: string;
  },
): Promise<{ accepted: boolean; event: MobileImportEvent }> {
  return apiRequest<{ accepted: boolean; event: MobileImportEvent }>(
    `/api/auth/mobile-import/sessions/${encodeURIComponent(input.sessionId)}/upcs`,
    {
      method: "POST",
      token: input.accessToken,
      body: {
        upc: input.upc,
        sessionToken: input.sessionToken,
      },
    },
  );
}

export async function submitMobileImportImage(
  input: {
    sessionId: string;
    imageDataUrl: string;
    fileName?: string;
    accessToken?: string;
    sessionToken?: string;
  },
): Promise<{ accepted: boolean; event: MobileImportEvent }> {
  return apiRequest<{ accepted: boolean; event: MobileImportEvent }>(
    `/api/auth/mobile-import/sessions/${encodeURIComponent(input.sessionId)}/images`,
    {
      method: "POST",
      token: input.accessToken,
      body: {
        imageDataUrl: input.imageDataUrl,
        fileName: input.fileName,
        sessionToken: input.sessionToken,
      },
    },
  );
}

/* ── Queue ────────────────────────────────────────────────────── */

export async function fetchQueueSummary(token: string): Promise<QueueSummary> {
  const response = await apiRequest<{ success: boolean; data: QueueSummary }>(
    "/api/orders/queue/summary",
    { token },
  );

  return response.data;
}

export async function fetchQueueByLoop(token: string): Promise<QueueByLoop> {
  const response = await apiRequest<{
    success: boolean;
    data: Partial<Record<LoopType, QueueCard[]>>;
  }>("/api/orders/queue", { token });

  return {
    procurement: response.data.procurement ?? [],
    production: response.data.production ?? [],
    transfer: response.data.transfer ?? [],
  };
}

/* ── Data Authority helpers ──────────────────────────────────── */

export function toIsoFromTimeCoordinates(asOf?: DataAuthorityTimeCoordinates | null): string | null {
  if (!asOf) return null;
  const raw = Number(asOf.recorded ?? asOf.effective);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const timestampMs = raw > 1_000_000_000_000 ? raw : raw * 1000;
  const parsed = new Date(timestampMs);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function mapItemsServiceRecord(record: DataAuthorityEntityRecord<ItemsServicePayload>): PartRecord {
  const payload = record.payload;
  const updatedAt = toIsoFromTimeCoordinates(record.asOf) ?? new Date().toISOString();
  const identifier = payload.externalGuid?.trim() || payload.eId || record.rId;

  return {
    id: payload.eId || record.rId,
    eId: payload.eId || record.rId,
    partNumber: identifier,
    externalGuid: payload.externalGuid ?? null,
    name: payload.name?.trim() || identifier,
    type: payload.orderMechanism?.trim() || "unspecified",
    orderMechanism: payload.orderMechanism ?? null,
    location: payload.location ?? null,
    uom: payload.orderQtyUnit || payload.minQtyUnit || "each",
    isSellable: false,
    isActive: !record.retired,
    minQty: payload.minQty ?? null,
    minQtyUnit: payload.minQtyUnit ?? null,
    orderQty: payload.orderQty ?? null,
    orderQtyUnit: payload.orderQtyUnit ?? null,
    primarySupplier: payload.primarySupplier ?? null,
    primarySupplierLink: payload.primarySupplierLink ?? null,
    imageUrl: payload.imageUrl ?? null,
    notes: payload.notes ?? null,
    glCode: payload.glCode ?? null,
    itemSubtype: payload.itemSubtype ?? null,
    createdAt: updatedAt,
    updatedAt,
  };
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function toItemsInputPayload(part: PartRecord): ItemsServiceInputPayload {
  const fallbackId = part.partNumber?.trim() || part.id;
  const minQtyValue = typeof part.minQty === "number" && Number.isFinite(part.minQty) ? Math.max(0, part.minQty) : 0;
  const minQtyUnitValue = part.minQtyUnit?.trim() || part.uom?.trim() || "each";
  const orderQtyValue =
    typeof part.orderQty === "number" && Number.isFinite(part.orderQty) ? Math.max(0, part.orderQty) : null;
  const orderQtyUnitValue = normalizeOptionalString(part.orderQtyUnit ?? part.uom ?? null);
  const orderMechanismValue = part.orderMechanism?.trim() || part.type?.trim() || "unspecified";

  return {
    externalGuid: normalizeOptionalString(part.externalGuid) || fallbackId,
    name: part.name?.trim() || fallbackId,
    orderMechanism: orderMechanismValue,
    location: normalizeOptionalString(part.location),
    minQty: Math.trunc(minQtyValue),
    minQtyUnit: minQtyUnitValue,
    orderQty: orderQtyValue === null ? null : Math.trunc(orderQtyValue),
    orderQtyUnit: orderQtyUnitValue,
    primarySupplier: part.primarySupplier?.trim() || "Unknown supplier",
    primarySupplierLink: normalizeOptionalString(part.primarySupplierLink),
    imageUrl: normalizeOptionalString(part.imageUrl),
  };
}

export async function updateItemRecord(
  token: string,
  input: {
    entityId: string;
    tenantId: string;
    author: string;
    payload: ItemsServiceInputPayload;
  },
): Promise<void> {
  const { entityId, tenantId, author, payload } = input;

  const requestBody: DataAuthorityCreateRequest<ItemsServiceInputPayload, { tenantId: string }> = {
    payload,
    metadata: {
      tenantId,
    },
    effectiveAt: Date.now(),
    author,
  };

  await apiRequest(`/api/items/item/${encodeURIComponent(entityId)}`, {
    method: "PUT",
    token,
    body: requestBody,
  });
}

/* ── Items / Parts ────────────────────────────────────────────── */

export async function fetchItemsDataAuthority(token: string): Promise<PartsResponse> {
  const queryBody = {
    filter: {},
    sort: {
      entries: [] as Array<{ key: string; direction: "ASC" | "DESC" }>,
    },
    paginate: {
      index: 0,
      size: 200,
    },
  };

  const response = await apiRequest<DataAuthorityPageResult<ItemsServicePayload>>(
    "/api/items/item/query",
    {
      method: "POST",
      token,
      body: queryBody,
    },
  );

  const data = (response.results ?? []).map(mapItemsServiceRecord);
  const total = Number(response.totalCount ?? data.length);
  return {
    data,
    pagination: {
      page: 1,
      pageSize: data.length,
      total,
      totalPages: Math.max(1, Math.ceil(total / Math.max(1, data.length || 1))),
    },
  };
}

export async function fetchCatalogParts(token: string): Promise<PartsResponse> {
  return apiRequest<PartsResponse>("/api/catalog/parts?page=1&pageSize=100", { token });
}

export interface CatalogPartUpsertInput {
  partNumber: string;
  name: string;
  description?: string;
  type:
    | "raw_material"
    | "component"
    | "subassembly"
    | "finished_good"
    | "consumable"
    | "packaging"
    | "other";
  uom:
    | "each"
    | "box"
    | "case"
    | "pallet"
    | "kg"
    | "lb"
    | "meter"
    | "foot"
    | "liter"
    | "gallon"
    | "roll"
    | "sheet"
    | "pair"
    | "set"
    | "other";
  unitPrice?: string;
  upcBarcode?: string;
  manufacturerPartNumber?: string;
  imageUrl?: string;
  isSellable?: boolean;
}

export async function createCatalogPart(
  token: string,
  payload: CatalogPartUpsertInput,
): Promise<PartRecord> {
  return apiRequest<PartRecord>("/api/catalog/parts", {
    method: "POST",
    token,
    body: payload,
  });
}

export async function updateCatalogPart(
  token: string,
  partId: string,
  payload: Partial<CatalogPartUpsertInput>,
): Promise<PartRecord> {
  return apiRequest<PartRecord>(`/api/catalog/parts/${encodeURIComponent(partId)}`, {
    method: "PATCH",
    token,
    body: payload,
  });
}

export async function findCatalogPartByPartNumber(
  token: string,
  partNumber: string,
): Promise<PartRecord | null> {
  const params = new URLSearchParams({
    page: "1",
    pageSize: "20",
    search: partNumber,
    isActive: "true",
  });
  const response = await apiRequest<PartsResponse>(`/api/catalog/parts?${params.toString()}`, {
    token,
  });
  const target = partNumber.trim().toLowerCase();
  return (
    response.data.find((part) => part.partNumber.trim().toLowerCase() === target) ?? null
  );
}

export async function fetchParts(token: string): Promise<PartsResponse> {
  try {
    return await fetchItemsDataAuthority(token);
  } catch (error) {
    if (isUnauthorized(error)) {
      throw error;
    }
    return fetchCatalogParts(token);
  }
}

/* ── Orders ───────────────────────────────────────────────────── */

export async function fetchOrderLineSummaries(token: string): Promise<Record<string, OrderLineByItemSummary>> {
  const queryBody = {
    filter: {},
    sort: {
      entries: [] as Array<{ key: string; direction: "ASC" | "DESC" }>,
    },
    paginate: {
      index: 0,
      size: 400,
    },
  };

  const response = await apiRequest<DataAuthorityPageResult<OrdersServiceOrderLinePayload>>(
    "/api/orders/order/query",
    {
      method: "POST",
      token,
      body: queryBody,
    },
  );

  const summaries: Record<string, OrderLineByItemSummary> = {};

  for (const record of response.results ?? []) {
    const line = record.payload;
    const itemEId = line.item?.eId?.trim();
    if (!itemEId) continue;

    const updatedAt = toIsoFromTimeCoordinates(record.asOf);
    const previous = summaries[itemEId];
    if (
      previous &&
      previous.updatedAt &&
      updatedAt &&
      previous.updatedAt >= updatedAt
    ) {
      continue;
    }

    summaries[itemEId] = {
      itemEId,
      status: line.status ?? null,
      unitCostValue: line.unitCost?.value ?? null,
      unitCostCurrency: line.unitCost?.currency ?? null,
      orderedQty: line.quantity?.amount ?? null,
      orderedQtyUnit: line.quantity?.unit ?? null,
      receivedQty: line.received?.amount ?? null,
      receivedQtyUnit: line.received?.unit ?? null,
      notes: line.privateNotes?.trim() || line.notes?.trim() || null,
      updatedAt,
    };
  }

  return summaries;
}

/* ── Notifications ────────────────────────────────────────────── */

export async function fetchNotifications(token: string): Promise<NotificationRecord[]> {
  const response = await apiRequest<{ data: NotificationRecord[] }>("/api/notifications?limit=20", {
    token,
  });
  return response.data;
}

export async function fetchUnreadNotificationCount(token: string): Promise<number> {
  const response = await apiRequest<{ count: number }>("/api/notifications/unread-count", {
    token,
  });
  return Number(response.count ?? 0);
}

export async function markNotificationRead(token: string, id: string): Promise<void> {
  await apiRequest(`/api/notifications/${id}/read`, {
    method: "PATCH",
    token,
  });
}

export async function markAllNotificationsRead(token: string): Promise<void> {
  await apiRequest("/api/notifications/mark-all-read", {
    method: "POST",
    token,
  });
}

/* ── Quick actions — Kanban ──────────────────────────────────── */

export async function createPrintJob(
  token: string,
  input: {
    cardIds: string[];
    format?: string;
    printerClass?: string;
  },
): Promise<{ id: string }> {
  return apiRequest("/api/kanban/print-jobs", {
    method: "POST",
    token,
    body: {
      cardIds: input.cardIds,
      format: input.format ?? "3x5_card",
      printerClass: input.printerClass ?? "standard",
    },
  });
}

/* ── Quick actions — Orders ──────────────────────────────────── */

export async function createPurchaseOrderFromCards(
  token: string,
  input: {
    cardIds: string[];
    notes?: string;
  },
): Promise<{ purchaseOrderId: string; poNumber: string }> {
  return apiRequest("/api/orders/queue/create-po", {
    method: "POST",
    token,
    body: input,
  });
}
