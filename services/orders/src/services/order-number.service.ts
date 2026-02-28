import { db, schema } from '@arda/db';
import { eq, and, sql, like } from 'drizzle-orm';

const { purchaseOrders, workOrders, transferOrders, salesOrders } = schema;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Generate the next sequential order number for a given tenant and type.
 * Format: PO-YYYYMMDD-XXXX, WO-YYYYMMDD-XXXX, TO-YYYYMMDD-XXXX, SO-YYYYMMDD-XXXX
 *
 * Uses pg_advisory_xact_lock to serialize concurrent access per tenant/type/date,
 * preventing duplicate order numbers under concurrent requests.
 */
async function getNextNumber(
  tenantId: string,
  prefix: 'PO' | 'WO' | 'TO' | 'SO',
  tx?: DbTransaction
): Promise<string> {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const pattern = `${prefix}-${dateStr}-%`;

  const execute = async (executor: typeof db | DbTransaction) => {
    // Acquire an advisory lock scoped to this transaction.
    // hashtext produces a stable int4 from the composite key so different
    // tenant+prefix+date combos don't block each other.
    await executor.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId + prefix + dateStr}))`
    );

    let maxNumber = 0;

    if (prefix === 'PO') {
      const result = await executor
        .select({ poNumber: purchaseOrders.poNumber })
        .from(purchaseOrders)
        .where(
          and(eq(purchaseOrders.tenantId, tenantId), like(purchaseOrders.poNumber, pattern))
        )
        .orderBy(sql`${purchaseOrders.poNumber} DESC`)
        .limit(1);

      if (result.length > 0) {
        const last = result[0].poNumber.split('-').pop();
        maxNumber = parseInt(last || '0', 10);
      }
    } else if (prefix === 'WO') {
      const result = await executor
        .select({ woNumber: workOrders.woNumber })
        .from(workOrders)
        .where(
          and(eq(workOrders.tenantId, tenantId), like(workOrders.woNumber, pattern))
        )
        .orderBy(sql`${workOrders.woNumber} DESC`)
        .limit(1);

      if (result.length > 0) {
        const last = result[0].woNumber.split('-').pop();
        maxNumber = parseInt(last || '0', 10);
      }
    } else if (prefix === 'SO') {
      const result = await executor
        .select({ soNumber: salesOrders.soNumber })
        .from(salesOrders)
        .where(
          and(eq(salesOrders.tenantId, tenantId), like(salesOrders.soNumber, pattern))
        )
        .orderBy(sql`${salesOrders.soNumber} DESC`)
        .limit(1);

      if (result.length > 0) {
        const last = result[0].soNumber.split('-').pop();
        maxNumber = parseInt(last || '0', 10);
      }
    } else {
      const result = await executor
        .select({ toNumber: transferOrders.toNumber })
        .from(transferOrders)
        .where(
          and(eq(transferOrders.tenantId, tenantId), like(transferOrders.toNumber, pattern))
        )
        .orderBy(sql`${transferOrders.toNumber} DESC`)
        .limit(1);

      if (result.length > 0) {
        const last = result[0].toNumber.split('-').pop();
        maxNumber = parseInt(last || '0', 10);
      }
    }

    const nextSeq = String(maxNumber + 1).padStart(4, '0');
    return `${prefix}-${dateStr}-${nextSeq}`;
  };

  // If a transaction was provided, use it directly (advisory lock is
  // already scoped to that transaction). Otherwise wrap in a new one.
  if (tx) {
    return execute(tx);
  }
  return db.transaction(async (innerTx) => execute(innerTx));
}

export async function getNextPONumber(tenantId: string, tx?: DbTransaction) {
  return getNextNumber(tenantId, 'PO', tx);
}

export async function getNextWONumber(tenantId: string, tx?: DbTransaction) {
  return getNextNumber(tenantId, 'WO', tx);
}

export async function getNextTONumber(tenantId: string, tx?: DbTransaction) {
  return getNextNumber(tenantId, 'TO', tx);
}

export async function getNextSONumber(tenantId: string, tx?: DbTransaction) {
  return getNextNumber(tenantId, 'SO', tx);
}
