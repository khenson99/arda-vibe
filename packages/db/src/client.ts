import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

// ─── Connection Pool ──────────────────────────────────────────────────
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

// All custom schemas used by the application.
// Required because Drizzle's relational query API (db.query.*) does not
// schema-qualify table names even when tables are defined via pgSchema().
const SEARCH_PATH = 'auth,catalog,kanban,orders,locations,notifications,billing,audit,public';

// Query client (pooled connections for application use)
const queryClient = postgres(connectionString, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: { search_path: SEARCH_PATH },
});

// Drizzle instance with full schema for type-safe queries
export const db = drizzle(queryClient, { schema });

// ─── Tenant Context Helper ────────────────────────────────────────────
// Sets the RLS tenant context for the current transaction.
// Must be called at the start of every request within a transaction.
export async function withTenantContext<T>(
  tenantId: string,
  callback: (tx: typeof db) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    // Set tenant context through a parameterized call to avoid SQL injection.
    await tx.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);
    return callback(tx as unknown as typeof db);
  });
}

// ─── Migration Client ─────────────────────────────────────────────────
// Separate client for running migrations (not pooled, higher timeout)
export function createMigrationClient() {
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const migrationClient = postgres(connectionString, {
    max: 1,
    connect_timeout: 30,
    connection: { search_path: SEARCH_PATH },
  });
  return drizzle(migrationClient, { schema });
}

// ─── Pool Factory ────────────────────────────────────────────────────
// Creates a new Drizzle instance with a custom connection pool.
// Useful when a service needs a different pool size than the default (20).
export function createDbPool(options?: { max?: number; idleTimeout?: number }) {
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const poolClient = postgres(connectionString, {
    max: options?.max ?? 20,
    idle_timeout: options?.idleTimeout ?? 20,
    connect_timeout: 10,
    connection: { search_path: SEARCH_PATH },
  });
  return drizzle(poolClient, { schema });
}

export type Database = typeof db;
export { schema };
