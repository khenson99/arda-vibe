/**
 * Data Export Worker
 *
 * Exports order data (POs, WOs, TOs) to CSV or JSON format for a
 * given tenant and date range. This is an on-demand worker — jobs are
 * enqueued by API endpoints, not by a scheduler.
 *
 * The export result is stored as a JSON/CSV string in the job's
 * return value, which can be retrieved by the API and streamed to
 * the client or uploaded to S3.
 *
 * Schedule: On-demand (no repeatable schedule)
 * Concurrency: 1 (to limit memory pressure from large exports)
 */

import type { Job, Queue, Worker } from 'bullmq';
import {
  createQueue,
  createWorker,
  buildJobEnvelope,
  createDLQ,
  moveToDeadLetterQueue,
} from '@arda/jobs';
import type { JobEnvelope } from '@arda/jobs';
import { db, schema } from '@arda/db';
import { eq, and, gte, lte } from 'drizzle-orm';

const {
  purchaseOrders,
  workOrders,
  transferOrders,
} = schema;

// ─── Payload Types ──────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'json';
export type ExportOrderType = 'purchase_orders' | 'work_orders' | 'transfer_orders' | 'all';

export interface DataExportPayload {
  /** What order types to export */
  orderType: ExportOrderType;
  /** Export format */
  format: ExportFormat;
  /** Start of date range (ISO 8601) */
  startDate: string;
  /** End of date range (ISO 8601) */
  endDate: string;
  /** Optional: filter by status */
  statusFilter?: string[];
  /** Optional: filter by facility ID */
  facilityId?: string;
}

export interface DataExportResult {
  /** Total number of records exported */
  recordCount: number;
  /** Export data as string (CSV or JSON) */
  data: string;
  /** Format of the export */
  format: ExportFormat;
  /** Order type(s) included */
  orderType: ExportOrderType;
  /** When the export was generated */
  generatedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const QUEUE_NAME = 'orders:data-export';
const JOB_TYPE = 'orders.data_export';
const MAX_EXPORT_ROWS = 10_000;

// ─── Queue Factory ──────────────────────────────────────────────────

export function createDataExportQueue(redisUrl: string): Queue<JobEnvelope<DataExportPayload>> {
  return createQueue<DataExportPayload>(QUEUE_NAME, {
    redisUrl,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 10_000 },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });
}

// ─── CSV Helpers ────────────────────────────────────────────────────

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const headerLine = headers.map(escapeCsvField).join(',');
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCsvField(row[h])).join(','),
  );
  return [headerLine, ...dataLines].join('\n');
}

// ─── Data Fetchers ──────────────────────────────────────────────────

async function fetchPurchaseOrders(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  facilityId?: string,
) {
  const conditions = [
    eq(purchaseOrders.tenantId, tenantId),
    gte(purchaseOrders.createdAt, startDate),
    lte(purchaseOrders.createdAt, endDate),
  ];
  if (facilityId) {
    conditions.push(eq(purchaseOrders.facilityId, facilityId));
  }

  return db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      status: purchaseOrders.status,
      supplierId: purchaseOrders.supplierId,
      facilityId: purchaseOrders.facilityId,
      orderDate: purchaseOrders.orderDate,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      actualDeliveryDate: purchaseOrders.actualDeliveryDate,
      subtotal: purchaseOrders.subtotal,
      taxAmount: purchaseOrders.taxAmount,
      shippingAmount: purchaseOrders.shippingAmount,
      totalAmount: purchaseOrders.totalAmount,
      currency: purchaseOrders.currency,
      createdAt: purchaseOrders.createdAt,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .where(and(...conditions))
    .limit(MAX_EXPORT_ROWS);
}

async function fetchWorkOrders(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  facilityId?: string,
) {
  const conditions = [
    eq(workOrders.tenantId, tenantId),
    gte(workOrders.createdAt, startDate),
    lte(workOrders.createdAt, endDate),
  ];
  if (facilityId) {
    conditions.push(eq(workOrders.facilityId, facilityId));
  }

  return db
    .select({
      id: workOrders.id,
      woNumber: workOrders.woNumber,
      status: workOrders.status,
      partId: workOrders.partId,
      facilityId: workOrders.facilityId,
      quantityToProduce: workOrders.quantityToProduce,
      quantityProduced: workOrders.quantityProduced,
      quantityRejected: workOrders.quantityRejected,
      quantityScrapped: workOrders.quantityScrapped,
      priority: workOrders.priority,
      isExpedited: workOrders.isExpedited,
      scheduledStartDate: workOrders.scheduledStartDate,
      scheduledEndDate: workOrders.scheduledEndDate,
      actualStartDate: workOrders.actualStartDate,
      actualEndDate: workOrders.actualEndDate,
      createdAt: workOrders.createdAt,
      updatedAt: workOrders.updatedAt,
    })
    .from(workOrders)
    .where(and(...conditions))
    .limit(MAX_EXPORT_ROWS);
}

async function fetchTransferOrders(
  tenantId: string,
  startDate: Date,
  endDate: Date,
) {
  return db
    .select({
      id: transferOrders.id,
      toNumber: transferOrders.toNumber,
      status: transferOrders.status,
      sourceFacilityId: transferOrders.sourceFacilityId,
      destinationFacilityId: transferOrders.destinationFacilityId,
      requestedDate: transferOrders.requestedDate,
      shippedDate: transferOrders.shippedDate,
      receivedDate: transferOrders.receivedDate,
      notes: transferOrders.notes,
      createdAt: transferOrders.createdAt,
      updatedAt: transferOrders.updatedAt,
    })
    .from(transferOrders)
    .where(
      and(
        eq(transferOrders.tenantId, tenantId),
        gte(transferOrders.createdAt, startDate),
        lte(transferOrders.createdAt, endDate),
      ),
    )
    .limit(MAX_EXPORT_ROWS);
}

