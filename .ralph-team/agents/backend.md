# Agent — Accumulated Knowledge

This file is updated by the agent after each iteration.
Future iterations read this file to benefit from previously discovered
patterns, gotchas, and conventions.

## Discovered Patterns

### Service Architecture
- Auth service follows service + routes pattern: business logic in `services/*.service.ts`, HTTP layer in `routes/*.routes.ts`
- RBAC enforced via `requireRole()` middleware from `@arda/auth-utils`
- Tenant isolation: always filter by `req.user.tenantId` in queries

### API Gateway Routing
- Gateway proxies service endpoints via route configuration in `services/api-gateway/src/routes/proxy.ts`
- Each route needs explicit `RouteConfig` entry with prefix, target service URL, pathRewrite rules, and auth flag
- Express strips prefix from `req.url` when using `app.use(prefix, ...)`, so pathRewrite patterns match stripped URLs
- Auth service endpoints exposed through gateway at `/api/<resource>` prefix

### Testing
- Vitest with hoisted mocks pattern: use `vi.hoisted()` to declare mocks before `vi.mock()` references
- Mock reset strategy: add `beforeEach()` with `mockReset()` in nested describe blocks
- Test coverage: each service function gets dedicated tests, including happy path + error cases

### Database Schema
- Use pgSchema for multi-schema databases (auth, catalog, kanban, orders, etc.)
- Foreign key references use arrow functions: `.references(() => otherTable.id)`
- Handle circular dependencies by placing tables in appropriate schema files
- JSONB columns: use `.$type<YourType>()` for TypeScript type safety
- Export relations for Drizzle relational queries

## Gotchas

### TypeScript Types
- Express `req.params` fields have type `string | string[]`, not just `string`
- Handle with: `const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;`

### Database Schema
- User schema in `packages/db/src/schema/users.ts` defines 7 roles via `userRoleEnum`
- Tenant schema includes `seatLimit` and `settings` JSONB column
- API keys stored in auth schema, requires crypto for secure key generation

### Error Handling
- Throw `Error` with optional `.code` property for distinguishing error types (e.g., `SEAT_LIMIT_REACHED`)
- Use Zod for request validation, return 400 with structured `{ error, details }` format
- Security patterns: revoke refresh tokens on user deactivation, prevent last admin deactivation
- Never expose sensitive data like API key hashes or webhook secrets in responses

### Security
- API keys use SHA-256 hashing, store only hash not the key itself
- Return full API key ONLY on creation (one-time display)
- Webhook secrets stored in tenant settings but never returned in GET responses
- Use crypto.randomBytes for secure random generation

## Conventions

### File Naming
- Service files: `*.service.ts` (business logic)
- Route files: `*.routes.ts` (HTTP handlers)
- Test files: `*.test.ts` or `*.spec.ts`

### Validation
- Use Zod schemas for all request body validation
- Return 400 with `{ error: 'Validation error', details: zodError.errors }` format

### Logging
- Use structured logging via `createLogger('service:component')`
- Log key events: user invited, role updated, user deactivated, API key created/revoked

### API Key Format
- Format: `arda_<8-hex-prefix>_<64-hex-secret>`
- Store: keyHash (SHA-256), keyPrefix (for display), never store full key
- Display: Only show keyPrefix in lists, full key only on creation

## Stack-Specific Notes

### Migrations
- Hand-written SQL migrations in `packages/db/drizzle/`, numbered 0000+
- Journal at `packages/db/drizzle/meta/_journal.json` — must register each new migration
- 3-phase pattern for adding NOT NULL columns to existing tables: add nullable → backfill → enforce NOT NULL
- Use `IF NOT EXISTS` / `WHERE ... IS NULL` guards for idempotency
- Rollback notes in migration header comments
- Recursive CTE pattern for sequential backfills (hash chains) where each row depends on the previous
- PostgreSQL range partitioning: partition key must be in PK → use composite PK (id, timestamp)
- Drizzle doesn't model partitioning natively — all partition DDL goes in raw SQL migrations
- Idempotent partition creation: use `DO $$` blocks with `pg_catalog.pg_class` existence checks
- Partition naming: `<table>_YYYY_MM` for monthly range partitions
- PostgreSQL auto-propagates indexes from partitioned parent to child partitions
- Archive table id: use plain uuid (no defaultRandom) when IDs are preserved from source table

### Drizzle ORM
- Query API: `db.query.users.findFirst({ where: eq(...) })`
- Insert/Update: `.insert(...).values(...).returning()` / `.update(...).set(...).where(...).returning()`
- Never expose `passwordHash` in API responses (exclude in query or omit in response object)
- Use `.returning()` to get created/updated records in one query
- Adding NOT NULL columns to existing Drizzle tables: must add `.default()` to keep insert type optional
- SQL DEFAULT + Drizzle `.default()` must match — otherwise Drizzle type and DB constraint diverge
- `DbOrTransaction` type accepts both `db` and transaction `tx` — use for utility functions called inside transactions

