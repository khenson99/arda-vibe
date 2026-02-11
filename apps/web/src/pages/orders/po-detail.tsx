import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { AuthSession, POStatus } from "@/types";
import { usePurchaseOrderDetail } from "@/hooks/use-purchase-order-detail";
import { POHeader, POHeaderSkeleton } from "@/components/orders/po-header";
import {
  POLineItems,
  POLineItemsSkeleton,
} from "@/components/orders/po-line-items";
import {
  POTimeline,
  POTimelineSkeleton,
  POReceiving,
} from "@/components/orders/po-timeline";
import { POApprovalModal } from "@/components/orders/po-approval-modal";
import {
  Button,
  Card,
  CardContent,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui";
import { ArrowLeft, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { parseApiError, updatePurchaseOrderStatus } from "@/lib/api-client";

/* ── Props ─────────────────────────────────────────────────── */

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

/* ── Tab type ──────────────────────────────────────────────── */

type DetailTab = "lines" | "timeline" | "receiving";

/* ── Component ─────────────────────────────────────────────── */

export function PODetailRoute({ session, onUnauthorized }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = React.useState<DetailTab>("lines");
  const [approvalModalOpen, setApprovalModalOpen] = React.useState(false);

  const {
    po,
    loading,
    error,
    receipts,
    receiptsLoading,
    statusUpdating,
    updateStatus,
    refresh,
  } = usePurchaseOrderDetail({
    token: session.tokens.accessToken,
    poId: id ?? "",
    onUnauthorized,
  });

  const handleBack = React.useCallback(() => {
    navigate("/orders");
  }, [navigate]);

  const handleEdit = React.useCallback(() => {
    if (!id) return;
    navigate(`/orders/po/${id}/edit`);
  }, [id, navigate]);

  const handleStatusChange = React.useCallback(
    async (status: POStatus) => {
      // If transitioning to approved, show approval modal
      if (status === "approved" && po?.status === "pending_approval") {
        setApprovalModalOpen(true);
        return;
      }

      try {
        const cancelReason =
          status === "cancelled" ? "Cancelled from PO detail page" : undefined;
        const ok = await updateStatus(status, undefined, cancelReason);
        if (ok) {
          const label =
            status === "pending_approval"
              ? "Submitted for Approval"
              : status.charAt(0).toUpperCase() +
                status.slice(1).replace(/_/g, " ");
          toast.success(`Status updated to ${label}`);
        }
      } catch (err) {
        toast.error(parseApiError(err));
      }
    },
    [updateStatus, po?.status],
  );

  const handleApprove = React.useCallback(
    async (poId: string, notes?: string) => {
      try {
        await updatePurchaseOrderStatus(session.tokens.accessToken, poId, {
          status: "approved",
          notes,
        });
        toast.success("Purchase order approved");
        refresh();
      } catch (err) {
        if (parseApiError(err).includes("unauthorized")) {
          onUnauthorized();
        }
        throw err;
      }
    },
    [session.tokens.accessToken, refresh, onUnauthorized],
  );

  const handleReject = React.useCallback(
    async (poId: string, reason: string) => {
      try {
        await updatePurchaseOrderStatus(session.tokens.accessToken, poId, {
          status: "draft",
          cancelReason: reason,
        });
        toast.success("Purchase order rejected");
        refresh();
      } catch (err) {
        if (parseApiError(err).includes("unauthorized")) {
          onUnauthorized();
        }
        throw err;
      }
    },
    [session.tokens.accessToken, refresh, onUnauthorized],
  );

  const handlePrint = React.useCallback(() => {
    window.print();
  }, []);

  /* Loading state */
  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <POHeaderSkeleton />
        <POLineItemsSkeleton />
        <POTimelineSkeleton />
      </div>
    );
  }

  /* Error state */
  if (error) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-400" />
            <p className="text-sm text-red-600 mb-3">{error}</p>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* No PO found */
  if (!po) {
    return (
      <div className="space-y-4 p-4">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
        </Button>
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Purchase order not found.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {/* Back navigation */}
      <Button variant="ghost" size="sm" onClick={handleBack}>
        <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Orders
      </Button>

      {/* Header */}
      <POHeader
        po={po}
        onEdit={handleEdit}
        onPrint={handlePrint}
        onStatusChange={handleStatusChange}
        statusUpdating={statusUpdating}
      />

      {/* Tabs */}
      <Tabs>
        <TabsList>
          <TabsTrigger
            active={activeTab === "lines"}
            onClick={() => setActiveTab("lines")}
          >
            Line Items{po.lines ? ` (${po.lines.length})` : ""}
          </TabsTrigger>
          <TabsTrigger
            active={activeTab === "timeline"}
            onClick={() => setActiveTab("timeline")}
          >
            Timeline
          </TabsTrigger>
          <TabsTrigger
            active={activeTab === "receiving"}
            onClick={() => setActiveTab("receiving")}
          >
            Receiving{receipts.length > 0 ? ` (${receipts.length})` : ""}
          </TabsTrigger>
        </TabsList>

        {activeTab === "lines" && (
          <TabsContent>
            <POLineItems lines={po.lines ?? []} currency={po.currency} />
          </TabsContent>
        )}

        {activeTab === "timeline" && (
          <TabsContent>
            <POTimeline po={po} />
          </TabsContent>
        )}

        {activeTab === "receiving" && (
          <TabsContent>
            <POReceiving receipts={receipts} loading={receiptsLoading} />
          </TabsContent>
        )}
      </Tabs>

      {/* Approval Modal */}
      <POApprovalModal
        open={approvalModalOpen}
        onOpenChange={setApprovalModalOpen}
        po={po}
        onApprove={handleApprove}
        onReject={handleReject}
        loading={statusUpdating}
      />
    </div>
  );
}
