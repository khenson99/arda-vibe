// New architecture — FAB + Dialog + Overlay
export { ImportContextProvider } from "./import-context";
export { AddItemsFab } from "./add-items-fab";
export { ModuleDialog } from "./module-dialog";
export { OnboardingOverlay } from "./onboarding-overlay";

// Types
export type {
  ImportModuleId,
  OnboardingStep,
  EmailProvider,
  EmailConnection,
  VendorOption,
  DetectedOrder,
  DetectedOrderItem,
  EnrichedProduct,
  UpcScanItem,
  ImageIdentification,
  AiPrediction,
  LinkImportItem,
  CsvImportResult,
  ReconciliationItem,
  ReconciliationConflict,
  ProductSource,
} from "./types";
