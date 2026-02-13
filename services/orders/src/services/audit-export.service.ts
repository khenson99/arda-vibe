import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { createLogger } from '@arda/config';

const logger = createLogger('audit-export');

// ─── Types ──────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'json' | 'pdf';

export interface AuditEntry {
  id: string;
  tenantId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  previousState: unknown;
  newState: unknown;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: Date | string;
  hashChain: string;
  previousHash: string | null;
  sequenceNumber: number;
}

export interface ExportFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  dateFrom?: string;
  dateTo?: string;
  actorName?: string;
  entityName?: string;
  search?: string;
  includeArchived?: boolean;
}

export interface IntegrityResult {
  totalChecked: number;
  violationCount: number;
  valid: boolean;
}

export interface ExportResult {
  body: Buffer | string;
  contentType: string;
  filename: string;
  checksum: string;
}

// ─── CSV Export ──────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'timestamp',
  'action',
  'entityType',
  'entityId',
  'userId',
  'actorName',
  'previousState',
  'newState',
  'metadata',
  'hashChain',
] as const;

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatTimestamp(ts: Date | string): string {
  if (ts instanceof Date) {
    return ts.toISOString();
  }
  return String(ts);
}

function jsonStringify(val: unknown): string {
  if (val === null || val === undefined) return '';
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export function generateCsv(entries: AuditEntry[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = entries.map((entry) => {
    const values: string[] = [
      escapeCsvField(formatTimestamp(entry.timestamp)),
      escapeCsvField(entry.action),
      escapeCsvField(entry.entityType),
      escapeCsvField(entry.entityId ?? ''),
      escapeCsvField(entry.userId ?? ''),
      escapeCsvField(resolveActorName(entry)),
      escapeCsvField(jsonStringify(entry.previousState)),
      escapeCsvField(jsonStringify(entry.newState)),
      escapeCsvField(jsonStringify(entry.metadata)),
      escapeCsvField(entry.hashChain),
    ];
    return values.join(',');
  });

  return [header, ...rows].join('\n');
}

// ─── JSON Export ────────────────────────────────────────────────────

export interface JsonExportEnvelope {
  exportedAt: string;
  exportedBy: string;
  tenantId: string;
  filters: ExportFilters;
  hashChainValid: boolean;
  entries: AuditEntry[];
}

export function generateJsonExport(
  entries: AuditEntry[],
  tenantId: string,
  userId: string,
  filters: ExportFilters,
  integrityResult: IntegrityResult,
): string {
  const envelope: JsonExportEnvelope = {
    exportedAt: new Date().toISOString(),
    exportedBy: userId,
    tenantId,
    filters,
    hashChainValid: integrityResult.valid,
    entries,
  };

  return JSON.stringify(envelope, null, 2);
}

// ─── PDF Export ─────────────────────────────────────────────────────

export async function generatePdf(
  entries: AuditEntry[],
  tenantId: string,
  filters: ExportFilters,
  integrityResult: IntegrityResult,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 40,
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Header ──
      doc.fontSize(18).font('Helvetica-Bold').text('Audit Trail Export', { align: 'center' });
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica');
      doc.text(`Tenant: ${tenantId}`, { align: 'left' });
      doc.text(`Exported: ${new Date().toISOString()}`, { align: 'left' });

      // Filter summary
      const activeFilters = Object.entries(filters)
        .filter(([, v]) => v !== undefined && v !== false)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      if (activeFilters) {
        doc.text(`Filters: ${activeFilters}`, { align: 'left' });
      }
      doc.text(`Total entries: ${entries.length}`, { align: 'left' });
      doc.moveDown(1);

      // ── Table ──
      const tableColumns = [
        { header: 'Timestamp', width: 130, key: 'timestamp' as const },
        { header: 'Action', width: 100, key: 'action' as const },
        { header: 'Entity Type', width: 80, key: 'entityType' as const },
        { header: 'Entity ID', width: 100, key: 'entityId' as const },
        { header: 'User ID', width: 100, key: 'userId' as const },
        { header: 'Hash Chain', width: 200, key: 'hashChain' as const },
      ];

      const startX = doc.x;
      const colGap = 5;

      // Draw table header
      doc.font('Helvetica-Bold').fontSize(8);
      let xPos = startX;
      for (const col of tableColumns) {
        doc.text(col.header, xPos, doc.y, { width: col.width, continued: false });
        xPos += col.width + colGap;
      }
      const headerY = doc.y;
      doc.moveTo(startX, headerY).lineTo(startX + 750, headerY).stroke();
      doc.moveDown(0.3);

      // Draw rows
      doc.font('Helvetica').fontSize(7);
      for (const entry of entries) {
        // Check if we need a new page
        if (doc.y > 500) {
          doc.addPage();
          doc.font('Helvetica').fontSize(7);
        }

        const rowY = doc.y;
        xPos = startX;
        for (const col of tableColumns) {
          let value = '';
          switch (col.key) {
            case 'timestamp':
              value = formatTimestamp(entry.timestamp);
              break;
            case 'action':
              value = entry.action;
              break;
            case 'entityType':
              value = entry.entityType;
              break;
            case 'entityId':
              value = entry.entityId ?? '';
              break;
            case 'userId':
              value = entry.userId ?? '';
              break;
            case 'hashChain':
              value = entry.hashChain;
              break;
          }
          doc.text(value, xPos, rowY, { width: col.width, lineBreak: false });
          xPos += col.width + colGap;
        }
        doc.moveDown(0.2);
      }

      // ── Final page: Hash-chain verification summary ──
      doc.addPage();
      doc.fontSize(14).font('Helvetica-Bold').text('Hash-Chain Verification Summary', { align: 'center' });
      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica');
      doc.text(`Total entries checked: ${integrityResult.totalChecked}`);
      doc.text(`Violations found: ${integrityResult.violationCount}`);
      doc.moveDown(0.5);

      doc.fontSize(14).font('Helvetica-Bold');
      if (integrityResult.valid) {
        doc.fillColor('green').text('HASH CHAIN VALID', { align: 'center' });
      } else {
        doc.fillColor('red').text('HASH CHAIN INVALID', { align: 'center' });
        doc.fillColor('red').fontSize(10).font('Helvetica')
          .text(`${integrityResult.violationCount} violation(s) detected. See integrity-check endpoint for details.`);
      }
      doc.fillColor('black'); // Reset

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Integrity Check (reused from audit.routes.ts logic) ────────────

const GENESIS_SENTINEL = 'GENESIS';

export function recomputeHashForEntry(entry: {
  tenantId: string;
  sequenceNumber: number;
  action: string;
  entityType: string;
  entityId: string | null;
  timestamp: Date | string;
  previousHash: string | null;
}): string {
  const prevHash = entry.previousHash ?? GENESIS_SENTINEL;
  const entityId = entry.entityId ?? '';
  const ts = entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp);
  const payload = [
    entry.tenantId,
    entry.sequenceNumber.toString(),
    entry.action,
    entry.entityType,
    entityId,
    ts.toISOString(),
    prevHash,
  ].join('|');

  return createHash('sha256').update(payload).digest('hex');
}

export function verifyIntegrity(entries: AuditEntry[]): IntegrityResult {
  let violationCount = 0;
  let lastSequence = 0;
  let lastHash: string | null = null;

  for (const entry of entries) {
    // Skip PENDING entries
    if (entry.hashChain === 'PENDING') {
      lastSequence = entry.sequenceNumber;
      lastHash = null;
      continue;
    }

    // Check sequence gap
    if (lastSequence > 0 && entry.sequenceNumber !== lastSequence + 1) {
      violationCount++;
    }

    // Verify chain link
    if (lastHash !== null && entry.previousHash !== lastHash) {
      violationCount++;
    }

    // Recompute and verify hash
    const expected = recomputeHashForEntry({
      tenantId: entry.tenantId,
      sequenceNumber: entry.sequenceNumber,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      timestamp: entry.timestamp,
      previousHash: entry.previousHash,
    });

    if (entry.hashChain !== expected) {
      violationCount++;
    }

    lastSequence = entry.sequenceNumber;
    lastHash = entry.hashChain;
  }

  return {
    totalChecked: entries.length,
    violationCount,
    valid: violationCount === 0,
  };
}

// ─── Checksum ───────────────────────────────────────────────────────

export function computeChecksum(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ─── Actor Name Resolution ──────────────────────────────────────────

function resolveActorName(entry: AuditEntry): string {
  // Try to extract actor name from metadata
  const meta = entry.metadata;
  if (meta && typeof meta === 'object') {
    if (typeof (meta as any).actorName === 'string') return (meta as any).actorName;
    if (typeof (meta as any).userName === 'string') return (meta as any).userName;
    if (typeof (meta as any).actor_name === 'string') return (meta as any).actor_name;
  }
  return entry.userId ?? '';
}

// ─── Main Export Function ───────────────────────────────────────────

export async function exportAuditEntries(
  format: ExportFormat,
  entries: AuditEntry[],
  tenantId: string,
  userId: string,
  filters: ExportFilters,
): Promise<ExportResult> {
  logger.info({ format, entryCount: entries.length, tenantId }, 'Generating audit export');

  // Run integrity check on the entries
  // Sort by sequence number for integrity verification
  const sortedEntries = [...entries].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const integrityResult = verifyIntegrity(sortedEntries);

  const now = new Date().toISOString().replace(/[:.]/g, '-');

  switch (format) {
    case 'csv': {
      const csv = generateCsv(entries);
      const checksum = computeChecksum(csv);
      return {
        body: csv,
        contentType: 'text/csv; charset=utf-8',
        filename: `audit-export-${now}.csv`,
        checksum,
      };
    }

    case 'json': {
      const json = generateJsonExport(entries, tenantId, userId, filters, integrityResult);
      const checksum = computeChecksum(json);
      return {
        body: json,
        contentType: 'application/json; charset=utf-8',
        filename: `audit-export-${now}.json`,
        checksum,
      };
    }

    case 'pdf': {
      const pdfBuffer = await generatePdf(entries, tenantId, filters, integrityResult);
      const checksum = computeChecksum(pdfBuffer);
      return {
        body: pdfBuffer,
        contentType: 'application/pdf',
        filename: `audit-export-${now}.pdf`,
        checksum,
      };
    }

    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}
