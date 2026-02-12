declare module "@arda/shared-types" {
  export type CardFormat =
    | "order_card_3x5_portrait"
    | "3x5_card"
    | "4x6_card"
    | "business_card"
    | "business_label"
    | "1x3_label"
    | "bin_label"
    | "1x1_label";

  export const CARD_TEMPLATE_SCHEMA_VERSION: 1;
  export type CardTemplateSchemaVersion = typeof CARD_TEMPLATE_SCHEMA_VERSION;
  export type CardTemplateStatus = "active" | "archived";
  export type CardTemplateBindingToken =
    | "title"
    | "itemName"
    | "sku"
    | "partNumberText"
    | "minimumText"
    | "locationText"
    | "orderText"
    | "supplierText"
    | "supplierNameText"
    | "unitPriceText"
    | "orderQuantityValue"
    | "orderUnitsText"
    | "minQuantityValue"
    | "minUnitsText"
    | "cardsCountText"
    | "orderMethodText"
    | "itemLocationText"
    | "statusText"
    | "updatedAtText"
    | "glCodeText"
    | "itemTypeText"
    | "itemSubtypeText"
    | "uomText"
    | "facilityNameText"
    | "sourceFacilityNameText"
    | "storageLocationText"
    | "scanUrlText"
    | "notesText"
    | "imageUrl"
    | "qrCodeDataUrl";
  export type CardTemplateIconName = "minimum" | "location" | "order" | "supplier";

  export interface CardTemplateElementStyle {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    color?: string;
    textAlign?: "left" | "center" | "right";
    lineHeight?: number;
    backgroundColor?: string;
    borderColor?: string;
    borderWidth?: number;
    borderRadius?: number;
    padding?: number;
    opacity?: number;
    strokeColor?: string;
    strokeWidth?: number;
  }

  export interface CardTemplateBaseElement {
    id: string;
    key?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    rotation?: number;
    locked?: boolean;
    style?: CardTemplateElementStyle;
  }

  export interface CardTemplateBoundTextElement extends CardTemplateBaseElement {
    type: "bound_text";
    token: CardTemplateBindingToken;
    fallbackText?: string;
  }
  export interface CardTemplateTextElement extends CardTemplateBaseElement {
    type: "text";
    text: string;
  }
  export interface CardTemplateImageElement extends CardTemplateBaseElement {
    type: "image";
    token?: Extract<CardTemplateBindingToken, "imageUrl">;
    src?: string;
    fit?: "contain" | "cover";
  }
  export interface CardTemplateQrElement extends CardTemplateBaseElement {
    type: "qr";
  }
  export interface CardTemplateIconElement extends CardTemplateBaseElement {
    type: "icon";
    iconName: CardTemplateIconName;
    iconUrl?: string;
  }
  export interface CardTemplateLineElement extends CardTemplateBaseElement {
    type: "line";
    orientation: "horizontal" | "vertical";
  }
  export interface CardTemplateRectElement extends CardTemplateBaseElement {
    type: "rect";
  }
  export interface CardTemplateNotesBoxElement extends CardTemplateBaseElement {
    type: "notes_box";
    token?: Extract<CardTemplateBindingToken, "notesText">;
  }
  export interface CardTemplateFieldRowGroupElement extends CardTemplateBaseElement {
    type: "field_row_group";
    iconName: CardTemplateIconName;
    iconUrl?: string;
    label: string;
    token: CardTemplateBindingToken;
  }
  export type CardTemplateElement =
    | CardTemplateBoundTextElement
    | CardTemplateTextElement
    | CardTemplateImageElement
    | CardTemplateQrElement
    | CardTemplateIconElement
    | CardTemplateLineElement
    | CardTemplateRectElement
    | CardTemplateNotesBoxElement
    | CardTemplateFieldRowGroupElement;

  export interface CardTemplateDefinition {
    version: CardTemplateSchemaVersion;
    canvas: { width: number; height: number; background: string };
    grid: { enabled: boolean; size: number; snapThreshold: number };
    safeArea: { top: number; right: number; bottom: number; left: number };
    requiredElementKeys: string[];
    elements: CardTemplateElement[];
  }

  export interface CardTemplateRecord {
    id: string;
    tenantId: string;
    name: string;
    format: CardFormat;
    isDefault: boolean;
    status: CardTemplateStatus;
    definition: CardTemplateDefinition;
    createdByUserId?: string | null;
    updatedByUserId?: string | null;
    createdAt: string;
    updatedAt: string;
  }
}
