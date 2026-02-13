import { createHash } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@arda/db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    query: {},
  },
  schema: {
    auditLog: {},
    auditLogArchive: {},
    users: {},
  },
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'test', sequenceNumber: 1 })),
}));

vi.mock('@arda/config', () => ({
  config: {},
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
  })),
}));

import {
  generateCsv,
  generateJsonExport,
  generatePdf,
  computeChecksum,
  verifyIntegrity,
  recomputeHashForEntry,
  exportAuditEntries,
} from './audit-export.service.js';
import type { AuditEntry, ExportFilters, IntegrityResult } from './audit-export.service.js';

// ─── Test Data Helpers ──────────────────────────────────────────────

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  const base: AuditEntry = {
    id: 'entry-1',
    tenantId: 'tenant-001',
    userId: 'user-001',
    action: 'order.created',
    entityType: 'work_order',
    entityId: 'entity-001',
    previousState: null,
    newState: { status: 'draft' },
    metadata: { orderNumber: 'WO-001' },
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    timestamp: new Date('2025-01-15T10:00:00.000Z'),
    hashChain: 'abc123',
    previousHash: null,
    sequenceNumber: 1,
  };
  return { ...base, ...overrides };
}

function makeHashedEntries(): AuditEntry[] {
  const entry1: AuditEntry = {
    id: 'entry-1',
    tenantId: 'tenant-001',
    userId: 'user-001',
    action: 'order.created',
    entityType: 'work_order',
    entityId: 'entity-001',
    previousState: null,
    newState: { status: 'draft' },
    metadata: { orderNumber: 'WO-001' },
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    timestamp: new Date('2025-01-15T10:00:00.000Z'),
    hashChain: '',
    previousHash: null,
    sequenceNumber: 1,
  };

  // Compute correct hash for entry1
  entry1.hashChain = recomputeHashForEntry(entry1);

  const entry2: AuditEntry = {
    id: 'entry-2',
    tenantId: 'tenant-001',
    userId: 'user-001',
    action: 'order.updated',
    entityType: 'work_order',
    entityId: 'entity-001',
    previousState: { status: 'draft' },
    newState: { status: 'scheduled' },
    metadata: { orderNumber: 'WO-001' },
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    timestamp: new Date('2025-01-15T11:00:00.000Z'),
    hashChain: '',
    previousHash: entry1.hashChain,
    sequenceNumber: 2,
  };

  entry2.hashChain = recomputeHashForEntry(entry2);

  return [entry1, entry2];
}

const testFilters: ExportFilters = {
  action: 'order.created',
  entityType: 'work_order',
};

const validIntegrity: IntegrityResult = {
  totalChecked: 2,
  violationCount: 0,
  valid: true,
};

// ─── CSV Export Tests ───────────────────────────────────────────────

describe('generateCsv', () => {
  it('produces header row with required columns', () => {
    const csv = generateCsv([]);
    const header = csv.split('\n')[0];
    const columns = header.split(',');
    expect(columns).toContain('timestamp');
    expect(columns).toContain('action');
    expect(columns).toContain('entityType');
    expect(columns).toContain('entityId');
    expect(columns).toContain('userId');
    expect(columns).toContain('actorName');
    expect(columns).toContain('previousState');
    expect(columns).toContain('newState');
    expect(columns).toContain('metadata');
    expect(columns).toContain('hashChain');
  });

  it('generates correct number of rows (header + entries)', () => {
    const entries = [makeEntry(), makeEntry({ id: 'entry-2', sequenceNumber: 2 })];
    const csv = generateCsv(entries);
    const lines = csv.split('\n');
    expect(lines.length).toBe(3); // 1 header + 2 data rows
  });

  it('includes entry data in CSV output', () => {
    const entry = makeEntry({
      action: 'order.created',
      entityType: 'work_order',
      entityId: 'entity-001',
    });
    const csv = generateCsv([entry]);
    const lines = csv.split('\n');
    const dataRow = lines[1];
    expect(dataRow).toContain('order.created');
    expect(dataRow).toContain('work_order');
    expect(dataRow).toContain('entity-001');
  });

  it('escapes CSV fields with commas', () => {
    const entry = makeEntry({
      metadata: { note: 'value,with,commas' },
    });
    const csv = generateCsv([entry]);
    // Metadata column should be double-quoted because it contains commas (JSON has commas)
    expect(csv).toContain('"');
  });

  it('handles null fields gracefully', () => {
    const entry = makeEntry({
      entityId: null,
      userId: null,
      previousState: null,
      metadata: null,
    });
    const csv = generateCsv([entry]);
    expect(csv).toBeDefined();
    const lines = csv.split('\n');
    expect(lines.length).toBe(2);
  });

  it('formats timestamps as ISO strings', () => {
    const ts = new Date('2025-06-15T14:30:00.000Z');
    const entry = makeEntry({ timestamp: ts });
    const csv = generateCsv([entry]);
    expect(csv).toContain('2025-06-15T14:30:00.000Z');
  });
});