### Audit System
- `writeAuditEntry(dbOrTx, entry)` — write a single hash-chained audit entry (in `@arda/db`)
- `writeAuditEntries(dbOrTx, tenantId, entries)` — batch write with sequential chaining
- Advisory lock: `pg_advisory_xact_lock(BigInt(tenantUUID.slice(0,16)))` — per-tenant, transaction-scoped
- Hash format: `tenant_id|seq|action|entity_type|entity_id|timestamp|previous_hash` (pipe-delimited SHA-256)
- First entry per tenant uses 'GENESIS' sentinel for previous_hash
- 'PENDING' hash_chain value = legacy insert that bypassed writeAuditEntry (temporary during migration)
- `auditContextMiddleware` (in `@arda/auth-utils`) extracts IP/UA and attaches `req.auditContext`
- Middleware order: authMiddleware → auditContextMiddleware → tenantContext → routes
- When refactoring to writeAuditEntry, ALL test files mocking @arda/db must include writeAuditEntry/writeAuditEntries
- Tests asserting audit behavior: use hoisted mock that pushes to testState.insertedAuditRows
- Tests not asserting audit: simple no-op mock: `writeAuditEntry: vi.fn(async () => ({...}))`
- System-initiated audit: `userId: null`, `metadata: { systemActor: '<service_name>' }`
- FR-07 actions: work_order.rework, inventory.adjusted, inventory.ledger_updated
- Route helper functions (e.g. writeWorkOrderStatusAudit) also need refactoring — easy to miss in grep
- Drizzle insert chain `.values(...).returning({col}).execute()`: .returning() returns a builder, not an array

### Auth Audit Pattern
- Centralized audit helpers in `services/auth/src/services/auth-audit.ts`: action constants, redaction, writeAuthAuditEntry
- Service functions accept optional `auditCtx?: AuthAuditContext` (ipAddress, userAgent, userId)
- Routes extract audit context with `extractAuditContext(req)` — works for both authenticated and unauthenticated requests
- For unauthenticated endpoints: extract IP from X-Forwarded-For or socket.remoteAddress, UA from header
- `redactSensitiveFields()` deep-clones and replaces sensitive keys with '[REDACTED]' — applied to previousState/newState/metadata
- User management actions use `performedBy` field in input to track the admin who performed the action
- Failed login audits use `userId: null` (security event, can't attribute to authenticated user)
- Login with unknown email produces no audit entry (no tenantId available for hash chain)
- FR-05 action constants: user.login, user.login_failed, user.logout, user.registered, user.password_reset_requested, user.password_reset_completed, token.refreshed, token.replay_detected, token.revoked, user.invited, user.role_changed, user.deactivated, user.reactivated, oauth.google_login, oauth.google_linked, oauth.google_registered, api_key.created, api_key.revoked

### Catalog Audit Pattern
- Actions: part.created, part.updated, part.deactivated, supplier.created, supplier.updated, supplier.part_linked, bom_line.added, bom_line.removed, category.created, category.updated
- getRequestAuditContext(req) helper in each route file — extracts IP/UA for audit context
- Field-level diffs: iterate Object.keys(input) for previousState/newState with only changed fields
- BOM audit metadata includes parent/child partNumber + partName for context
- Facilities and storage locations are read-only (GET only) — no audit writes needed

### Notifications Audit Pattern
- Actions: notification.dismissed, notification_preference.updated
- notification.dismissed: previousState captures {type, isRead}, metadata includes notificationType
- notification_preference.updated: entityId is null (bulk update), previousState/newState are preference maps
- Must import `type Request` from 'express' (not use Express.Request global namespace) for getRequestAuditContext

### Audit Query API Pattern
- Drizzle `selectDistinct()` for distinct value lookups (available since 0.39+)
- Drizzle LEFT JOIN changes result shape to `{ table_name: {...}, joined: {...} }` — flatten in response
- Drizzle has no native UNION support — use `db.execute(sql.raw(...))` for UNION ALL queries
- Boolean query params: `z.enum(['true','false']).transform(v => v === 'true')` with `.default('false')`
- `buildParameterizedQuery()` converts $N placeholders to SQL-escaped literals for sql.raw()
- actorName filter: LEFT JOIN auth.users, ILIKE on `firstName || ' ' || lastName`
- entityName filter: ILIKE on `CAST(metadata AS TEXT)` searches all JSONB values
- search filter: OR across action, entityType, and metadata text
- Entity history endpoint returns chronological ASC order
- Archive UNION: re-index $N params for second subquery (offset by first query's param count)

### Audit Integrity Check Pattern
- recomputeHash() must match writeAuditEntry's canonical format exactly
- Batch processing (500 entries/batch) for memory efficiency
- PENDING entries skipped in verification (chain resets after them)
- Violation types: hash_mismatch, chain_break, sequence_gap, pending_hash
- Cap violation output at 100 entries for response size limits
- requireRole('tenant_admin') for admin-only access

### Express Routes
- Register routers in service index.ts with `app.use(prefix, router)`
- Middleware order: helmet → cors → express.json → routes → errorHandler
- Use route-level middleware for RBAC: `router.post('/path', requireRole('admin'), handler)`
