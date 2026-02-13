import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  bigint,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const auditSchema = pgSchema('audit');

// ─── Immutable Audit Log ─────────────────────────────────────────────
// Every significant action in the system gets a row here.
// This table is append-only. No updates, no deletes.
export const auditLog = auditSchema.table(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id'),                  // null for system actions
    action: varchar('action', { length: 100 }).notNull(), // e.g., 'card.triggered', 'po.created', 'user.login'
    entityType: varchar('entity_type', { length: 100 }).notNull(), // e.g., 'kanban_card', 'purchase_order'
    entityId: uuid('entity_id'),              // the ID of the affected entity
    previousState: jsonb('previous_state'),   // snapshot before change
    newState: jsonb('new_state'),             // snapshot after change
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),

    // ── Hash-chain audit integrity ───────────────────────────────────
    // Each row is linked to the previous via SHA-256 hash, forming an
    // append-only tamper-evident chain per tenant.
    hashChain: varchar('hash_chain', { length: 64 }).notNull().default('PENDING'),
    previousHash: varchar('previous_hash', { length: 64 }),
    sequenceNumber: bigint('sequence_number', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('audit_tenant_idx').on(table.tenantId),
    index('audit_user_idx').on(table.userId),
    index('audit_entity_idx').on(table.entityType, table.entityId),
    index('audit_action_idx').on(table.action),
    index('audit_time_idx').on(table.timestamp),
    index('audit_tenant_time_idx').on(table.tenantId, table.timestamp),
    index('audit_tenant_seq_idx').on(table.tenantId, table.sequenceNumber),
    uniqueIndex('audit_hash_idx').on(table.hashChain),
  ]
);

// ─── Archive Table ──────────────────────────────────────────────────
// Holds audit rows moved from audit_log after the tenant's retention
// window expires.  Schema parity with audit_log so archived rows can
// be queried with the same column references.
//
// The underlying Postgres table is range-partitioned on "timestamp"
// (monthly). Drizzle doesn't model partitioning natively, so the
// partitioning DDL lives in the migration SQL (0009_audit_log_archive).
export const auditLogArchive = auditSchema.table(
  'audit_log_archive',
  {
    id: uuid('id').notNull(),              // preserved from audit_log (no defaultRandom — already assigned)
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id'),
    action: varchar('action', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 100 }).notNull(),
    entityId: uuid('entity_id'),
    previousState: jsonb('previous_state'),
    newState: jsonb('new_state'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),

    // Hash-chain columns (preserved from audit_log)
    hashChain: varchar('hash_chain', { length: 64 }).notNull(),
    previousHash: varchar('previous_hash', { length: 64 }),
    sequenceNumber: bigint('sequence_number', { mode: 'number' }).notNull(),
  },
  (table) => [
    // Composite PK matches migration DDL: required for range partitioning on timestamp
    primaryKey({ columns: [table.id, table.timestamp] }),
    index('archive_tenant_time_idx').on(table.tenantId, table.timestamp),
    index('archive_tenant_seq_idx').on(table.tenantId, table.sequenceNumber),
  ]
);
