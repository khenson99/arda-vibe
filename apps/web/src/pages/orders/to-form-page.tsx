/**
 * TOFormPage — Create or edit a Transfer Order
 *
 * Routes:
 *   /orders/to/new  → create mode
 *   /orders/to/:id/edit → edit mode
 */

import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, CardContent } from "@/components/ui";
import { TOForm, type TOFormInput } from "@/components/orders/to-form";
import {
  fetchFacilities,
  fetchParts,
  fetchTransferOrder,
  createTransferOrder,
  isUnauthorized,
  parseApiError,
} from "@/lib/api-client";
import type { AuthSession, FacilityRecord, PartRecord, TransferOrder } from "@/types";

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

export function TOFormPage({ session, onUnauthorized }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const mode = id ? "edit" : "create";

  const [facilities, setFacilities] = React.useState<FacilityRecord[]>([]);
  const [parts, setParts] = React.useState<PartRecord[]>([]);
  const [to, setTo] = React.useState<TransferOrder | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const token = session.tokens.accessToken;

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const promises: [
        Promise<{ data: FacilityRecord[] }>,
        ReturnType<typeof fetchParts>,
        ...(Promise<{ data: TransferOrder }>)[],
      ] = [
        fetchFacilities(token, { pageSize: 200 }),
        fetchParts(token),
      ];

      if (id) {
        promises.push(fetchTransferOrder(token, id));
      }

      const results = await Promise.all(promises);
      if (!isMountedRef.current) return;

      setFacilities(results[0].data);
      setParts(results[1].data);

      if (id && results[2]) {
        setTo((results[2] as { data: TransferOrder }).data);
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
  }, [token, id, onUnauthorized]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSubmit = React.useCallback(
    async (data: TOFormInput) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const result = await createTransferOrder(token, {
          sourceFacilityId: data.sourceFacilityId,
          destinationFacilityId: data.destinationFacilityId,
          notes: data.notes,
          lines: data.lines.map((line) => ({
            partId: line.partId,
            quantityRequested: line.quantityRequested,
          })),
        });

        if (!isMountedRef.current) return;
        toast.success("Transfer order created");
        navigate(`/orders/to/${result.data.id}`);
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setSubmitError(parseApiError(err));
      } finally {
        if (isMountedRef.current) setSubmitting(false);
      }
    },
    [token, navigate, onUnauthorized],
  );

  const handleCancel = React.useCallback(() => {
    if (id) {
      navigate(`/orders/to/${id}`);
    } else {
      navigate("/orders");
    }
  }, [id, navigate]);

  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleCancel}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

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
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <Button variant="ghost" size="sm" onClick={handleCancel}>
        <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
      </Button>
      <TOForm
        mode={mode}
        to={to ?? undefined}
        facilities={facilities}
        parts={parts}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        loading={submitting}
        error={submitError}
      />
    </div>
  );
}
