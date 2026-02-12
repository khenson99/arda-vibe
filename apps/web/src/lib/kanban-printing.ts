import type { CardFormat } from "@arda/shared-types";
import { dispatchPrint, getDefaultSettings, openPrintWindow } from "@/components/printing/print-pipeline";
import type { KanbanPrintData } from "@/components/printing/types";
import { createPrintJob, fetchCardPrintDetail, isUnauthorized, parseApiError } from "@/lib/api-client";
import type { KanbanCardPrintDetail } from "@/lib/api-client";
import type { CardStage, LoopType } from "@/types";

export const DEFAULT_ONE_CLICK_PRINT_FORMAT: CardFormat = "3x5_card";
export const POPUP_BLOCKED_MESSAGE = "Pop-up blocked. Please allow pop-ups for this site to print.";

interface PrintDataDefaults {
  tenantName?: string;
  tenantLogoUrl?: string;
}

export interface PrintCardsFromIdsInput extends PrintDataDefaults {
  token: string;
  cardIds: string[];
  format?: CardFormat;
  onUnauthorized?: () => void;
  overridesByCardId?: Record<string, Partial<KanbanPrintData>>;
}

export interface PrintCardsFromIdsResult {
  printedCount: number;
  format: CardFormat;
  auditJobId?: string;
  auditError?: string;
}

const LOOP_TYPES: LoopType[] = ["procurement", "production", "transfer"];
const CARD_STAGES: CardStage[] = ["created", "triggered", "ordered", "in_transit", "received", "restocked"];
const FALLBACK_QR_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toLoopType(value: unknown): LoopType {
  return LOOP_TYPES.includes(value as LoopType) ? (value as LoopType) : "procurement";
}

function toCardStage(value: unknown): CardStage {
  return CARD_STAGES.includes(value as CardStage) ? (value as CardStage) : "created";
}

function toPositiveInt(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cleanString(value: unknown, fallback = ""): string {
  return isNonEmptyString(value) ? value.trim() : fallback;
}

function formatQty(value: unknown): string {
  const qty = toNonNegativeNumber(value, 0);
  const unit = qty === 1 ? "each" : "each";
  return `${qty} ${unit}`;
}

export function mapCardPrintDetailToPrintData(
  card: KanbanCardPrintDetail,
  defaults: PrintDataDefaults = {},
): KanbanPrintData {
  const loop = card.loop ?? null;
  const cardNumber = toPositiveInt(card.cardNumber, 1);
  const totalCards = Math.max(cardNumber, toPositiveInt(loop?.numberOfCards, cardNumber));
  const partNumber = cleanString(loop?.partNumber ?? card.partName ?? loop?.partName, `Card-${cardNumber}`);

  return {
    cardId: card.id,
    cardNumber,
    totalCards,
    partNumber,
    partDescription: cleanString(loop?.partDescription ?? card.partName, partNumber),
    sku: cleanString(loop?.partNumber ?? partNumber, partNumber),
    loopType: toLoopType(card.loopType ?? loop?.loopType),
    currentStage: toCardStage(card.currentStage),
    facilityName: cleanString(card.facilityName ?? loop?.facilityName, "Unknown Facility"),
    storageLocation: isNonEmptyString(loop?.storageLocationName) ? loop.storageLocationName.trim() : undefined,
    supplierName: isNonEmptyString(loop?.primarySupplierName) ? loop.primarySupplierName.trim() : undefined,
    sourceFacilityName: isNonEmptyString(loop?.sourceFacilityName) ? loop.sourceFacilityName.trim() : undefined,
    orderQuantity: toNonNegativeNumber(card.orderQuantity ?? loop?.orderQuantity, 0),
    minQuantity: toNonNegativeNumber(card.minQuantity ?? loop?.minQuantity, 0),
    statedLeadTimeDays: loop?.statedLeadTimeDays ?? undefined,
    safetyStockDays: loop?.safetyStockDays ?? undefined,
    qrCodeDataUrl: cleanString(card.qrCode, FALLBACK_QR_DATA_URL),
    scanUrl: cleanString(card.scanUrl),
    tenantName: cleanString(defaults.tenantName, "Tenant"),
    tenantLogoUrl: isNonEmptyString(defaults.tenantLogoUrl) ? defaults.tenantLogoUrl.trim() : undefined,
    notes: isNonEmptyString(loop?.notes) ? loop.notes.trim() : undefined,
    notesText: cleanString(loop?.itemNotes ?? loop?.notes, ""),
    imageUrl: cleanString(loop?.imageUrl, ""),
    minimumText: formatQty(card.minQuantity ?? loop?.minQuantity),
    locationText: cleanString(loop?.storageLocationName ?? card.facilityName ?? loop?.facilityName, "Location TBD"),
    orderText: formatQty(card.orderQuantity ?? loop?.orderQuantity),
    supplierText: cleanString(
      loop?.primarySupplierName ?? loop?.sourceFacilityName ?? card.facilityName,
      "Unknown supplier",
    ),
    accentColor: "#2F6FCC",
    showArdaWatermark: false,
  };
}

export async function printCardsFromIds(input: PrintCardsFromIdsInput): Promise<PrintCardsFromIdsResult> {
  const format = input.format ?? DEFAULT_ONE_CLICK_PRINT_FORMAT;
  const uniqueCardIds = [...new Set(input.cardIds.map((id) => id.trim()).filter(Boolean))];

  if (uniqueCardIds.length === 0) {
    throw new Error("No kanban cards selected for printing.");
  }

  const printWindow = openPrintWindow();
  if (!printWindow) {
    throw new Error(POPUP_BLOCKED_MESSAGE);
  }

  try {
    const details = await Promise.all(
      uniqueCardIds.map((cardId) => fetchCardPrintDetail(input.token, cardId)),
    );
    const printData = details.map((detail) => {
      const base = mapCardPrintDetailToPrintData(detail, input);
      const overrides = input.overridesByCardId?.[detail.id];
      if (!overrides) return base;
      return {
        ...base,
        ...overrides,
        cardId: base.cardId,
      };
    });

    dispatchPrint(printData, format, getDefaultSettings(format), { printWindow });

    let auditJobId: string | undefined;
    let auditError: string | undefined;

    try {
      const job = await createPrintJob(input.token, { cardIds: uniqueCardIds, format });
      auditJobId = job.id;
    } catch (err) {
      if (isUnauthorized(err)) {
        input.onUnauthorized?.();
      }
      auditError = parseApiError(err);
    }

    return {
      printedCount: printData.length,
      format,
      auditJobId,
      auditError,
    };
  } catch (err) {
    try {
      printWindow.close();
    } catch {
      // Ignore close errors for browser-managed windows.
    }

    if (isUnauthorized(err)) {
      input.onUnauthorized?.();
    }
    throw err;
  }
}
