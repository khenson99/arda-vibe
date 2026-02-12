import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Button,
  Input,
} from "@/components/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PROCUREMENT_ORDER_METHODS,
  normalizeProcurementOrderMethod,
  procurementOrderMethodLabel,
} from "@/components/procurement/order-method";
import {
  updateItemRecord,
  isUnauthorized,
  parseApiError,
  normalizeOptionalString,
} from "@/lib/api-client";
import type { AuthSession, PartRecord } from "@/types";

interface ItemEditFormProps {
  mode: "create" | "edit";
  part: PartRecord | null;
  session: AuthSession;
  onUnauthorized: () => void;
  onSaved: () => Promise<void>;
  onClose: () => void;
}

export function ItemEditForm({
  mode,
  part,
  session,
  onUnauthorized,
  onSaved,
  onClose,
}: ItemEditFormProps) {
  const [itemCode, setItemCode] = React.useState("");
  const [itemName, setItemName] = React.useState("");
  const [supplier, setSupplier] = React.useState("");
  const [location, setLocation] = React.useState("");
  const [imageUrl, setImageUrl] = React.useState("");
  const [orderMethod, setOrderMethod] = React.useState("purchase_order");
  const [minQty, setMinQty] = React.useState("0");
  const [minQtyUnit, setMinQtyUnit] = React.useState("each");
  const [orderQty, setOrderQty] = React.useState("");
  const [orderQtyUnit, setOrderQtyUnit] = React.useState("each");
  const [isSavingItem, setIsSavingItem] = React.useState(false);

  const isCreateMode = mode === "create";

  const seedFromPart = React.useCallback((nextPart: PartRecord | null) => {
    const fallbackCode = nextPart?.externalGuid?.trim() || nextPart?.partNumber || "";
    setItemCode(fallbackCode);
    setItemName(nextPart?.name?.trim() || "");
    setSupplier(nextPart?.primarySupplier?.trim() || "");
    setLocation(nextPart?.location?.trim() || "");
    setImageUrl(nextPart?.imageUrl?.trim() || "");
    const existingOrderMethod = nextPart?.orderMechanism?.trim() || nextPart?.type?.trim() || "";
    try {
      setOrderMethod(normalizeProcurementOrderMethod(existingOrderMethod));
    } catch {
      setOrderMethod("purchase_order");
    }
    setMinQty(String(nextPart?.minQty ?? 0));
    setMinQtyUnit(nextPart?.minQtyUnit?.trim() || nextPart?.uom?.trim() || "each");
    setOrderQty(
      typeof nextPart?.orderQty === "number" && Number.isFinite(nextPart.orderQty)
        ? String(nextPart.orderQty)
        : "",
    );
    setOrderQtyUnit(nextPart?.orderQtyUnit?.trim() || nextPart?.uom?.trim() || "each");
  }, []);

  React.useEffect(() => {
    seedFromPart(part);
  }, [part, seedFromPart]);

  const handleSaveItem = React.useCallback(async () => {
    const normalizedCode = itemCode.trim();
    if (!normalizedCode) {
      toast.error("Item code is required.");
      return;
    }
    if (!itemName.trim()) {
      toast.error("Item name is required.");
      return;
    }

    const parsedMinQty = Number.parseInt(minQty.trim() || "0", 10);
    if (!Number.isFinite(parsedMinQty) || parsedMinQty < 0) {
      toast.error("Min quantity must be a whole number >= 0.");
      return;
    }

    const normalizedOrderQty = orderQty.trim();
    const parsedOrderQty =
      normalizedOrderQty === "" ? null : Number.parseInt(normalizedOrderQty, 10);
    if (parsedOrderQty !== null && (!Number.isFinite(parsedOrderQty) || parsedOrderQty < 0)) {
      toast.error("Order quantity must be a whole number >= 0.");
      return;
    }

    const entityId = part?.eId || normalizedCode;
    const author = normalizeOptionalString(session.user.email) || session.user.id;

    setIsSavingItem(true);
    try {
      await updateItemRecord(session.tokens.accessToken, {
        entityId,
        tenantId: session.user.tenantId,
        author,
        payload: {
          externalGuid: normalizedCode,
          name: itemName.trim(),
          orderMechanism: orderMethod.trim() || "purchase_order",
          location: normalizeOptionalString(location),
          minQty: parsedMinQty,
          minQtyUnit: minQtyUnit.trim() || "each",
          orderQty: parsedOrderQty,
          orderQtyUnit: normalizeOptionalString(orderQtyUnit),
          primarySupplier: supplier.trim() || "Unknown supplier",
          primarySupplierLink: null,
          imageUrl: normalizeOptionalString(imageUrl),
          notes: part?.notes ?? null,
        },
      });
      toast.success(isCreateMode ? "Item created with an initial card." : "Item updated.");
      await onSaved();
      onClose();
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setIsSavingItem(false);
    }
  }, [
    isCreateMode,
    itemCode,
    itemName,
    imageUrl,
    location,
    minQty,
    minQtyUnit,
    onClose,
    onSaved,
    onUnauthorized,
    orderMethod,
    orderQty,
    orderQtyUnit,
    part?.eId,
    session.tokens.accessToken,
    session.user.email,
    session.user.id,
    session.user.tenantId,
    supplier,
  ]);

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Item code</label>
          <Input value={itemCode} onChange={(event) => setItemCode(event.target.value)} className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Item name</label>
          <Input value={itemName} onChange={(event) => setItemName(event.target.value)} className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Supplier</label>
          <Input value={supplier} onChange={(event) => setSupplier(event.target.value)} className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Location</label>
          <Input value={location} onChange={(event) => setLocation(event.target.value)} className="mt-1" />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Image URL</label>
          <Input
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
            className="mt-1"
            placeholder="https://..."
          />
          {imageUrl.trim() ? (
            <div className="mt-2 flex h-24 w-24 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/20">
              <img
                src={imageUrl}
                alt="Item preview"
                className="h-full w-full object-contain"
                loading="lazy"
              />
            </div>
          ) : null}
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Order method</label>
          <Select value={orderMethod} onValueChange={setOrderMethod}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select order method" />
            </SelectTrigger>
            <SelectContent>
              {PROCUREMENT_ORDER_METHODS.map((method) => (
                <SelectItem key={method} value={method}>
                  {procurementOrderMethodLabel(method)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Min quantity</label>
          <Input
            type="number"
            min={0}
            value={minQty}
            onChange={(event) => setMinQty(event.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Min unit</label>
          <Input value={minQtyUnit} onChange={(event) => setMinQtyUnit(event.target.value)} className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Order quantity</label>
          <Input
            type="number"
            min={0}
            value={orderQty}
            onChange={(event) => setOrderQty(event.target.value)}
            className="mt-1"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Order unit</label>
          <Input value={orderQtyUnit} onChange={(event) => setOrderQtyUnit(event.target.value)} className="mt-1" />
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => void handleSaveItem()} disabled={isSavingItem}>
          {isSavingItem && <Loader2 className="h-4 w-4 animate-spin" />}
          {isCreateMode ? "Create item" : "Save item"}
        </Button>
      </div>
    </div>
  );
}