// ─── JSON Export Tests ──────────────────────────────────────────────

describe('generateJsonExport', () => {
  it('produces valid JSON with required envelope fields', () => {
    const entries = [makeEntry()];
    const json = generateJsonExport(entries, 'tenant-001', 'user-001', testFilters, validIntegrity);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty('exportedAt');
    expect(parsed).toHaveProperty('exportedBy', 'user-001');
    expect(parsed).toHaveProperty('tenantId', 'tenant-001');
    expect(parsed).toHaveProperty('filters');
    expect(parsed).toHaveProperty('hashChainValid');
    expect(parsed).toHaveProperty('entries');
  });

  it('includes entries array in the envelope', () => {
    const entries = [makeEntry(), makeEntry({ id: 'entry-2', sequenceNumber: 2 })];
    const json = generateJsonExport(entries, 'tenant-001', 'user-001', testFilters, validIntegrity);
    const parsed = JSON.parse(json);
    expect(parsed.entries).toHaveLength(2);
  });

  it('sets hashChainValid to true when integrity passes', () => {
    const json = generateJsonExport([makeEntry()], 'tenant-001', 'user-001', testFilters, validIntegrity);
    const parsed = JSON.parse(json);
    expect(parsed.hashChainValid).toBe(true);
  });

  it('sets hashChainValid to false when integrity fails', () => {
    const failedIntegrity: IntegrityResult = {
      totalChecked: 2,
      violationCount: 1,
      valid: false,
    };
    const json = generateJsonExport([makeEntry()], 'tenant-001', 'user-001', testFilters, failedIntegrity);
    const parsed = JSON.parse(json);
    expect(parsed.hashChainValid).toBe(false);
  });

  it('includes filter values in the envelope', () => {
    const filters: ExportFilters = { action: 'order.created', entityType: 'work_order' };
    const json = generateJsonExport([makeEntry()], 'tenant-001', 'user-001', filters, validIntegrity);
    const parsed = JSON.parse(json);
    expect(parsed.filters.action).toBe('order.created');
    expect(parsed.filters.entityType).toBe('work_order');
  });

  it('includes exportedAt as a valid ISO string', () => {
    const json = generateJsonExport([makeEntry()], 'tenant-001', 'user-001', testFilters, validIntegrity);
    const parsed = JSON.parse(json);
    const date = new Date(parsed.exportedAt);
    expect(date.toISOString()).toBe(parsed.exportedAt);
  });
});

// ─── PDF Export Tests ───────────────────────────────────────────────