// ─── Processor ──────────────────────────────────────────────────────

async function processDataExport(
  job: Job<JobEnvelope<DataExportPayload>>,
): Promise<DataExportResult> {
  const { tenantId, payload } = job.data;
  const { orderType, format, startDate, endDate, facilityId } = payload;

  const start = new Date(startDate);
  const end = new Date(endDate);

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      orderType,
      format,
      dateRange: { start: startDate, end: endDate },
      msg: 'Starting data export',
    }),
  );

  const allRecords: Record<string, unknown>[] = [];
  let headers: string[] = [];

  // Fetch data based on order type
  if (orderType === 'purchase_orders' || orderType === 'all') {
    const pos = await fetchPurchaseOrders(tenantId, start, end, facilityId);
    const posWithType = pos.map((po) => ({ _type: 'purchase_order', ...po }));
    allRecords.push(...posWithType);
    if (pos.length > 0) {
      headers = [...new Set([...headers, '_type', ...Object.keys(pos[0])])];
    }
  }

  if (orderType === 'work_orders' || orderType === 'all') {
    const wos = await fetchWorkOrders(tenantId, start, end, facilityId);
    const wosWithType = wos.map((wo) => ({ _type: 'work_order', ...wo }));
    allRecords.push(...wosWithType);
    if (wos.length > 0) {
      headers = [...new Set([...headers, '_type', ...Object.keys(wos[0])])];
    }
  }

  if (orderType === 'transfer_orders' || orderType === 'all') {
    const tos = await fetchTransferOrders(tenantId, start, end);
    const tosWithType = tos.map((to) => ({ _type: 'transfer_order', ...to }));
    allRecords.push(...tosWithType);
    if (tos.length > 0) {
      headers = [...new Set([...headers, '_type', ...Object.keys(tos[0])])];
    }
  }

  // Serialize dates for export
  const serialized = allRecords.map((record) => {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      row[key] = value instanceof Date ? value.toISOString() : value;
    }
    return row;
  });

  // Format output
  let data: string;
  if (format === 'csv') {
    if (headers.length === 0 && serialized.length > 0) {
      headers = Object.keys(serialized[0]);
    }
    data = toCsv(headers, serialized);
  } else {
    data = JSON.stringify(serialized, null, 2);
  }

  const result: DataExportResult = {
    recordCount: serialized.length,
    data,
    format,
    orderType,
    generatedAt: new Date().toISOString(),
  };

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      jobId: job.data.id,
      tenantId,
      recordCount: result.recordCount,
      format,
      dataSizeBytes: Buffer.byteLength(data, 'utf-8'),
      msg: 'Data export complete',
    }),
  );

  return result;
}

// ─── Worker Startup ─────────────────────────────────────────────────

export function startDataExportWorker(redisUrl: string): {
  worker: Worker<JobEnvelope<DataExportPayload>>;
  queue: Queue<JobEnvelope<DataExportPayload>>;
} {
  const queue = createDataExportQueue(redisUrl);
  const dlq = createDLQ(QUEUE_NAME, redisUrl);

  const worker = createWorker<DataExportPayload>(
    QUEUE_NAME,
    async (job) => {
      try {
        return await processDataExport(job);
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'error',
            worker: QUEUE_NAME,
            jobId: job.data.id,
            tenantId: job.data.tenantId,
            error: err instanceof Error ? err.message : String(err),
            attempt: job.attemptsMade,
            msg: 'Data export failed',
          }),
        );
        throw err;
      }
    },
    {
      redisUrl,
      concurrency: 1,
      // Longer lock duration for potentially large exports
      lockDuration: 120_000,
    },
  );

  worker.on('completed', (job, result) => {
    const exportResult = result as DataExportResult | undefined;
    console.log(
      JSON.stringify({
        level: 'info',
        worker: QUEUE_NAME,
        jobId: job.data.id,
        tenantId: job.data.tenantId,
        recordCount: exportResult?.recordCount ?? 0,
        msg: 'Export job completed',
      }),
    );
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    console.log(
      JSON.stringify({
        level: 'error',
        worker: QUEUE_NAME,
        jobId: job.data.id,
        tenantId: job.data.tenantId,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        error: err.message,
        msg: 'Export job failed',
      }),
    );

    if (job.attemptsMade >= (job.opts.attempts ?? 2)) {
      await moveToDeadLetterQueue(dlq, job, err);
      console.log(
        JSON.stringify({
          level: 'warn',
          worker: QUEUE_NAME,
          jobId: job.data.id,
          msg: 'Export job moved to dead letter queue',
        }),
      );
    }
  });

  console.log(
    JSON.stringify({
      level: 'info',
      worker: QUEUE_NAME,
      msg: 'Data export worker started',
    }),
  );

  return { worker, queue };
}

// ─── Convenience: Enqueue an export job ─────────────────────────────

export function enqueueDataExport(
  queue: Queue<JobEnvelope<DataExportPayload>>,
  tenantId: string,
  payload: DataExportPayload,
) {
  const envelope = buildJobEnvelope<DataExportPayload>(
    JOB_TYPE,
    tenantId,
    payload,
    2, // max 2 retries for exports
  );

  return queue.add(JOB_TYPE, envelope, {
    jobId: `export:${tenantId}:${payload.orderType}:${Date.now()}`,
  });
}
