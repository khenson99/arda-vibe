/**
 * POFormPage — Purchase Order create/edit page
 *
 * Dedicated page for creating new POs or editing existing draft/pending POs.
 * Uses the existing POForm component.
 */

import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { AuthSession, PurchaseOrder, SupplierRecord, FacilityRecord } from "@/types";
import {
  isUnauthorized,
  parseApiError,
  fetchPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  fetchSuppliers,
  fetchFacilities,
} from "@/lib/api-client";
import { POForm, type POFormInput } from "@/components/orders/po-form";
import { Button, Card, CardContent, Skeleton } from "@/components/ui";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { toast } from "sonner";

/* ── Props ─────────────────────────────────────────────────── */

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

/* ── Component ─────────────────────────────────────────────── */

export function POFormPage({ session, onUnauthorized }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = id && id !== "new";

  const [po, setPo] = React.useState<PurchaseOrder | null>(null);
  const [suppliers, setSuppliers] = React.useState<SupplierRecord[]>([]);
  const [facilities, setFacilities] = React.useState<FacilityRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const isMountedRef = React.useRef(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [suppliersRes, facilitiesRes] = await Promise.all([
        fetchSuppliers(session.tokens.accessToken),
        fetchFacilities(session.tokens.accessToken),
      ]);

      if (!isMountedRef.current) return;

      setSuppliers(suppliersRes.data);
      setFacilities(facilitiesRes.data);

      if (isEdit && id) {
        const poRes = await fetchPurchaseOrder(session.tokens.accessToken, id);
        if (!isMountedRef.current) return;

        // Unwrap data if nested
        const poData = (poRes && typeof poRes === "object" && "data" in poRes)
          ? (poRes as unknown as { data: PurchaseOrder }).data
          : poRes;

        setPo(poData);

        // Validate that PO can be edited
        if (poData.status !== "draft" && poData.status !== "pending_approval") {
          setError("This purchase order cannot be edited in its current status.");
        }
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [session.tokens.accessToken, isEdit, id, onUnauthorized]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSubmit = React.useCallback(
    async (data: POFormInput) => {
      setSubmitting(true);
      setError(null);

      try {
        if (isEdit && id) {
          // Update existing PO
          await updatePurchaseOrder(session.tokens.accessToken, id, {
            expectedDeliveryDate: data.expectedDeliveryDate,
            paymentTerms: data.paymentTerms,
            shippingTerms: data.shippingTerms,
            notes: data.notes,
            internalNotes: data.internalNotes,
          });
          toast.success("Purchase order updated successfully");
          navigate(`/orders/po/${id}`);
        } else {
          // Create new PO
          const response = await createPurchaseOrder(session.tokens.accessToken, data);

          // Unwrap data if nested
          const created = (response && typeof response === "object" && "data" in response)
            ? (response as unknown as { data: PurchaseOrder }).data
            : response;

          toast.success("Purchase order created successfully");
          navigate(`/orders/po/${created.id}`);
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setError(parseApiError(err));
        toast.error("Failed to save purchase order");
      } finally {
        if (isMountedRef.current) setSubmitting(false);
      }
    },
    [session.tokens.accessToken, isEdit, id, navigate, onUnauthorized],
  );

  const handleCancel = React.useCallback(() => {
    if (isEdit && id) {
      navigate(`/orders/po/${id}`);
    } else {
      navigate("/orders");
    }
  }, [isEdit, id, navigate]);

  /* Loading state */
  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleCancel}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <Card className="rounded-xl">
          <CardContent className="p-4 space-y-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      </div>
    );
  }

  /* Error state */
  if (error) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleCancel}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-400" />
            <p className="text-sm text-red-600 mb-3">{error}</p>
            <Button variant="outline" size="sm" onClick={loadData}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {/* Back navigation */}
      <Button variant="ghost" size="sm" onClick={handleCancel}>
        <ArrowLeft className="mr-1.5 h-4 w-4" />{" "}
        {isEdit ? "Back to PO Detail" : "Back to Orders"}
      </Button>

      {/* Form */}
      <POForm
        mode={isEdit ? "edit" : "create"}
        po={po || undefined}
        suppliers={suppliers}
        facilities={facilities}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        loading={submitting}
        error={error}
      />
    </div>
  );
}
