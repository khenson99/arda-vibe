/**
 * Source Recommendation Service
 *
 * Ranks facilities that can fulfil a transfer-order request for a given part,
 * scored by three factors:
 *   1. Available stock  (qtyOnHand − qtyReserved)
 *   2. Average historical lead time (from leadTimeHistory)
 *   3. Haversine distance between source and destination facilities
 *
 * Facilities with zero available stock are excluded.
 * The composite score is a weighted sum — higher is better.
 */

import { db, schema } from '@arda/db';
import { eq, and, ne, gt, sql } from 'drizzle-orm';
import * as configModule from '@arda/config';
import type { SourceRecommendation } from '@arda/shared-types';

type LoggerLike = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const fallbackLogger: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const createLogger =
  typeof configModule.createLogger === 'function'
    ? configModule.createLogger
    : () => fallbackLogger;

const log = createLogger('source-recommendation') as LoggerLike;

const { inventoryLedger, facilities, leadTimeHistory } = schema;

// ─── Types ────────────────────────────────────────────────────────────

export interface RecommendSourcesInput {
  tenantId: string;
  /** The facility requesting the stock. */
  destinationFacilityId: string;
  partId: string;
  /** Minimum available quantity required (default 1). */
  minQty?: number;
  /** Maximum results to return (default 10). */
  limit?: number;
}

// ─── Scoring Weights ──────────────────────────────────────────────────

const WEIGHT_STOCK = 0.5;
const WEIGHT_LEAD_TIME = 0.3;
const WEIGHT_DISTANCE = 0.2;

// ─── Haversine Distance ───────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

/**
 * Calculate the great-circle distance between two points in kilometres.
 * Returns null if either coordinate pair is missing.
 */
function haversineKm(
  lat1: number | null,
  lon1: number | null,
  lat2: number | null,
  lon2: number | null
): number | null {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

// ─── Main Function ────────────────────────────────────────────────────

/**
 * Return a scored list of source facilities for a given part, ordered
 * best → worst.
 */
export async function recommendSources(
  input: RecommendSourcesInput
): Promise<SourceRecommendation[]> {
  const { tenantId, destinationFacilityId, partId, minQty = 1, limit = 10 } = input;

  // 1. Fetch destination facility coordinates for distance calc
  const destRows = await db
    .select({
      latitude: facilities.latitude,
      longitude: facilities.longitude,
    })
    .from(facilities)
    .where(eq(facilities.id, destinationFacilityId))
    .limit(1);

  const dest = destRows[0];
  if (!dest) {
    log.warn({ destinationFacilityId }, 'Destination facility not found');
    return [];
  }

  const destLat = dest.latitude ? Number(dest.latitude) : null;
  const destLon = dest.longitude ? Number(dest.longitude) : null;

  // 2. Get candidate facilities with available stock
  //    available = qtyOnHand - qtyReserved
  const candidates = await db
    .select({
      facilityId: facilities.id,
      facilityName: facilities.name,
      facilityCode: facilities.code,
      latitude: facilities.latitude,
      longitude: facilities.longitude,
      qtyOnHand: inventoryLedger.qtyOnHand,
      qtyReserved: inventoryLedger.qtyReserved,
    })
    .from(inventoryLedger)
    .innerJoin(facilities, eq(inventoryLedger.facilityId, facilities.id))
    .where(
      and(
        eq(inventoryLedger.tenantId, tenantId),
        eq(inventoryLedger.partId, partId),
        // Exclude the destination facility itself
        ne(inventoryLedger.facilityId, destinationFacilityId),
        // Only facilities with enough available stock
        gt(
          sql`${inventoryLedger.qtyOnHand} - ${inventoryLedger.qtyReserved}`,
          minQty - 1
        )
      )
    );

  if (candidates.length === 0) return [];

  // 3. Fetch average lead times for each candidate -> destination route
  const candidateFacilityIds = candidates.map((c) => c.facilityId);

  const leadTimeRows = await db
    .select({
      sourceFacilityId: leadTimeHistory.sourceFacilityId,
      avgLeadTimeDays: sql<number>`avg(${leadTimeHistory.leadTimeDays})::float`,
    })
    .from(leadTimeHistory)
    .where(
      and(
        eq(leadTimeHistory.tenantId, tenantId),
        eq(leadTimeHistory.destinationFacilityId, destinationFacilityId),
        sql`${leadTimeHistory.sourceFacilityId} = ANY(${candidateFacilityIds})`
      )
    )
    .groupBy(leadTimeHistory.sourceFacilityId);

  const leadTimeMap = new Map<string, number>();
  for (const row of leadTimeRows) {
    leadTimeMap.set(row.sourceFacilityId, row.avgLeadTimeDays);
  }

  // 4. Build scored recommendations
  const raw: Array<SourceRecommendation & { _rawStock: number; _rawLead: number | null; _rawDist: number | null }> =
    candidates.map((c) => {
      const availableQty = c.qtyOnHand - c.qtyReserved;
      const avgLeadTimeDays = leadTimeMap.get(c.facilityId) ?? null;
      const distanceKm = haversineKm(
        c.latitude ? Number(c.latitude) : null,
        c.longitude ? Number(c.longitude) : null,
        destLat,
        destLon
      );

      return {
        facilityId: c.facilityId,
        facilityName: c.facilityName,
        facilityCode: c.facilityCode,
        availableQty,
        avgLeadTimeDays,
        distanceKm: distanceKm !== null ? Math.round(distanceKm * 10) / 10 : null,
        score: 0, // computed below
        _rawStock: availableQty,
        _rawLead: avgLeadTimeDays,
        _rawDist: distanceKm,
      };
    });

  // 5. Normalise each factor to [0, 1] and compute composite score
  const maxStock = Math.max(...raw.map((r) => r._rawStock), 1);
  const leadTimes = raw.map((r) => r._rawLead).filter((v): v is number => v !== null);
  const maxLead = leadTimes.length > 0 ? Math.max(...leadTimes, 1) : 1;
  const distances = raw.map((r) => r._rawDist).filter((v): v is number => v !== null);
  const maxDist = distances.length > 0 ? Math.max(...distances, 1) : 1;

  for (const r of raw) {
    // Stock score: higher stock = higher score
    const stockScore = r._rawStock / maxStock;

    // Lead time score: lower lead time = higher score (invert)
    // Missing lead time gets a neutral 0.5
    const leadScore = r._rawLead !== null ? 1 - r._rawLead / maxLead : 0.5;

    // Distance score: closer = higher score (invert)
    // Missing distance gets a neutral 0.5
    const distScore = r._rawDist !== null ? 1 - r._rawDist / maxDist : 0.5;

    r.score = Math.round(
      (WEIGHT_STOCK * stockScore + WEIGHT_LEAD_TIME * leadScore + WEIGHT_DISTANCE * distScore) * 100
    ) / 100;
  }

  // 6. Sort by score descending and trim to limit
  raw.sort((a, b) => b.score - a.score);

  return raw.slice(0, limit).map(({ _rawStock, _rawLead, _rawDist, ...rec }) => rec);
}
