// ─── Print Test Fixtures ──────────────────────────────────────────────
// Canonical test data for each supported print format.
// Used by snapshot tests and visual regression checks.

import type { KanbanPrintData } from '../types';

const BASE_QR_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A fully-populated procurement card for testing all fields. */
export const PROCUREMENT_CARD_FIXTURE: KanbanPrintData = {
  cardId: '550e8400-e29b-41d4-a716-446655440000',
  cardNumber: 1,
  totalCards: 3,
  partNumber: 'PN-10042',
  partDescription: 'Stainless Steel Hex Bolt M8x40mm Grade A4-80',
  sku: 'PN-10042',
  loopType: 'procurement',
  currentStage: 'created',
  facilityName: 'Main Warehouse - Building A',
  storageLocation: 'Aisle 4, Rack B, Shelf 3',
  supplierName: 'Acme Fasteners Inc.',
  sourceFacilityName: undefined,
  orderQuantity: 500,
  minQuantity: 200,
  statedLeadTimeDays: 14,
  safetyStockDays: 3,
  qrCodeDataUrl: BASE_QR_DATA_URL,
  scanUrl: 'https://acme.arda.cards/scan/550e8400-e29b-41d4-a716-446655440000',
  tenantName: 'Acme Manufacturing Co.',
  tenantLogoUrl: undefined,
  notes: 'Reorder from primary supplier. Secondary: BoltWorld LLC.',
  notesText: 'Reorder from primary supplier. Secondary: BoltWorld LLC.',
  imageUrl: 'https://example.com/bolt.png',
  minimumText: '200 each',
  locationText: 'Aisle 4, Rack B, Shelf 3',
  orderText: '500 each',
  supplierText: 'Acme Fasteners Inc.',
  accentColor: '#2F6FCC',
  lastPrintedAt: '2025-03-15T10:30:00.000Z',
  showArdaWatermark: false,
};

/** A production card for testing production loop type. */
export const PRODUCTION_CARD_FIXTURE: KanbanPrintData = {
  cardId: '660e8400-e29b-41d4-a716-446655440001',
  cardNumber: 2,
  totalCards: 5,
  partNumber: 'ASM-2001',
  partDescription: 'Hydraulic Actuator Sub-Assembly Rev C',
  sku: 'ASM-2001',
  loopType: 'production',
  currentStage: 'triggered',
  facilityName: 'Production Floor - Cell 7',
  storageLocation: 'WIP Buffer Zone',
  supplierName: undefined,
  sourceFacilityName: undefined,
  orderQuantity: 50,
  minQuantity: 20,
  statedLeadTimeDays: 5,
  safetyStockDays: 1,
  qrCodeDataUrl: BASE_QR_DATA_URL,
  scanUrl: 'https://acme.arda.cards/scan/660e8400-e29b-41d4-a716-446655440001',
  tenantName: 'Acme Manufacturing Co.',
  tenantLogoUrl: 'https://example.com/acme-logo.png',
  notes: undefined,
  notesText: undefined,
  imageUrl: 'https://example.com/actuator.png',
  minimumText: '20 each',
  locationText: 'WIP Buffer Zone',
  orderText: '50 each',
  supplierText: 'Internal Production',
  accentColor: '#2F6FCC',
  lastPrintedAt: undefined,
  showArdaWatermark: false,
};

/** A transfer card for testing transfer loop type. */
export const TRANSFER_CARD_FIXTURE: KanbanPrintData = {
  cardId: '770e8400-e29b-41d4-a716-446655440002',
  cardNumber: 1,
  totalCards: 1,
  partNumber: 'RAW-5503',
  partDescription: 'Aluminum Sheet 6061-T6 4ft x 8ft x 0.063in',
  sku: 'RAW-5503',
  loopType: 'transfer',
  currentStage: 'in_transit',
  facilityName: 'Satellite Warehouse B',
  storageLocation: undefined,
  supplierName: undefined,
  sourceFacilityName: 'Main Warehouse - Building A',
  orderQuantity: 25,
  minQuantity: 10,
  statedLeadTimeDays: 2,
  safetyStockDays: 0,
  qrCodeDataUrl: BASE_QR_DATA_URL,
  scanUrl: 'https://acme.arda.cards/scan/770e8400-e29b-41d4-a716-446655440002',
  tenantName: 'Acme Manufacturing Co.',
  tenantLogoUrl: undefined,
  notes: undefined,
  notesText: undefined,
  imageUrl: 'https://example.com/sheet.png',
  minimumText: '10 each',
  locationText: 'Satellite Warehouse B',
  orderText: '25 each',
  supplierText: 'Main Warehouse - Building A',
  accentColor: '#2F6FCC',
  lastPrintedAt: '2025-04-01T08:00:00.000Z',
  showArdaWatermark: true,
};

/** A card with minimal data (only required fields). */
export const MINIMAL_CARD_FIXTURE: KanbanPrintData = {
  cardId: '880e8400-e29b-41d4-a716-446655440003',
  cardNumber: 1,
  totalCards: 1,
  partNumber: 'MISC-001',
  partDescription: 'Generic Component',
  sku: 'MISC-001',
  loopType: 'procurement',
  currentStage: 'created',
  facilityName: 'Warehouse',
  storageLocation: undefined,
  supplierName: undefined,
  sourceFacilityName: undefined,
  orderQuantity: 100,
  minQuantity: 50,
  statedLeadTimeDays: undefined,
  safetyStockDays: undefined,
  qrCodeDataUrl: BASE_QR_DATA_URL,
  scanUrl: 'http://localhost:5173/scan/880e8400-e29b-41d4-a716-446655440003',
  tenantName: 'Test Tenant',
  tenantLogoUrl: undefined,
  notes: undefined,
  notesText: undefined,
  imageUrl: undefined,
  minimumText: '50 each',
  locationText: 'Warehouse',
  orderText: '100 each',
  supplierText: 'Unknown supplier',
  accentColor: '#2F6FCC',
  lastPrintedAt: undefined,
  showArdaWatermark: false,
};

/** A card with every stage to test badge rendering. */
export function createFixtureForStage(
  stage: KanbanPrintData['currentStage'],
): KanbanPrintData {
  return {
    ...PROCUREMENT_CARD_FIXTURE,
    cardId: `99${stage.padEnd(6, '0')}-e29b-41d4-a716-446655440000`,
    currentStage: stage,
  };
}

/** All loop type fixtures. */
export const ALL_LOOP_TYPE_FIXTURES: KanbanPrintData[] = [
  PROCUREMENT_CARD_FIXTURE,
  PRODUCTION_CARD_FIXTURE,
  TRANSFER_CARD_FIXTURE,
];

/** Fixture batch for batch-print testing. */
export const BATCH_PRINT_FIXTURES: KanbanPrintData[] = [
  PROCUREMENT_CARD_FIXTURE,
  PRODUCTION_CARD_FIXTURE,
  TRANSFER_CARD_FIXTURE,
  MINIMAL_CARD_FIXTURE,
];
