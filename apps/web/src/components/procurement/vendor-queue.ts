import { normalizePartLinkId } from "@/lib/part-linking";
import type { PartRecord, ProcurementOrderMethod, QueueCard } from "@/types";
import {
  normalizeProcurementOrderMethod,
  procurementOrderMethodLabel,
} from "./order-method";

export interface VendorQueueLine {
  card: QueueCard;
  part: PartRecord | undefined;
  partName: string;
  orderMethod: ProcurementOrderMethod | null;
  orderMethodLabel: string;
  orderMethodError: string | null;
  draftPurchaseOrderId: string | null;
}

export interface VendorQueueGroup {
  supplierId: string | null;
  supplierName: string;
  supplierContactEmail: string | null;
  supplierContactPhone: string | null;
  lines: VendorQueueLine[];
  methods: ProcurementOrderMethod[];
  facilityCounts: Record<string, number>;
  draftPurchaseOrderIds: string[];
  hasUnknownMethods: boolean;
}

export function buildVendorQueueGroups(input: {
  cards: QueueCard[];
  parts: PartRecord[];
}): VendorQueueGroup[] {
  const partById = new Map<string, PartRecord>();
  for (const part of input.parts) {
    const linkId = normalizePartLinkId(part.id) ?? part.id;
    if (!partById.has(linkId)) {
      partById.set(linkId, part);
    }
    if (part.eId) {
      const eId = normalizePartLinkId(part.eId) ?? part.eId;
      if (!partById.has(eId)) {
        partById.set(eId, part);
      }
    }
    if (part.externalGuid) {
      const guid = normalizePartLinkId(part.externalGuid) ?? part.externalGuid;
      if (!partById.has(guid)) {
        partById.set(guid, part);
      }
    }
  }

  const grouped = new Map<string, VendorQueueGroup>();

  for (const card of input.cards) {
    const supplierKey = card.primarySupplierId ?? `missing:${card.id}`;
    const partId = normalizePartLinkId(card.partId) ?? card.partId;
    const part = partById.get(partId);

    const candidateOrderMethod = part ? (part.orderMechanism ?? 'purchase_order') : null;
    let orderMethod: ProcurementOrderMethod | null = null;
    let orderMethodError: string | null = null;
    try {
      orderMethod = normalizeProcurementOrderMethod(candidateOrderMethod);
    } catch (error) {
      orderMethodError = error instanceof Error ? error.message : "Unsupported order method";
    }

    const orderMethodLabel = orderMethod
      ? procurementOrderMethodLabel(orderMethod)
      : (candidateOrderMethod ?? "Unknown");

    const group =
      grouped.get(supplierKey) ??
      {
        supplierId: card.primarySupplierId ?? null,
        supplierName: card.supplierName ?? "Unassigned vendor",
        supplierContactEmail: card.supplierContactEmail ?? null,
        supplierContactPhone: card.supplierContactPhone ?? null,
        lines: [],
        methods: [],
        facilityCounts: {},
        draftPurchaseOrderIds: [],
        hasUnknownMethods: false,
      };

    if (orderMethod && !group.methods.includes(orderMethod)) {
      group.methods.push(orderMethod);
    }
    if (orderMethodError) {
      group.hasUnknownMethods = true;
    }

    group.facilityCounts[card.facilityId] = (group.facilityCounts[card.facilityId] ?? 0) + 1;

    if (card.draftPurchaseOrderId && !group.draftPurchaseOrderIds.includes(card.draftPurchaseOrderId)) {
      group.draftPurchaseOrderIds.push(card.draftPurchaseOrderId);
    }

    group.lines.push({
      card,
      part,
      partName: part?.name ?? `Part ${card.partId}`,
      orderMethod,
      orderMethodLabel,
      orderMethodError,
      draftPurchaseOrderId: card.draftPurchaseOrderId ?? null,
    });

    grouped.set(supplierKey, group);
  }

  return Array.from(grouped.values())
    .map((group) => ({
      ...group,
      methods: [...group.methods].sort(),
      lines: [...group.lines].sort(
        (a, b) =>
          new Date(a.card.currentStageEnteredAt).getTime() -
          new Date(b.card.currentStageEnteredAt).getTime(),
      ),
    }))
    .sort((a, b) => a.supplierName.localeCompare(b.supplierName));
}