describe('generatePdf', () => {
  it('produces a Buffer with PDF header', async () => {
    const entries = [makeEntry()];
    const buffer = await generatePdf(entries, 'tenant-001', testFilters, validIntegrity);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // PDF files start with %PDF
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('produces a non-empty buffer for empty entries', async () => {
    const buffer = await generatePdf([], 'tenant-001', {}, validIntegrity);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('handles entries with null fields', async () => {
    const entry = makeEntry({
      entityId: null,
      userId: null,
      previousState: null,
      metadata: null,
    });
    const buffer = await generatePdf([entry], 'tenant-001', testFilters, validIntegrity);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});

// ─── Checksum Tests ─────────────────────────────────────────────────

describe('computeChecksum', () => {
  it('returns a valid SHA-256 hex string', () => {
    const checksum = computeChecksum('hello world');
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is consistent for the same input', () => {
    const data = 'test data for checksum';
    const c1 = computeChecksum(data);
    const c2 = computeChecksum(data);
    expect(c1).toBe(c2);
  });

  it('matches Node.js crypto SHA-256', () => {
    const data = 'test checksum data';
    const expected = createHash('sha256').update(data).digest('hex');
    expect(computeChecksum(data)).toBe(expected);
  });

  it('works with Buffer input', () => {
    const buf = Buffer.from('binary data');
    const checksum = computeChecksum(buf);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different checksums for different inputs', () => {
    const c1 = computeChecksum('data1');
    const c2 = computeChecksum('data2');
    expect(c1).not.toBe(c2);
  });
});

// ─── Integrity Verification Tests ───────────────────────────────────

describe('verifyIntegrity', () => {
  it('returns valid for correctly hashed entries', () => {
    const entries = makeHashedEntries();
    const result = verifyIntegrity(entries);
    expect(result.valid).toBe(true);
    expect(result.violationCount).toBe(0);
    expect(result.totalChecked).toBe(2);
  });

  it('detects hash mismatch', () => {
    const entries = makeHashedEntries();
    entries[1].hashChain = 'tampered-hash-value';
    const result = verifyIntegrity(entries);
    expect(result.valid).toBe(false);
    expect(result.violationCount).toBeGreaterThan(0);
  });

  it('detects chain breaks', () => {
    const entries = makeHashedEntries();
    entries[1].previousHash = 'wrong-previous-hash';
    const result = verifyIntegrity(entries);
    expect(result.valid).toBe(false);
    expect(result.violationCount).toBeGreaterThan(0);
  });

  it('detects sequence gaps', () => {
    const entries = makeHashedEntries();
    entries[1].sequenceNumber = 5; // Gap from 1 to 5
    const result = verifyIntegrity(entries);
    expect(result.valid).toBe(false);
    expect(result.violationCount).toBeGreaterThan(0);
  });

  it('handles PENDING entries gracefully', () => {
    const entry = makeEntry({
      hashChain: 'PENDING',
      sequenceNumber: 1,
    });
    const result = verifyIntegrity([entry]);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(1);
  });

  it('returns valid for empty entries', () => {
    const result = verifyIntegrity([]);
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(0);
  });
});

// ─── Hash Recomputation Tests ───────────────────────────────────────

describe('recomputeHashForEntry', () => {
  it('produces a 64-character hex string', () => {
    const hash = recomputeHashForEntry({
      tenantId: 'tenant-001',
      sequenceNumber: 1,
      action: 'order.created',
      entityType: 'work_order',
      entityId: 'entity-001',
      timestamp: new Date('2025-01-15T10:00:00.000Z'),
      previousHash: null,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces consistent results for same input', () => {
    const params = {
      tenantId: 'tenant-001',
      sequenceNumber: 1,
      action: 'order.created',
      entityType: 'work_order',
      entityId: 'entity-001',
      timestamp: new Date('2025-01-15T10:00:00.000Z'),
      previousHash: null,
    };
    expect(recomputeHashForEntry(params)).toBe(recomputeHashForEntry(params));
  });

  it('handles null entityId', () => {
    const hash = recomputeHashForEntry({
      tenantId: 'tenant-001',
      sequenceNumber: 1,
      action: 'system.init',
      entityType: 'system',
      entityId: null,
      timestamp: new Date('2025-01-15T10:00:00.000Z'),
      previousHash: null,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles string timestamps', () => {
    const hash = recomputeHashForEntry({
      tenantId: 'tenant-001',
      sequenceNumber: 1,
      action: 'order.created',
      entityType: 'work_order',
      entityId: 'entity-001',
      timestamp: '2025-01-15T10:00:00.000Z',
      previousHash: null,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Full Export Pipeline Tests ─────────────────────────────────────

describe('exportAuditEntries', () => {
  it('exports CSV with checksum', async () => {
    const entries = [makeEntry()];
    const result = await exportAuditEntries('csv', entries, 'tenant-001', 'user-001', testFilters);

    expect(result.contentType).toBe('text/csv; charset=utf-8');
    expect(result.filename).toMatch(/^audit-export-.*\.csv$/);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof result.body).toBe('string');

    // Verify checksum matches body
    const expected = createHash('sha256').update(result.body).digest('hex');
    expect(result.checksum).toBe(expected);
  });

  it('exports JSON with checksum and envelope', async () => {
    const entries = [makeEntry()];
    const result = await exportAuditEntries('json', entries, 'tenant-001', 'user-001', testFilters);

    expect(result.contentType).toBe('application/json; charset=utf-8');
    expect(result.filename).toMatch(/^audit-export-.*\.json$/);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);

    const parsed = JSON.parse(result.body as string);
    expect(parsed).toHaveProperty('exportedAt');
    expect(parsed).toHaveProperty('exportedBy');
    expect(parsed).toHaveProperty('tenantId');
    expect(parsed).toHaveProperty('filters');
    expect(parsed).toHaveProperty('hashChainValid');
    expect(parsed).toHaveProperty('entries');

    // Verify checksum matches body
    const expected = createHash('sha256').update(result.body).digest('hex');
    expect(result.checksum).toBe(expected);
  });

  it('exports PDF with checksum', async () => {
    const entries = [makeEntry()];
    const result = await exportAuditEntries('pdf', entries, 'tenant-001', 'user-001', testFilters);

    expect(result.contentType).toBe('application/pdf');
    expect(result.filename).toMatch(/^audit-export-.*\.pdf$/);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.isBuffer(result.body)).toBe(true);

    // Verify PDF header
    expect((result.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    // Verify checksum matches body
    const expected = createHash('sha256').update(result.body).digest('hex');
    expect(result.checksum).toBe(expected);
  });

  it('throws for unsupported format', async () => {
    await expect(
      exportAuditEntries('xml' as any, [makeEntry()], 'tenant-001', 'user-001', testFilters)
    ).rejects.toThrow('Unsupported export format: xml');
  });

  it('handles empty entries for all formats', async () => {
    for (const format of ['csv', 'json', 'pdf'] as const) {
      const result = await exportAuditEntries(format, [], 'tenant-001', 'user-001', {});
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(result.body).toBeDefined();
    }
  });

  it('JSON export includes integrity result from entries', async () => {
    // Use correctly hashed entries so integrity passes
    const entries = makeHashedEntries();
    const result = await exportAuditEntries('json', entries, 'tenant-001', 'user-001', {});
    const parsed = JSON.parse(result.body as string);
    expect(parsed.hashChainValid).toBe(true);
  });

  it('JSON export detects invalid hash chains', async () => {
    const entries = makeHashedEntries();
    entries[1].hashChain = 'tampered';
    const result = await exportAuditEntries('json', entries, 'tenant-001', 'user-001', {});
    const parsed = JSON.parse(result.body as string);
    expect(parsed.hashChainValid).toBe(false);
  });
});

// ─── Filter Parity Tests ────────────────────────────────────────────

describe('filter parity with GET /api/audit', () => {
  it('export body schema accepts all base audit filter fields', () => {
    // This test verifies the export endpoint accepts the same filters
    // as the GET /api/audit endpoint. We test by checking that the
    // service functions accept all filter fields without error.
    const fullFilters: ExportFilters = {
      action: 'order.created',
      entityType: 'work_order',
      entityId: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      dateFrom: '2025-01-01T00:00:00.000Z',
      dateTo: '2025-12-31T23:59:59.000Z',
      actorName: 'John Doe',
      entityName: 'WO-001',
      search: 'created',
      includeArchived: false,
    };

    // generateCsv should not throw with any filter combination
    const csv = generateCsv([makeEntry()]);
    expect(csv).toBeDefined();

    // generateJsonExport should include filters in envelope
    const json = generateJsonExport([makeEntry()], 'tenant-001', 'user-001', fullFilters, validIntegrity);
    const parsed = JSON.parse(json);
    expect(parsed.filters.action).toBe('order.created');
    expect(parsed.filters.entityType).toBe('work_order');
    expect(parsed.filters.entityId).toBe('00000000-0000-0000-0000-000000000001');
    expect(parsed.filters.userId).toBe('00000000-0000-0000-0000-000000000002');
    expect(parsed.filters.dateFrom).toBe('2025-01-01T00:00:00.000Z');
    expect(parsed.filters.dateTo).toBe('2025-12-31T23:59:59.000Z');
    expect(parsed.filters.actorName).toBe('John Doe');
    expect(parsed.filters.entityName).toBe('WO-001');
    expect(parsed.filters.search).toBe('created');
  });
});
