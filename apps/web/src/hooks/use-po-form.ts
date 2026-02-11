/**
 * usePOForm — Hook for PO create/edit form API integration
 *
 * Loads suppliers & facilities, provides submit handler that calls
 * createPurchaseOrder or updatePurchaseOrder, and manages loading/error state.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  createPurchaseOrder,
  updatePurchaseOrder,
  fetchSuppliers,
  fetchFacilities,
  isUnauthorized,
  parseApiError,
} from "@/lib/api-client";
import type { PurchaseOrder, SupplierRecord, FacilityRecord } from "@/types";
import type { POFormInput } from "@/components/orders/po-form";

interface UsePOFormOptions {
  token: string;
  /** Pass existing PO for edit mode; omit for create mode */
  po?: PurchaseOrder;
  onUnauthorized: () => void;
  /** Called after successful create/update with the resulting PO */
  onSuccess?: (po: PurchaseOrder) => void;
}

export function usePOForm({
  token,
  po,
  onUnauthorized,
  onSuccess,
}: UsePOFormOptions) {
  const mode = po ? "edit" : "create";

  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [facilities, setFacilities] = useState<FacilityRecord[]>([]);
  const [lookupLoading, setLookupLoading] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Load suppliers & facilities on mount
  useEffect(() => {
    let cancelled = false;
    setLookupLoading(true);

    Promise.all([
      fetchSuppliers(token, { pageSize: 200 }),
      fetchFacilities(token, { pageSize: 200 }),
    ])
      .then(([suppliersRes, facilitiesRes]) => {
        if (cancelled) return;
        setSuppliers(suppliersRes.data);
        setFacilities(facilitiesRes.data);
      })
      .catch((err) => {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setError(parseApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLookupLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized]);

  const handleSubmit = useCallback(
    async (data: POFormInput) => {
      setSubmitting(true);
      setError(null);

      try {
        let result: PurchaseOrder;

        if (mode === "create") {
          result = await createPurchaseOrder(token, {
            supplierId: data.supplierId,
            facilityId: data.facilityId,
            orderDate: data.orderDate,
            expectedDeliveryDate: data.expectedDeliveryDate,
            currency: data.currency,
            notes: data.notes,
            internalNotes: data.internalNotes,
            paymentTerms: data.paymentTerms,
            shippingTerms: data.shippingTerms,
            lines: data.lines.map((line) => ({
              partId: line.partId,
              kanbanCardId: line.kanbanCardId,
              lineNumber: line.lineNumber,
              quantityOrdered: line.quantityOrdered,
              unitCost: line.unitCost,
              notes: line.notes,
            })),
          });
        } else {
          if (!po) throw new Error("PO is required for edit mode");
          result = await updatePurchaseOrder(token, po.id, {
            expectedDeliveryDate: data.expectedDeliveryDate,
            paymentTerms: data.paymentTerms,
            shippingTerms: data.shippingTerms,
            notes: data.notes,
            internalNotes: data.internalNotes,
          });
        }

        if (!isMountedRef.current) return;
        onSuccess?.(result);
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setError(parseApiError(err));
      } finally {
        if (isMountedRef.current) setSubmitting(false);
      }
    },
    [token, mode, po, onUnauthorized, onSuccess],
  );

  return {
    mode: mode as "create" | "edit",
    suppliers,
    facilities,
    lookupLoading,
    submitting,
    error,
    handleSubmit,
  };
}
