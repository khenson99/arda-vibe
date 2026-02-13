import { createHash } from 'node:crypto';
import { eq, sql, desc, and } from 'drizzle-orm';
import { auditLog } from './schema/audit.js';
import type { DbOrTransaction } from './client.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface AuditEntryInput {
  tenantId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  previousState?: unknown;
  newState?: unknown;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  timestamp?: Date;
}

export interface AuditEntryResult {
  id: string;
  hashChain: string;
  sequenceNumber: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const GENESIS_SENTINEL = 'GENESIS';

/**
 * Deterministic advisory lock key pair derived from tenant UUID.
 * Uses pg_advisory_xact_lock(int, int) (two 32-bit integers) to avoid
 * bigint overflow — some UUID prefixes exceed signed int8 max.
 */
function tenantLockKeys(tenantId: string): [number, number] {
  const hex = tenantId.replace(/-/g, '');
  // Split first 16 hex chars into two 8-char groups → two signed 32-bit ints
  const hi = parseInt(hex.slice(0, 8), 16) | 0; // signed 32-bit via | 0
  const lo = parseInt(hex.slice(8, 16), 16) | 0;
  return [hi, lo];
}

/**
 * Canonical timestamp serialization used in hash computation.
 * Both the JS runtime writer and the SQL backfill migration (0008) MUST
 * use this same format: ISO 8601 with milliseconds and Z suffix.
 * Example: "2026-01-15T10:00:00.000Z"
 */
function canonicalTimestamp(ts: Date): string {
  return ts.toISOString();
}

/**
 * Compute the SHA-256 hash for an audit entry.
 *
 * Format matches the backfill migration (0008_audit_hash_chain.sql):
 *   tenant_id|sequence_number|action|entity_type|entity_id|timestamp|previous_hash
 *
 * - First entry per tenant uses 'GENESIS' as previous_hash input
 * - NULL entity_id is represented as empty string
 * - Timestamp uses canonicalTimestamp() (ISO 8601)
 */
function computeHash(input: {
  tenantId: string;
  sequenceNumber: number;
  action: string;
  entityType: string;
  entityId: string | null | undefined;
  timestamp: Date;
  previousHash: string | null;
}): string {
  const prevHash = input.previousHash ?? GENESIS_SENTINEL;
  const entityId = input.entityId ?? '';
  const payload = [
    input.tenantId,
    input.sequenceNumber.toString(),
    input.action,
    input.entityType,
    entityId,
    canonicalTimestamp(input.timestamp),
    prevHash,
  ].join('|');

  return createHash('sha256').update(payload).digest('hex');
}

// ─── Internal: lock + chain + insert (runs inside a transaction) ────

async function writeEntryInTx(
  tx: DbOrTransaction,
  entry: AuditEntryInput,
  ts: Date,
): Promise<AuditEntryResult> {
  const [hi, lo] = tenantLockKeys(entry.tenantId);
  await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${hi}, ${lo})`));

  const [latest] = await tx
    .select({
      hashChain: auditLog.hashChain,
      sequenceNumber: auditLog.sequenceNumber,
    })
    .from(auditLog)
    .where(and(
      eq(auditLog.tenantId, entry.tenantId),
      sql`${auditLog.hashChain} != 'PENDING'`,
    ))
    .orderBy(desc(auditLog.sequenceNumber))
    .limit(1);

  const previousHash = latest?.hashChain ?? null;
  const nextSequence = latest ? latest.sequenceNumber + 1 : 1;

  const hashChain = computeHash({
    tenantId: entry.tenantId,
    sequenceNumber: nextSequence,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    timestamp: ts,
    previousHash,
  });

  const [inserted] = await tx
    .insert(auditLog)
    .values({
      tenantId: entry.tenantId,
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      previousState: entry.previousState ?? null,
      newState: entry.newState ?? null,
      metadata: entry.metadata ?? {},
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      timestamp: ts,
      hashChain,
      previousHash,
      sequenceNumber: nextSequence,
    })
    .returning({
      id: auditLog.id,
      hashChain: auditLog.hashChain,
      sequenceNumber: auditLog.sequenceNumber,
    });

  return inserted;
}

// ─── Core Writer ────────────────────────────────────────────────────

/**
 * Write an immutable, hash-chained audit log entry.
 *
 * This function is self-transactional: it always wraps its internal
 * logic in a transaction. If called with a bare `db`, it creates a new
 * transaction. If called with an existing `tx`, Drizzle creates a
 * savepoint (nested transaction), so the advisory lock and
 * read-compute-insert sequence are always serialized.
 *
 * @param dbOrTx - Drizzle database or transaction instance
 * @param entry - The audit entry fields
 * @returns The inserted row's id, hashChain, and sequenceNumber
 */
export async function writeAuditEntry(
  dbOrTx: DbOrTransaction,
  entry: AuditEntryInput,
): Promise<AuditEntryResult> {
  const ts = entry.timestamp ?? new Date();
  return dbOrTx.transaction(async (tx) => writeEntryInTx(tx, entry, ts));
}

/**
 * Write multiple audit entries for the same tenant in a single call.
 * Each entry is chained sequentially (entry N's hash depends on entry N-1).
 *
 * Self-transactional: wraps lock + reads + inserts in a single transaction
 * (or savepoint if already inside a tx).
 *
 * @param dbOrTx - Drizzle database or transaction instance
 * @param tenantId - The tenant all entries belong to
 * @param entries - Array of audit entry inputs (tenantId in each is ignored; uses the tenantId param)
 * @returns Array of inserted results in the same order as input
 */
export async function writeAuditEntries(
  dbOrTx: DbOrTransaction,
  tenantId: string,
  entries: Omit<AuditEntryInput, 'tenantId'>[],
): Promise<AuditEntryResult[]> {
  if (entries.length === 0) return [];

  return dbOrTx.transaction(async (tx) => {
    const [hi, lo] = tenantLockKeys(tenantId);
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${hi}, ${lo})`));

    const [latest] = await tx
      .select({
        hashChain: auditLog.hashChain,
        sequenceNumber: auditLog.sequenceNumber,
      })
      .from(auditLog)
      .where(and(
        eq(auditLog.tenantId, tenantId),
        sql`${auditLog.hashChain} != 'PENDING'`,
      ))
      .orderBy(desc(auditLog.sequenceNumber))
      .limit(1);

    let previousHash = latest?.hashChain ?? null;
    let nextSequence = latest ? latest.sequenceNumber + 1 : 1;

    const results: AuditEntryResult[] = [];

    for (const entry of entries) {
      const ts = entry.timestamp ?? new Date();

      const hashChain = computeHash({
        tenantId,
        sequenceNumber: nextSequence,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        timestamp: ts,
        previousHash,
      });

      const [inserted] = await tx
        .insert(auditLog)
        .values({
          tenantId,
          userId: entry.userId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          previousState: entry.previousState ?? null,
          newState: entry.newState ?? null,
          metadata: entry.metadata ?? {},
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
          timestamp: ts,
          hashChain,
          previousHash,
          sequenceNumber: nextSequence,
        })
        .returning({
          id: auditLog.id,
          hashChain: auditLog.hashChain,
          sequenceNumber: auditLog.sequenceNumber,
        });

      results.push(inserted);
      previousHash = hashChain;
      nextSequence++;
    }

    return results;
  });
}

// Re-export for testing / verification use cases
export { computeHash as _computeHash, canonicalTimestamp as _canonicalTimestamp, tenantLockKeys as _tenantLockKeys };
