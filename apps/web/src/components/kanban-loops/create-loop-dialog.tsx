import * as React from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import {
  Button,
  Input,
  SidePanel,
} from "@/components/ui";
import {
  ApiError,
  isUnauthorized,
  parseApiError,
  createLoop,
  fetchFacilities,
  fetchParts,
  fetchStorageLocations,
  fetchSuppliers,
} from "@/lib/api-client";
import type {
  FacilityRecord,
  LoopType,
  PartRecord,
  StorageLocationRecord,
  SupplierRecord,
} from "@/types";
import { LOOP_ORDER, LOOP_META } from "@/types";

const CARD_MODE_OPTIONS = [
  { value: "single", label: "Single Card" },
  { value: "multi", label: "Multi Card" },
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_CLASS_NAME =
  "mt-1 h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function getPartLabel(part: PartRecord): string {
  const name = part.name?.trim() || part.partNumber || part.id;
  const partNumber = part.partNumber?.trim();
  if (partNumber && partNumber !== name) {
    return `${name} (${partNumber})`;
  }
  return name;
}

function getFacilityLabel(facility: FacilityRecord): string {
  const code = facility.code?.trim();
  if (code) return `${facility.name} (${code})`;
  return facility.name;
}

function getSupplierLabel(supplier: SupplierRecord): string {
  const code = supplier.code?.trim();
  if (code) return `${supplier.name} (${code})`;
  return supplier.name;
}

function getStorageLocationLabel(location: StorageLocationRecord): string {
  const code = location.code?.trim();
  if (code) return `${location.name} (${code})`;
  return location.name;
}

interface CreateLoopDialogProps {
  token: string;
  onUnauthorized: () => void;
  onCreated: () => void;
  onOpenExistingLoop?: (loopId: string) => void;
}

