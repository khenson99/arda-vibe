import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Input } from "@/components/ui";
import {
  updateLoopParameters,
  updateItemRecord,
  normalizeOptionalString,
  toItemsInputPayload,
  isUnauthorized,
  parseApiError,
} from "@/lib/api-client";
import { fetchLoopsForPart } from "@/lib/kanban-loops";
import type { AuthSession, KanbanLoop, PartRecord } from "@/types";
import { LOOP_META } from "@/types";

interface LoopManagementSectionProps {
  part: PartRecord;
  session: AuthSession;
  onUnauthorized: () => void;
  onSaved: () => Promise<void>;
}

export function LoopManagementSection({
  part,
  session,
  onUnauthorized,
  onSaved,
}: LoopManagementSectionProps) {
  const token = session.tokens.accessToken;
  const [loops, setLoops] = React.useState<KanbanLoop[]>([]);
  const [isLoadingLoops, setIsLoadingLoops] = React.useState(false);
  const [savingLoopId, setSavingLoopId] = React.useState<string | null>(null);
  const [loopReason, setLoopReason] = React.useState("Updated from item detail view");
  const [loopEdits, setLoopEdits] = React.useState<
    Record<string, { numberOfCards: string; minQuantity: string; orderQuantity: string }>
  >({});

  const loadLoops = React.useCallback(async () => {
    if (!part) {
      setLoops([]);
      setLoopEdits({});
      return;
    }

    setIsLoadingLoops(true);
    try {
      const matchingLoops = await fetchLoopsForPart(token, part);
      setLoops(matchingLoops);
      setLoopEdits(
        matchingLoops.reduce(
          (acc, loop) => {
            acc[loop.id] = {
              numberOfCards: String(loop.numberOfCards),
              minQuantity: String(loop.minQuantity),
              orderQuantity: String(loop.orderQuantity),
            };
            return acc;
          },
          {} as Record<string, { numberOfCards: string; minQuantity: string; orderQuantity: string }>,
        ),
      );
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
      setLoops([]);
      setLoopEdits({});
    } finally {
      setIsLoadingLoops(false);
    }
  }, [onUnauthorized, part, token]);

  React.useEffect(() => {
    void loadLoops();
  }, [loadLoops]);

  const handleProvisionFirstCard = React.useCallback(async () => {
    if (!part.eId) {
      toast.error("This item cannot auto-provision a loop yet. Refresh and try again.");
      return;
    }

    const author = normalizeOptionalString(session.user.email) || session.user.id;
    setSavingLoopId("provisioning");
    try {
      await updateItemRecord(token, {
        entityId: part.eId,
        tenantId: session.user.tenantId,
        author,
        payload: toItemsInputPayload(part),
        provisionDefaults: true,
      });
      toast.success("Created default loop and first card for this item.");
      await loadLoops();
      await onSaved();
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setSavingLoopId(null);
    }
  }, [loadLoops, onSaved, onUnauthorized, part, session.user.email, session.user.id, session.user.tenantId, token]);

  const handleAddCard = React.useCallback(
    async (loop: KanbanLoop) => {
      const reason = loopReason.trim() || "Added card from item detail view";
      const nextCardCount = Math.max(1, loop.numberOfCards + 1);
      setSavingLoopId(loop.id);
      try {
        await updateLoopParameters(token, loop.id, {
          numberOfCards: nextCardCount,
          minQuantity: loop.minQuantity,
          orderQuantity: loop.orderQuantity,
          reason,
        });
        toast.success(`Added card #${nextCardCount} to ${LOOP_META[loop.loopType].label} loop.`);
        await loadLoops();
        await onSaved();
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        toast.error(parseApiError(error));
      } finally {
        setSavingLoopId(null);
      }
    },
    [loadLoops, loopReason, onSaved, onUnauthorized, token],
  );

  const handleSaveLoop = React.useCallback(
    async (loop: KanbanLoop) => {
      const edit = loopEdits[loop.id];
      if (!edit) return;

      const parsedCardCount = Number.parseInt(edit.numberOfCards, 10);
      const parsedMinQty = Number.parseInt(edit.minQuantity, 10);
      const parsedOrderQty = Number.parseInt(edit.orderQuantity, 10);
      if (!Number.isFinite(parsedCardCount) || parsedCardCount < 1) {
        toast.error("Number of cards must be a whole number >= 1.");
        return;
      }
      if (!Number.isFinite(parsedMinQty) || parsedMinQty < 1) {
        toast.error("Loop min quantity must be a whole number >= 1.");
        return;
      }
      if (!Number.isFinite(parsedOrderQty) || parsedOrderQty < 1) {
        toast.error("Loop order quantity must be a whole number >= 1.");
        return;
      }

      const reason = loopReason.trim() || "Updated from item detail view";

      setSavingLoopId(loop.id);
      try {
        await updateLoopParameters(token, loop.id, {
          numberOfCards: parsedCardCount,
          minQuantity: parsedMinQty,
          orderQuantity: parsedOrderQty,
          reason,
        });
        toast.success(`${LOOP_META[loop.loopType].label} loop updated.`);
        await loadLoops();
        await onSaved();
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        toast.error(parseApiError(error));
      } finally {
        setSavingLoopId(null);
      }
    },
    [loadLoops, loopEdits, loopReason, onSaved, onUnauthorized, token],
  );

  return (
    <div className="space-y-3 px-4 py-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Loop Management</h3>
        <p className="text-xs text-muted-foreground">
          Manage multi-card behavior by editing each loop&apos;s card count.
        </p>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Audit reason</label>
        <Input value={loopReason} onChange={(event) => setLoopReason(event.target.value)} className="mt-1" />
      </div>

      {isLoadingLoops && (
        <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
          Loading loops...
        </div>
      )}

      {!isLoadingLoops && loops.length === 0 && (
        <div className="space-y-3 rounded-md border border-border p-3 text-xs text-muted-foreground">
          <p>No loops found for this item yet.</p>
          <Button
            size="sm"
            onClick={() => void handleProvisionFirstCard()}
            disabled={savingLoopId === "provisioning"}
          >
            {savingLoopId === "provisioning" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Provision loop + first card
          </Button>
        </div>
      )}

      {!isLoadingLoops &&
        loops.map((loop) => {
          const loopEdit = loopEdits[loop.id];
          return (
            <div key={loop.id} className="rounded-md border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{LOOP_META[loop.loopType].label}</Badge>
                  <span className="text-xs text-muted-foreground">{loop.id.slice(0, 8)}...</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={savingLoopId === loop.id}
                    onClick={() => void handleAddCard(loop)}
                  >
                    {savingLoopId === loop.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    Add card
                  </Button>
                  <Button
                    size="sm"
                    disabled={!loopEdit || savingLoopId === loop.id}
                    onClick={() => void handleSaveLoop(loop)}
                  >
                    {savingLoopId === loop.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Save loop
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground"># of cards</label>
                  <Input
                    type="number"
                    min={1}
                    value={loopEdit?.numberOfCards ?? String(loop.numberOfCards)}
                    onChange={(event) =>
                      setLoopEdits((prev) => ({
                        ...prev,
                        [loop.id]: {
                          numberOfCards: event.target.value,
                          minQuantity: prev[loop.id]?.minQuantity ?? String(loop.minQuantity),
                          orderQuantity: prev[loop.id]?.orderQuantity ?? String(loop.orderQuantity),
                        },
                      }))
                    }
                    className="mt-1 h-8"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground">Min quantity</label>
                  <Input
                    type="number"
                    min={1}
                    value={loopEdit?.minQuantity ?? String(loop.minQuantity)}
                    onChange={(event) =>
                      setLoopEdits((prev) => ({
                        ...prev,
                        [loop.id]: {
                          numberOfCards: prev[loop.id]?.numberOfCards ?? String(loop.numberOfCards),
                          minQuantity: event.target.value,
                          orderQuantity: prev[loop.id]?.orderQuantity ?? String(loop.orderQuantity),
                        },
                      }))
                    }
                    className="mt-1 h-8"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground">Order quantity</label>
                  <Input
                    type="number"
                    min={1}
                    value={loopEdit?.orderQuantity ?? String(loop.orderQuantity)}
                    onChange={(event) =>
                      setLoopEdits((prev) => ({
                        ...prev,
                        [loop.id]: {
                          numberOfCards: prev[loop.id]?.numberOfCards ?? String(loop.numberOfCards),
                          minQuantity: prev[loop.id]?.minQuantity ?? String(loop.minQuantity),
                          orderQuantity: event.target.value,
                        },
                      }))
                    }
                    className="mt-1 h-8"
                  />
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}
