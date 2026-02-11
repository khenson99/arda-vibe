import { API_BASE_URL, SESSION_STORAGE_KEY } from "./constants";
import type {
  AuthResponse,
  AuthSession,
  SessionUser,
  QueueSummary,
  QueueByLoop,
  QueueCard,
  LoopType,
  CreateProcurementDraftsInput,
  CreateProcurementDraftsResult,
  VerifyProcurementDraftsInput,
  PartsResponse,
  PartRecord,
  FacilityRecord,
  StorageLocationRecord,
  SupplierRecord,
  OrderLineByItemSummary,
  NotificationRecord,
  DataAuthorityTimeCoordinates,
  DataAuthorityEntityRecord,
  DataAuthorityPageResult,
  DataAuthorityCreateRequest,
  ItemsServicePayload,
  ItemsServiceInputPayload,
  OrdersServiceOrderLinePayload,
  KanbanLoop,
  KanbanCard,
  CardStage,
  CardTransition,
  LoopCardSummary,
  LoopVelocity,
  PurchaseOrder,
  POStatus,
  WorkOrder,
  TransferOrder,
  TOStatus,
  SourceRecommendation,
  InventoryLedgerEntry,
  Receipt,
  ReceivingMetrics,
  ReceivingException,
  ExceptionResolution,
} from "@/types";

/* ── Error handling ──────────────────────────────────────────── */

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function parseApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 502 && error.details?.service === "/api/kanban") {
      return "Kanban service is unavailable. Please try again in a moment.";
    }
    return error.message;
  }

  if (error instanceof Error) {
    const raw = error.message.trim();
    if (raw.startsWith("{") && raw.endsWith("}")) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const parsedService = typeof parsed.service === "string" ? parsed.service : null;
        const parsedError =
          typeof parsed.error === "string"
            ? parsed.error
            : typeof parsed.message === "string"
              ? parsed.message
              : null;

        if (parsedService === "/api/kanban") {
          return "Kanban service is unavailable. Please try again in a moment.";
        }

        if (parsedError) {
          return parsedError;
        }
      } catch {
        // Fall through to raw message.
      }
    }
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

function toObjectPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function parseResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const json = (await response.json()) as unknown;
      return toObjectPayload(json);
    } catch {
      // Fall through to text parsing for malformed JSON responses.
    }
  }

  const text = await response.text();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text) as unknown;
    const asObject = toObjectPayload(parsed);
    if (Object.keys(asObject).length > 0) return asObject;
  } catch {
    // Ignore parse errors and preserve raw text as message below.
  }

  return { message: text };
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

  const payload = await parseResponsePayload(response);

  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : `Request failed with status ${response.status}`;

    const code = typeof payload.code === "string" ? payload.code : undefined;
    throw new ApiError(response.status, message, code, payload);
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
  quantityOrdered?: number;
  sku?: string;
  asin?: string;
  upc?: string;
  unitPrice?: number;
  lineTotal?: number;
  packSize?: string;
  imageUrl?: string;
  dateOrdered?: string;
  messageType?: "receipt" | "shipping" | "delivery";
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
  recommendedOrderQuantity?: number;
  recommendedMinQuantity?: number;
  statedLeadTimeDays?: number;
  safetyStockDays?: number;
  orderHistorySampleSize?: number;
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

export async function createProcurementDrafts(
  token: string,
  input: CreateProcurementDraftsInput,
): Promise<CreateProcurementDraftsResult> {
  const response = await apiRequest<{
    success: boolean;
    data: CreateProcurementDraftsResult;
  }>("/api/orders/queue/procurement/create-drafts", {
    method: "POST",
    token,
    body: input,
  });

  return response.data;
}

export async function verifyProcurementDrafts(
  token: string,
  input: VerifyProcurementDraftsInput,
): Promise<{ poIds: string[]; cardIds: string[]; transitionedCards: number }> {
  const response = await apiRequest<{
    success: boolean;
    data: { poIds: string[]; cardIds: string[]; transitionedCards: number };
  }>("/api/orders/queue/procurement/verify", {
    method: "POST",
    token,
    body: input,
  });

  return response.data;
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
    notes: part.notes ?? null,
  };
}