export function CreateLoopDialog({
  token,
  onUnauthorized,
  onCreated,
  onOpenExistingLoop,
}: CreateLoopDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  const [partId, setPartId] = React.useState("");
  const [facilityId, setFacilityId] = React.useState("");
  const [loopType, setLoopType] = React.useState<LoopType>("procurement");
  const [cardMode, setCardMode] = React.useState<"single" | "multi">("single");
  const [numberOfCards, setNumberOfCards] = React.useState("1");
  const [minQuantity, setMinQuantity] = React.useState("");
  const [orderQuantity, setOrderQuantity] = React.useState("");
  const [statedLeadTimeDays, setStatedLeadTimeDays] = React.useState("");
  const [safetyStockDays, setSafetyStockDays] = React.useState("");
  const [primarySupplierId, setPrimarySupplierId] = React.useState("");
  const [sourceFacilityId, setSourceFacilityId] = React.useState("");
  const [storageLocationId, setStorageLocationId] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const [parts, setParts] = React.useState<PartRecord[]>([]);
  const [facilities, setFacilities] = React.useState<FacilityRecord[]>([]);
  const [suppliers, setSuppliers] = React.useState<SupplierRecord[]>([]);
  const [storageLocations, setStorageLocations] = React.useState<StorageLocationRecord[]>([]);
  const [isOptionsLoading, setIsOptionsLoading] = React.useState(false);
  const [isStorageLocationsLoading, setIsStorageLocationsLoading] = React.useState(false);

  const resetForm = React.useCallback(() => {
    setPartId("");
    setFacilityId("");
    setLoopType("procurement");
    setCardMode("single");
    setNumberOfCards("1");
    setMinQuantity("");
    setOrderQuantity("");
    setStatedLeadTimeDays("");
    setSafetyStockDays("");
    setPrimarySupplierId("");
    setSourceFacilityId("");
    setStorageLocationId("");
    setNotes("");
  }, []);

  React.useEffect(() => {
    if (cardMode === "single") {
      setNumberOfCards("1");
    }
  }, [cardMode]);

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const loadOptions = async () => {
      setIsOptionsLoading(true);
      try {
        const [partsResult, facilitiesResult, suppliersResult] = await Promise.all([
          fetchParts(token),
          fetchFacilities(token, { page: 1, pageSize: 100 }),
          fetchSuppliers(token, { page: 1, pageSize: 100 }),
        ]);

        if (cancelled) return;

        const validParts = partsResult.data.filter((part) => UUID_RE.test(part.id));
        const dedupedParts = Array.from(
          new Map(validParts.map((part) => [part.id, part])).values(),
        ).sort((a, b) => getPartLabel(a).localeCompare(getPartLabel(b)));

        const sortedFacilities = [...facilitiesResult.data].sort((a, b) =>
          getFacilityLabel(a).localeCompare(getFacilityLabel(b)),
        );
        const sortedSuppliers = [...suppliersResult.data].sort((a, b) =>
          getSupplierLabel(a).localeCompare(getSupplierLabel(b)),
        );

        setParts(dedupedParts);
        setFacilities(sortedFacilities);
        setSuppliers(sortedSuppliers);

        setPartId((current) => (dedupedParts.some((part) => part.id === current) ? current : ""));
        setFacilityId((current) =>
          sortedFacilities.some((facility) => facility.id === current) ? current : "",
        );
        setPrimarySupplierId((current) =>
          sortedSuppliers.some((supplier) => supplier.id === current) ? current : "",
        );
        setSourceFacilityId((current) =>
          sortedFacilities.some((facility) => facility.id === current) ? current : "",
        );
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        toast.error(`Failed to load form options: ${parseApiError(err)}`);
      } finally {
        if (!cancelled) {
          setIsOptionsLoading(false);
        }
      }
    };

    void loadOptions();
    return () => {
      cancelled = true;
    };
  }, [open, onUnauthorized, token]);

  React.useEffect(() => {
    if (!open || !facilityId) {
      setStorageLocations([]);
      setStorageLocationId("");
      setIsStorageLocationsLoading(false);
      return;
    }

    let cancelled = false;
    const loadStorageLocations = async () => {
      setIsStorageLocationsLoading(true);
      try {
        const result = await fetchStorageLocations(token, facilityId, { page: 1, pageSize: 100 });
        if (cancelled) return;
        const sorted = [...result.data].sort((a, b) =>
          getStorageLocationLabel(a).localeCompare(getStorageLocationLabel(b)),
        );
        setStorageLocations(sorted);
        setStorageLocationId((current) =>
          sorted.some((location) => location.id === current) ? current : "",
        );
      } catch (err) {
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        toast.error(`Failed to load storage locations: ${parseApiError(err)}`);
        if (!cancelled) {
          setStorageLocations([]);
          setStorageLocationId("");
        }
      } finally {
        if (!cancelled) {
          setIsStorageLocationsLoading(false);
        }
      }
    };

    void loadStorageLocations();
    return () => {
      cancelled = true;
    };
  }, [facilityId, onUnauthorized, open, token]);

  const transferSourceFacilities = React.useMemo(
    () => facilities.filter((facility) => facility.id !== facilityId),
    [facilities, facilityId],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!partId) {
      toast.error("Item is required.");
      return;
    }
    if (!UUID_RE.test(partId)) {
      toast.error("Selected item has an invalid ID.");
      return;
    }

    if (!facilityId) {
      toast.error("Facility is required.");
      return;
    }
    if (!UUID_RE.test(facilityId)) {
      toast.error("Selected facility has an invalid ID.");
      return;
    }

    const minQtyNum = Number(minQuantity);
    if (!minQuantity.trim() || !Number.isFinite(minQtyNum) || minQtyNum <= 0 || !Number.isInteger(minQtyNum)) {
      toast.error("Min Quantity is required and must be a positive integer.");
      return;
    }

    const orderQtyNum = Number(orderQuantity);
    if (!orderQuantity.trim() || !Number.isFinite(orderQtyNum) || orderQtyNum <= 0 || !Number.isInteger(orderQtyNum)) {
      toast.error("Order Quantity is required and must be a positive integer.");
      return;
    }

    if (loopType === "procurement" && !primarySupplierId) {
      toast.error("Supplier is required for procurement loops.");
      return;
    }
    if (loopType === "procurement" && primarySupplierId && !UUID_RE.test(primarySupplierId)) {
      toast.error("Selected supplier has an invalid ID.");
      return;
    }

    if (loopType === "transfer" && !sourceFacilityId) {
      toast.error("Source facility is required for transfer loops.");
      return;
    }
    if (loopType === "transfer" && sourceFacilityId && !UUID_RE.test(sourceFacilityId)) {
      toast.error("Selected source facility has an invalid ID.");
      return;
    }

    if (storageLocationId && !UUID_RE.test(storageLocationId)) {
      toast.error("Selected storage location has an invalid ID.");
      return;
    }

    setIsSaving(true);
    try {
      const input: Parameters<typeof createLoop>[1] = {
        partId,
        facilityId,
        loopType,
        cardMode,
        minQuantity: minQtyNum,
        orderQuantity: orderQtyNum,
      };

      const cardsNum = Number(numberOfCards);
      if (Number.isFinite(cardsNum) && cardsNum > 0 && Number.isInteger(cardsNum)) {
        input.numberOfCards = cardsNum;
      }

      const leadNum = Number(statedLeadTimeDays);
      if (statedLeadTimeDays.trim() && Number.isFinite(leadNum) && leadNum > 0 && Number.isInteger(leadNum)) {
        input.statedLeadTimeDays = leadNum;
      }

      if (safetyStockDays.trim()) {
        input.safetyStockDays = safetyStockDays.trim();
      }

      if (loopType === "procurement" && primarySupplierId) {
        input.primarySupplierId = primarySupplierId;
      }

      if (loopType === "transfer" && sourceFacilityId) {
        input.sourceFacilityId = sourceFacilityId;
      }

      if (storageLocationId) {
        input.storageLocationId = storageLocationId;
      }

      if (notes.trim()) {
        input.notes = notes.trim();
      }

      await createLoop(token, input);
      toast.success("Loop created successfully.");
      resetForm();
      setOpen(false);
      onCreated();
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === "LOOP_ALREADY_EXISTS"
      ) {
        const duplicateLoopId =
          typeof err.details?.loopId === "string" ? err.details.loopId : undefined;
        toast.info("Loop already exists. Opening existing loop.");
        setOpen(false);
        if (duplicateLoopId && onOpenExistingLoop) {
          onOpenExistingLoop(duplicateLoopId);
          return;
        }
        onCreated();
        return;
      }
      toast.error(parseApiError(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        Create Loop
      </Button>

      <SidePanel
        open={open}
        onClose={() => setOpen(false)}
        title="Create Kanban Loop"
        subtitle="Define the pull loop parameters and starting cards"
        width="default"
      >
        <form onSubmit={handleSubmit} noValidate className="space-y-4 p-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-partId">
              Item <span className="text-destructive">*</span>
            </label>
            <select
              id="create-partId"
              value={partId}
              onChange={(e) => setPartId(e.target.value)}
              required
              className={SELECT_CLASS_NAME}
              disabled={isOptionsLoading}
            >
              <option value="">
                {isOptionsLoading ? "Loading items..." : "Select an item"}
              </option>
              {!isOptionsLoading && parts.length === 0 ? (
                <option value="" disabled>
                  No items available
                </option>
              ) : null}
              {parts.map((part) => (
                <option key={part.id} value={part.id}>
                  {getPartLabel(part)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-facility">
              Facility <span className="text-destructive">*</span>
            </label>
            <select
              id="create-facility"
              value={facilityId}
              onChange={(e) => setFacilityId(e.target.value)}
              required
              className={SELECT_CLASS_NAME}
              disabled={isOptionsLoading}
            >
              <option value="">
                {isOptionsLoading ? "Loading facilities..." : "Select a facility"}
              </option>
              {!isOptionsLoading && facilities.length === 0 ? (
                <option value="" disabled>
                  No facilities available
                </option>
              ) : null}
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {getFacilityLabel(facility)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Loop Type
            </label>
            <div className="mt-1 flex gap-2">
              {LOOP_ORDER.map((lt) => {
                const meta = LOOP_META[lt];
                const Icon = meta.icon;
                const isActive = loopType === lt;
                return (
                  <button
                    key={lt}
                    type="button"
                    onClick={() => setLoopType(lt)}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? "border-[hsl(var(--link))] bg-[hsl(var(--link)/0.08)] text-[hsl(var(--link))]"
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          {loopType === "procurement" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-supplierId">
                Supplier <span className="text-destructive">*</span>
              </label>
              <select
                id="create-supplierId"
                value={primarySupplierId}
                onChange={(e) => setPrimarySupplierId(e.target.value)}
                required
                className={SELECT_CLASS_NAME}
                disabled={isOptionsLoading}
              >
                <option value="">
                  {isOptionsLoading ? "Loading suppliers..." : "Select a supplier"}
                </option>
                {!isOptionsLoading && suppliers.length === 0 ? (
                  <option value="" disabled>
                    No suppliers available
                  </option>
                ) : null}
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {getSupplierLabel(supplier)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {loopType === "transfer" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-sourceFacility">
                Source Facility <span className="text-destructive">*</span>
              </label>
              <select
                id="create-sourceFacility"
                value={sourceFacilityId}
                onChange={(e) => setSourceFacilityId(e.target.value)}
                required
                className={SELECT_CLASS_NAME}
                disabled={isOptionsLoading}
              >
                <option value="">
                  {isOptionsLoading ? "Loading facilities..." : "Select a source facility"}
                </option>
                {!isOptionsLoading && transferSourceFacilities.length === 0 ? (
                  <option value="" disabled>
                    No alternate facilities available
                  </option>
                ) : null}
                {transferSourceFacilities.map((facility) => (
                  <option key={facility.id} value={facility.id}>
                    {getFacilityLabel(facility)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Card Mode
            </label>
            <div className="mt-1 flex gap-2">
              {CARD_MODE_OPTIONS.map((opt) => {
                const isActive = cardMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setCardMode(opt.value)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? "border-[hsl(var(--link))] bg-[hsl(var(--link)/0.08)] text-[hsl(var(--link))]"
                        : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-cards">
                Number of Cards
              </label>
              <Input
                id="create-cards"
                type="number"
                min={1}
                value={numberOfCards}
                onChange={(e) => setNumberOfCards(e.target.value)}
                disabled={cardMode === "single"}
                className="mt-1 h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-minQty">
                Min Quantity <span className="text-destructive">*</span>
              </label>
              <Input
                id="create-minQty"
                type="number"
                min={1}
                value={minQuantity}
                onChange={(e) => setMinQuantity(e.target.value)}
                placeholder="1"
                required
                className="mt-1 h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-orderQty">
                Order Quantity <span className="text-destructive">*</span>
              </label>
              <Input
                id="create-orderQty"
                type="number"
                min={1}
                value={orderQuantity}
                onChange={(e) => setOrderQuantity(e.target.value)}
                placeholder="1"
                required
                className="mt-1 h-9 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="create-lead">
                Lead Time (days)
              </label>
              <Input
                id="create-lead"
                type="number"
                min={1}
                value={statedLeadTimeDays}
                onChange={(e) => setStatedLeadTimeDays(e.target.value)}
                placeholder="--"
                className="mt-1 h-9 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-storageLocation">
              Storage Location
            </label>
            <select
              id="create-storageLocation"
              value={storageLocationId}
              onChange={(e) => setStorageLocationId(e.target.value)}
              className={SELECT_CLASS_NAME}
              disabled={!facilityId || isStorageLocationsLoading}
            >
              <option value="">
                {!facilityId
                  ? "Select a facility first"
                  : isStorageLocationsLoading
                    ? "Loading storage locations..."
                    : "Select a storage location (optional)"}
              </option>
              {facilityId && !isStorageLocationsLoading && storageLocations.length === 0 ? (
                <option value="" disabled>
                  No storage locations available
                </option>
              ) : null}
              {storageLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {getStorageLocationLabel(location)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-safetyStock">
              Safety Stock Days
            </label>
            <Input
              id="create-safetyStock"
              value={safetyStockDays}
              onChange={(e) => setSafetyStockDays(e.target.value)}
              placeholder="e.g. 3"
              className="mt-1 h-9 text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="create-notes">
              Notes
            </label>
            <textarea
              id="create-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
              className="mt-1 flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSaving || isOptionsLoading}>
              {(isSaving || isOptionsLoading) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Create Loop
            </Button>
          </div>
        </form>
      </SidePanel>
    </>
  );
}