export async function updateItemRecord(
  token: string,
  input: {
    entityId: string;
    tenantId: string;
    author: string;
    payload: ItemsServiceInputPayload;
    provisionDefaults?: boolean;
  },
): Promise<void> {
  const { entityId, tenantId, author, payload, provisionDefaults } = input;

  const requestBody: DataAuthorityCreateRequest<
    ItemsServiceInputPayload,
    { tenantId: string; provisionDefaults?: boolean }
  > = {
    payload,
    metadata: {
      tenantId,
      ...(provisionDefaults ? { provisionDefaults: true } : {}),
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

export async function fetchFacilities(
  token: string,
  params?: { search?: string; page?: number; pageSize?: number },
): Promise<{
  data: FacilityRecord[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set("search", params.search);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(`/api/catalog/facilities${suffix}`, { token });
}

export async function fetchStorageLocations(
  token: string,
  facilityId: string,
  params?: { search?: string; page?: number; pageSize?: number },
): Promise<{
  data: StorageLocationRecord[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set("search", params.search);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(
    `/api/catalog/facilities/${encodeURIComponent(facilityId)}/storage-locations${suffix}`,
    { token },
  );
}

export async function fetchSuppliers(
  token: string,
  params?: { search?: string; page?: number; pageSize?: number },
): Promise<{
  data: SupplierRecord[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set("search", params.search);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(`/api/catalog/suppliers${suffix}`, { token });
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

/* ── Kanban Loops ─────────────────────────────────────────────── */

type RawKanbanLoop = KanbanLoop & {
  isActive?: boolean;
  status?: string;
  safetyStockDays?: number | string | null;
  reorderPoint?: number | string | null;
};

interface RawKanbanParameterHistoryRecord {
  changeType?: string | null;
  previousMinQuantity?: number | null;
  newMinQuantity?: number | null;
  previousOrderQuantity?: number | null;
  newOrderQuantity?: number | null;
  previousNumberOfCards?: number | null;
  newNumberOfCards?: number | null;
  createdAt?: string | null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeLoop(loop: RawKanbanLoop): KanbanLoop {
  const status =
    typeof loop.status === "string" && loop.status.length > 0
      ? loop.status
      : loop.isActive === false
        ? "paused"
        : "active";

  return {
    ...loop,
    status,
    safetyStockDays: toFiniteNumberOrNull(loop.safetyStockDays),
    reorderPoint: toFiniteNumberOrNull(loop.reorderPoint),
  };
}

function normalizeParameterHistory(
  history: RawKanbanParameterHistoryRecord[] | undefined,
): Array<{ parameter: string; oldValue: string; newValue: string; changedAt: string }> | undefined {
  if (!history) return undefined;

  return history.flatMap((entry) => {
    const changedAt = entry.createdAt ?? new Date().toISOString();
    const changes: Array<{ parameter: string; oldValue: string; newValue: string; changedAt: string }> = [];

    const maybePushChange = (
      parameter: string,
      previousValue: number | null | undefined,
      newValue: number | null | undefined,
    ) => {
      if (previousValue === null || previousValue === undefined) return;
      if (newValue === null || newValue === undefined) return;
      if (previousValue === newValue) return;
      changes.push({
        parameter,
        oldValue: String(previousValue),
        newValue: String(newValue),
        changedAt,
      });
    };

    maybePushChange("Min Quantity", entry.previousMinQuantity, entry.newMinQuantity);
    maybePushChange("Order Quantity", entry.previousOrderQuantity, entry.newOrderQuantity);
    maybePushChange("Number of Cards", entry.previousNumberOfCards, entry.newNumberOfCards);

    if (changes.length > 0) return changes;

    return [
      {
        parameter: entry.changeType ?? "Parameters",
        oldValue: "--",
        newValue: "--",
        changedAt,
      },
    ];
  });
}

export async function fetchLoops(
  token: string,
  params?: { loopType?: LoopType; facilityId?: string; partId?: string; page?: number; pageSize?: number },
): Promise<{ data: KanbanLoop[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  const qs = new URLSearchParams();
  if (params?.loopType) qs.set("loopType", params.loopType);
  if (params?.facilityId) qs.set("facilityId", params.facilityId);
  if (params?.partId) qs.set("partId", params.partId);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const response = await apiRequest<{ data: RawKanbanLoop[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(
    `/api/kanban/loops${suffix}`,
    { token },
  );

  return {
    ...response,
    data: response.data.map((loop) => normalizeLoop(loop)),
  };
}

export async function fetchLoop(
  token: string,
  loopId: string,
): Promise<KanbanLoop & { cards?: KanbanCard[]; parameterHistory?: Array<{ parameter: string; oldValue: string; newValue: string; changedAt: string }> }> {
  const response = await apiRequest<
    RawKanbanLoop & {
      cards?: KanbanCard[];
      parameterHistory?: RawKanbanParameterHistoryRecord[];
    }
  >(`/api/kanban/loops/${encodeURIComponent(loopId)}`, { token });

  return {
    ...normalizeLoop(response),
    cards: response.cards,
    parameterHistory: normalizeParameterHistory(response.parameterHistory),
  };
}

export async function createLoop(
  token: string,
  input: {
    partId: string;
    facilityId: string;
    loopType: LoopType;
    cardMode?: "single" | "multi";
    numberOfCards?: number;
    minQuantity: number;
    orderQuantity: number;
    statedLeadTimeDays?: number;
    primarySupplierId?: string;
    sourceFacilityId?: string;
    storageLocationId?: string;
    safetyStockDays?: string;
    notes?: string;
  },
): Promise<KanbanLoop> {
  const response = await apiRequest<RawKanbanLoop | { loop: RawKanbanLoop; cards: KanbanCard[] }>(
    "/api/kanban/loops",
    {
      method: "POST",
      token,
      body: input,
    },
  );

  const rawLoop = "loop" in response ? response.loop : response;
  return normalizeLoop(rawLoop);
}

export async function updateLoopParameters(
  token: string,
  loopId: string,
  input: {
    minQuantity?: number;
    orderQuantity?: number;
    numberOfCards?: number;
    statedLeadTimeDays?: number;
    safetyStockDays?: number;
    reason: string;
  },
): Promise<KanbanLoop> {
  const response = await apiRequest<RawKanbanLoop>(`/api/kanban/loops/${encodeURIComponent(loopId)}/parameters`, {
    method: "PATCH",
    token,
    body: input,
  });

  return normalizeLoop(response);
}

/* ── Kanban Cards ─────────────────────────────────────────────── */

export async function fetchLoopCardSummary(
  token: string,
  loopId: string,
): Promise<LoopCardSummary> {
  return apiRequest(`/api/kanban/lifecycle/loops/${encodeURIComponent(loopId)}/card-summary`, { token });
}

export async function fetchLoopVelocity(
  token: string,
  loopId: string,
): Promise<LoopVelocity> {
  return apiRequest(`/api/kanban/velocity/${encodeURIComponent(loopId)}`, { token });
}

/* ── Kanban Cards ─────────────────────────────────────────────── */

export async function fetchCards(
  token: string,
  params?: { stage?: CardStage; loopId?: string; page?: number; pageSize?: number },
): Promise<{ data: KanbanCard[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  const qs = new URLSearchParams();
  if (params?.stage) qs.set("stage", params.stage);
  if (params?.loopId) qs.set("loopId", params.loopId);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(`/api/kanban/cards${suffix}`, { token });
}

export async function fetchCard(token: string, cardId: string): Promise<KanbanCard> {
  return apiRequest(`/api/kanban/cards/${encodeURIComponent(cardId)}`, { token });
}

export async function transitionCard(
  token: string,
  cardId: string,
  input: { toStage: CardStage; method?: string; notes?: string },
): Promise<{ card: KanbanCard; transition: CardTransition }> {
  return apiRequest(`/api/kanban/lifecycle/cards/${encodeURIComponent(cardId)}/transition`, {
    method: "POST",
    token,
    body: input,
  });
}

export async function fetchCardHistory(
  token: string,
  cardId: string,
): Promise<CardTransition[]> {
  const response = await apiRequest<{ data: CardTransition[] }>(
    `/api/kanban/lifecycle/cards/${encodeURIComponent(cardId)}/events`,
    { token },
  );
  return response.data ?? [];
}

export async function fetchCardQR(
  token: string,
  cardId: string,
): Promise<{ qrDataUrl: string }> {
  const response = await apiRequest<{ qrDataUrl?: string; qrCode?: string }>(
    `/api/kanban/cards/${encodeURIComponent(cardId)}/qr?format=data_url`,
    { token },
  );
  return { qrDataUrl: response.qrDataUrl ?? response.qrCode ?? "" };
}

/* ── Purchase Orders ──────────────────────────────────────────── */

export async function fetchPurchaseOrders(
  token: string,
  params?: { status?: POStatus; page?: number; pageSize?: number },
): Promise<{ data: PurchaseOrder[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(`/api/orders/purchase-orders${suffix}`, { token });
}

export async function fetchPurchaseOrder(
  token: string,
  poId: string,
): Promise<PurchaseOrder> {
  return apiRequest(`/api/orders/purchase-orders/${encodeURIComponent(poId)}`, { token });
}

export async function createPurchaseOrder(
  token: string,
  input: {
    supplierId: string;
    facilityId: string;
    orderDate?: string;
    expectedDeliveryDate: string;
    currency?: string;
    notes?: string | null;
    internalNotes?: string | null;
    paymentTerms?: string | null;
    shippingTerms?: string | null;
    lines: Array<{
      partId: string;
      kanbanCardId?: string | null;
      lineNumber: number;
      quantityOrdered: number;
      unitCost: number;
      notes?: string | null;
    }>;
  },
): Promise<PurchaseOrder> {
  const response = await apiRequest<{ data: PurchaseOrder }>(
    "/api/orders/purchase-orders",
    {
      method: "POST",
      token,
      body: input,
    }
  );
  return response.data;
}

export async function updatePurchaseOrder(
  token: string,
  poId: string,
  input: {
    expectedDeliveryDate?: string;
    paymentTerms?: string | null;
    shippingTerms?: string | null;
    notes?: string | null;
    internalNotes?: string | null;
  },
): Promise<PurchaseOrder> {
  const response = await apiRequest<{ data: PurchaseOrder }>(
    `/api/orders/purchase-orders/${encodeURIComponent(poId)}`,
    {
      method: "PATCH",
      token,
      body: input,
    }
  );
  return response.data;
}

export async function updatePurchaseOrderStatus(
  token: string,
  poId: string,
  input: { status: POStatus; notes?: string; cancelReason?: string },
): Promise<PurchaseOrder> {
  return apiRequest(`/api/orders/purchase-orders/${encodeURIComponent(poId)}/status`, {
    method: "PATCH",
    token,
    body: input,
  });
}

export async function sendPurchaseOrderEmailDraft(
  token: string,
  poId: string,
  input: {
    to?: string;
    cc?: string[];
    subject?: string;
    bodyText?: string;
    bodyHtml?: string;
    includeAttachment?: boolean;
  },
): Promise<{
  messageId: string;
  to: string;
  cc: string[];
  subject: string;
  attachmentIncluded: boolean;
  poId: string;
  poNumber: string;
}> {
  const response = await apiRequest<{
    success: boolean;
    data: {
      messageId: string;
      to: string;
      cc: string[];
      subject: string;
      attachmentIncluded: boolean;
      poId: string;
      poNumber: string;
    };
  }>(`/api/orders/purchase-orders/${encodeURIComponent(poId)}/send-email-draft`, {
    method: "POST",
    token,
    body: input,
  });

  return response.data;
}

/* ── Work Orders ──────────────────────────────────────────────── */

export async function fetchWorkOrders(
  token: string,
  params?: { page?: number; pageSize?: number },
): Promise<{ data: WorkOrder[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(`/api/orders/work-orders${suffix}`, { token });
}

/* ── Transfer Orders ──────────────────────────────────────────── */

export async function fetchTransferOrders(
  token: string,
  params?: { page?: number; pageSize?: number; status?: TOStatus },
): Promise<{ data: TransferOrder[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(`/api/orders/transfer-orders${suffix}`, { token });
}

export async function fetchTransferOrder(
  token: string,
  id: string,
): Promise<{ data: TransferOrder }> {
  return apiRequest(`/api/orders/transfer-orders/${encodeURIComponent(id)}`, { token });
}

export async function createTransferOrder(
  token: string,
  input: {
    sourceFacilityId: string;
    destinationFacilityId: string;
    notes?: string;
    lines: Array<{
      partId: string;
      quantityRequested: number;
      notes?: string;
    }>;
  },
): Promise<{ data: TransferOrder }> {
  return apiRequest("/api/orders/transfer-orders", {
    method: "POST",
    token,
    body: input,
  });
}

export async function updateTransferOrderStatus(
  token: string,
  id: string,
  input: { status: TOStatus; reason?: string },
): Promise<{ data: TransferOrder }> {
  return apiRequest(`/api/orders/transfer-orders/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    token,
    body: input,
  });
}

export async function fetchTransferOrderTransitions(
  token: string,
  id: string,
): Promise<{ data: { currentStatus: TOStatus; validTransitions: TOStatus[] } }> {
  return apiRequest(`/api/orders/transfer-orders/${encodeURIComponent(id)}/transitions`, { token });
}

export async function fetchSourceRecommendations(
  token: string,
  params: { destinationFacilityId: string; partId: string; minQty?: number; limit?: number },
): Promise<{ data: SourceRecommendation[] }> {
  const qs = new URLSearchParams();
  qs.set("destinationFacilityId", params.destinationFacilityId);
  qs.set("partId", params.partId);
  if (params.minQty != null) qs.set("minQty", String(params.minQty));
  if (params.limit != null) qs.set("limit", String(params.limit));
  return apiRequest(`/api/orders/transfer-orders/recommendations/source?${qs.toString()}`, { token });
}

export async function fetchInventoryByFacility(
  token: string,
  facilityId: string,
  params?: { page?: number; pageSize?: number },
): Promise<{ data: InventoryLedgerEntry[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(`/api/inventory/facility/${encodeURIComponent(facilityId)}${suffix}`, { token });
}

/* ── Receiving ────────────────────────────────────────────────── */

export async function createReceipt(
  token: string,
  input: {
    orderId: string;
    orderType: string;
    lines: Array<{
      partId: string;
      quantityAccepted: number;
      quantityDamaged?: number;
      quantityRejected?: number;
      notes?: string;
    }>;
    notes?: string;
  },
): Promise<Receipt> {
  return apiRequest("/api/orders/receiving", {
    method: "POST",
    token,
    body: input,
  });
}

export async function fetchReceivingMetrics(token: string): Promise<ReceivingMetrics> {
  return apiRequest("/api/orders/receiving/metrics", { token });
}

export async function fetchReceivingExceptions(
  token: string,
  params?: { page?: number; pageSize?: number },
): Promise<{ data: ReceivingException[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiRequest(`/api/orders/receiving/exceptions${suffix}`, { token });
}

export async function resolveReceivingException(
  token: string,
  exceptionId: string,
  input: { resolution: ExceptionResolution; notes?: string },
): Promise<ReceivingException> {
  return apiRequest(`/api/orders/receiving/exceptions/${encodeURIComponent(exceptionId)}/resolve`, {
    method: "PATCH",
    token,
    body: { resolutionType: input.resolution, resolutionNotes: input.notes },
  });
}

export async function fetchReceiptsForOrder(
  token: string,
  orderId: string,
): Promise<Receipt[]> {
  const response = await apiRequest<{ data: Receipt[] }>(
    `/api/orders/receiving/order/${encodeURIComponent(orderId)}`,
    { token },
  );
  return response.data ?? [];
}
