/**
 * PO Workflow Routes — Preview, Approve, and Email workflow
 *
 * Orchestrates the purchase order lifecycle:
 *   GET  /po-workflow/:poId/preview  — Preview formatted PO document
 *   POST /po-workflow/:poId/approve  — Approve PO + auto-generate email draft
 *   GET  /po-workflow/:poId/status   — Composite workflow status
 */
import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, asc, inArray } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest, AuditContext } from '@arda/auth-utils';
import { getEventBus, publishKpiRefreshed } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { getCorrelationId } from '@arda/observability';
import { AppError } from '../middleware/error-handler.js';
import { buildPdfContent, SimplePdfGenerator } from '../services/po-dispatch.service.js';
import type { PurchaseOrderPdfData } from '../services/po-dispatch.service.js';

const log = createLogger('po-workflow');

export const poWorkflowRouter = Router();

const {
  purchaseOrders,
  purchaseOrderLines,
  emailDrafts,
} = schema;

// ─── Helpers ────────────────────────────────────────────────────────

function getRequestAuditContext(req: AuthRequest): AuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0]?.trim();
  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
  return {
    userId: req.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

function formatDate(d: Date | null | undefined): string {
  return d ? d.toISOString().split('T')[0] : '';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Shared: Fetch full PO data ─────────────────────────────────────

interface POPreviewData {
  po: typeof purchaseOrders.$inferSelect;
  lines: Array<typeof purchaseOrderLines.$inferSelect>;
  supplier: { id: string; name: string; contactName: string | null; contactEmail: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; postalCode: string | null; country: string | null };
  parts: Map<string, { partNumber: string; name: string; uom: string | null }>;
  supplierParts: Map<string, string | null>;
  facility: { name: string; code: string | null } | null;
}

async function fetchPOPreviewData(tenantId: string, poId: string): Promise<POPreviewData | null> {
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.tenantId, tenantId)))
    .limit(1);

  if (!po) return null;

  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(
      and(
        eq(purchaseOrderLines.purchaseOrderId, poId),
        eq(purchaseOrderLines.tenantId, tenantId),
      )
    )
    .orderBy(asc(purchaseOrderLines.lineNumber));

  const [supplier] = await db
    .select()
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, po.supplierId))
    .limit(1);

  if (!supplier) return null;

  const partIds = lines.map((l) => l.partId);
  const partsRows = partIds.length > 0
    ? await db
        .select({
          id: schema.parts.id,
          partNumber: schema.parts.partNumber,
          name: schema.parts.name,
          uom: schema.parts.uom,
        })
        .from(schema.parts)
        .where(inArray(schema.parts.id, partIds))
    : [];

  const supplierPartsRows = partIds.length > 0
    ? await db
        .select({
          partId: schema.supplierParts.partId,
          supplierPartNumber: schema.supplierParts.supplierPartNumber,
        })
        .from(schema.supplierParts)
        .where(
          and(
            eq(schema.supplierParts.supplierId, supplier.id),
            eq(schema.supplierParts.tenantId, tenantId),
          )
        )
    : [];

  const parts = new Map(partsRows.map((p) => [p.id, p]));
  const supplierParts = new Map(supplierPartsRows.map((sp) => [sp.partId, sp.supplierPartNumber]));

  const [facility] = po.facilityId
    ? await db
        .select({ name: schema.facilities.name, code: schema.facilities.code })
        .from(schema.facilities)
        .where(eq(schema.facilities.id, po.facilityId))
        .limit(1)
    : [null];

  return { po, lines, supplier, parts, supplierParts, facility };
}

function buildPdfData(data: POPreviewData): PurchaseOrderPdfData {
  const { po, lines, supplier, parts, supplierParts, facility } = data;

  const addressParts = [
    supplier.addressLine1,
    supplier.addressLine2,
    [supplier.city, supplier.state, supplier.postalCode].filter(Boolean).join(', '),
    supplier.country,
  ].filter(Boolean);

  return {
    poNumber: po.poNumber,
    orderDate: formatDate(po.orderDate) || formatDate(po.createdAt),
    expectedDeliveryDate: formatDate(po.expectedDeliveryDate) || 'TBD',
    supplierName: supplier.name,
    supplierContact: supplier.contactName || 'Procurement',
    supplierEmail: supplier.contactEmail || '',
    supplierAddress: addressParts.join(', ') || 'N/A',
    buyerCompanyName: 'Arda',
    buyerAddress: facility ? `${facility.name}${facility.code ? ` (${facility.code})` : ''}` : po.facilityId,
    facilityName: facility?.name || po.facilityId,
    lines: lines.map((line) => {
      const part = parts.get(line.partId);
      return {
        lineNumber: line.lineNumber,
        partNumber: part?.partNumber || line.partId,
        partName: line.description || part?.name || line.partId,
        quantity: line.quantityOrdered,
        unitCost: String(line.unitCost ?? '0'),
        lineTotal: String(line.lineTotal ?? '0'),
        uom: part?.uom || 'each',
      };
    }),
    subtotal: String(po.subtotal ?? '0'),
    taxAmount: String(po.taxAmount ?? '0'),
    shippingAmount: String(po.shippingAmount ?? '0'),
    totalAmount: String(po.totalAmount ?? '0'),
    currency: po.currency || 'USD',
    notes: po.notes ?? undefined,
    terms: po.paymentTerms ?? undefined,
  };
}

function generatePreviewHtml(data: POPreviewData): string {
  const { po, lines, supplier, parts, supplierParts, facility } = data;
  const currency = po.currency || 'USD';

  const linesHtml = lines.map((line) => {
    const part = parts.get(line.partId);
    const spn = supplierParts.get(line.partId);
    return `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${line.lineNumber}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${escapeHtml(part?.partNumber || 'N/A')}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${escapeHtml(line.description || part?.name || '')}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${spn ? escapeHtml(spn) : '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${line.quantityOrdered}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${currency} ${line.unitCost}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${currency} ${line.lineTotal}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'Open Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#0a0a0a;line-height:1.5;">
  <div style="max-width:700px;margin:0 auto;">
    <h2 style="color:#0a0a0a;margin-bottom:4px;">Purchase Order ${escapeHtml(po.poNumber)}</h2>
    <p style="color:#737373;margin-top:0;">Date: ${formatDate(po.orderDate) || formatDate(po.createdAt)}</p>

    <table style="width:100%;margin-bottom:16px;">
      <tr>
        <td style="vertical-align:top;width:50%;">
          <strong>From:</strong><br/>
          Arda<br/>
          ${facility ? escapeHtml(facility.name) : ''}
        </td>
        <td style="vertical-align:top;width:50%;">
          <strong>To:</strong><br/>
          ${escapeHtml(supplier.name)}<br/>
          ${supplier.contactName ? escapeHtml(supplier.contactName) + '<br/>' : ''}
          ${supplier.contactEmail ? escapeHtml(supplier.contactEmail) : ''}
        </td>
      </tr>
    </table>

    ${po.expectedDeliveryDate ? `<p><strong>Expected Delivery:</strong> ${formatDate(po.expectedDeliveryDate)}</p>` : ''}

    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5;">#</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5;">Part Number</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5;">Description</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5;">Vendor SKU</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e5e5e5;">Qty</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e5e5e5;">Unit Cost</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e5e5e5;">Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${linesHtml}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="6" style="padding:8px;text-align:right;font-weight:600;">Subtotal</td>
          <td style="padding:8px;text-align:right;">${currency} ${po.subtotal || '0.00'}</td>
        </tr>
        <tr>
          <td colspan="6" style="padding:8px;text-align:right;">Tax</td>
          <td style="padding:8px;text-align:right;">${currency} ${po.taxAmount || '0.00'}</td>
        </tr>
        <tr>
          <td colspan="6" style="padding:8px;text-align:right;">Shipping</td>
          <td style="padding:8px;text-align:right;">${currency} ${po.shippingAmount || '0.00'}</td>
        </tr>
        <tr style="font-weight:700;">
          <td colspan="6" style="padding:8px;text-align:right;border-top:2px solid #0a0a0a;">Total</td>
          <td style="padding:8px;text-align:right;border-top:2px solid #0a0a0a;">${currency} ${po.totalAmount || '0.00'}</td>
        </tr>
      </tfoot>
    </table>

    ${po.paymentTerms ? `<p><strong>Payment Terms:</strong> ${escapeHtml(po.paymentTerms)}</p>` : ''}
    ${po.shippingTerms ? `<p><strong>Shipping Terms:</strong> ${escapeHtml(po.shippingTerms)}</p>` : ''}
    ${po.notes ? `<p><strong>Notes:</strong> ${escapeHtml(po.notes)}</p>` : ''}

    <p style="color:#737373;font-size:12px;margin-top:24px;">Generated by Arda</p>
  </div>
</body>
</html>`;
}

// ─── Email template for the auto-generated draft ─────────────────────

function generateEmailSubject(poNumber: string, supplierName: string): string {
  return `Purchase Order ${poNumber} — ${supplierName}`;
}

function generateEmailHtml(data: POPreviewData): string {
  const { po, lines, supplier, parts, supplierParts } = data;
  const currency = po.currency || 'USD';

  const linesHtml = lines.map((line) => {
    const part = parts.get(line.partId);
    const spn = supplierParts.get(line.partId);
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${line.lineNumber}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${escapeHtml(part?.partNumber || 'N/A')}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${escapeHtml(line.description || part?.name || '')}</td>
        ${spn ? `<td style="padding:8px;border-bottom:1px solid #e5e5e5;">${escapeHtml(spn)}</td>` : '<td style="padding:8px;border-bottom:1px solid #e5e5e5;">—</td>'}
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${line.quantityOrdered}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${currency} ${line.unitCost}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${currency} ${line.lineTotal}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'Open Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#0a0a0a;line-height:1.5;">
  <div style="max-width:700px;margin:0 auto;">
    <h2 style="color:#0a0a0a;margin-bottom:4px;">Purchase Order ${escapeHtml(po.poNumber)}</h2>
    <p style="color:#737373;margin-top:0;">Date: ${formatDate(po.orderDate) || formatDate(po.createdAt)}</p>

    <p>Dear ${escapeHtml(supplier.contactName || supplier.name)},</p>
    <p>Please find below the details for our purchase order. We kindly request confirmation of receipt and expected delivery timeline.</p>

    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5;">#</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5;">Part Number</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5;">Description</th>
          <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5;">Vendor SKU</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e5e5e5;">Qty</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e5e5e5;">Unit Cost</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #e5e5e5;">Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${linesHtml}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="6" style="padding:8px;text-align:right;font-weight:600;">Subtotal</td>
          <td style="padding:8px;text-align:right;">${currency} ${po.subtotal || '0.00'}</td>
        </tr>
        <tr>
          <td colspan="6" style="padding:8px;text-align:right;">Tax</td>
          <td style="padding:8px;text-align:right;">${currency} ${po.taxAmount || '0.00'}</td>
        </tr>
        <tr>
          <td colspan="6" style="padding:8px;text-align:right;">Shipping</td>
          <td style="padding:8px;text-align:right;">${currency} ${po.shippingAmount || '0.00'}</td>
        </tr>
        <tr style="font-weight:700;">
          <td colspan="6" style="padding:8px;text-align:right;border-top:2px solid #0a0a0a;">Total</td>
          <td style="padding:8px;text-align:right;border-top:2px solid #0a0a0a;">${currency} ${po.totalAmount || '0.00'}</td>
        </tr>
      </tfoot>
    </table>

    ${po.paymentTerms ? `<p><strong>Payment Terms:</strong> ${escapeHtml(po.paymentTerms)}</p>` : ''}
    ${po.shippingTerms ? `<p><strong>Shipping Terms:</strong> ${escapeHtml(po.shippingTerms)}</p>` : ''}
    ${po.notes ? `<p><strong>Notes:</strong> ${escapeHtml(po.notes)}</p>` : ''}

    <p>Thank you for your continued partnership.</p>
    <p style="color:#737373;font-size:12px;margin-top:24px;">This email was generated by Arda.</p>
  </div>
</body>
</html>`;
}

function generateEmailPlainText(data: POPreviewData): string {
  const { po, lines, supplier, parts, supplierParts } = data;
  const currency = po.currency || 'USD';

  const linesList = lines.map((line) => {
    const part = parts.get(line.partId);
    const spn = supplierParts.get(line.partId);
    return `  ${line.lineNumber}. ${part?.partNumber || 'N/A'} — ${line.description || part?.name || ''}` +
      (spn ? ` (Vendor SKU: ${spn})` : '') +
      `\n     Qty: ${line.quantityOrdered}  |  Unit Cost: ${currency} ${line.unitCost}  |  Total: ${currency} ${line.lineTotal}`;
  }).join('\n');

  let body = `Purchase Order ${po.poNumber}\nDate: ${formatDate(po.orderDate) || formatDate(po.createdAt)}\n\n`;
  body += `Dear ${supplier.contactName || supplier.name},\n\n`;
  body += `Please find below the details for our purchase order. We kindly request confirmation of receipt and expected delivery timeline.\n\n`;
  body += `ORDER ITEMS:\n${linesList}\n\n`;
  body += `Subtotal: ${currency} ${po.subtotal || '0.00'}\n`;
  body += `Tax: ${currency} ${po.taxAmount || '0.00'}\n`;
  body += `Shipping: ${currency} ${po.shippingAmount || '0.00'}\n`;
  body += `Total: ${currency} ${po.totalAmount || '0.00'}\n\n`;
  if (po.expectedDeliveryDate) body += `Expected Delivery: ${formatDate(po.expectedDeliveryDate)}\n`;
  if (po.paymentTerms) body += `Payment Terms: ${po.paymentTerms}\n`;
  if (po.shippingTerms) body += `Shipping Terms: ${po.shippingTerms}\n`;
  if (po.notes) body += `Notes: ${po.notes}\n`;
  body += '\nThank you for your continued partnership.\n';
  return body;
}

// ─── GET /po-workflow/:poId/preview ─────────────────────────────────

poWorkflowRouter.get('/:poId/preview', async (req: AuthRequest, res, next) => {
  try {
    const poId = z.string().uuid().parse(req.params.poId);
    const tenantId = req.user!.tenantId;

    const data = await fetchPOPreviewData(tenantId, poId);
    if (!data) {
      throw new AppError(404, 'Purchase order not found');
    }

    const previewHtml = generatePreviewHtml(data);
    const pdfData = buildPdfData(data);
    const pdfContent = buildPdfContent(pdfData);

    res.json({
      data: {
        poId: data.po.id,
        poNumber: data.po.poNumber,
        status: data.po.status,
        supplierName: data.supplier.name,
        supplierEmail: data.supplier.contactEmail,
        totalAmount: data.po.totalAmount,
        currency: data.po.currency || 'USD',
        lineCount: data.lines.length,
        previewHtml,
        pdfContent,
        canApprove: ['draft', 'pending_approval'].includes(data.po.status),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid PO ID'));
    }
    next(error);
  }
});

// ─── POST /po-workflow/:poId/approve ────────────────────────────────

const approveSchema = z.object({
  generateEmailDraft: z.boolean().default(true),
});

poWorkflowRouter.post('/:poId/approve', async (req: AuthRequest, res, next) => {
  try {
    const poId = z.string().uuid().parse(req.params.poId);
    const { generateEmailDraft } = approveSchema.parse(req.body ?? {});
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);

    const data = await fetchPOPreviewData(tenantId, poId);
    if (!data) {
      throw new AppError(404, 'Purchase order not found');
    }

    const { po } = data;

    // Only draft or pending_approval POs can be approved
    if (!['draft', 'pending_approval'].includes(po.status)) {
      throw new AppError(409, `Cannot approve purchase order in "${po.status}" status`);
    }

    const now = new Date();

    const result = await db.transaction(async (tx) => {
      // 1. Transition PO to approved
      const [updatedPO] = await tx
        .update(purchaseOrders)
        .set({
          status: 'approved',
          approvedByUserId: userId,
          approvedAt: now,
          updatedAt: now,
        })
        .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.tenantId, tenantId)))
        .returning();

      // 2. Audit the approval
      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'purchase_order.approved',
        entityType: 'purchase_order',
        entityId: poId,
        previousState: { status: po.status },
        newState: { status: 'approved', approvedByUserId: userId, approvedAt: now.toISOString() },
        metadata: {
          source: 'po-workflow.approve',
          orderNumber: po.poNumber,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      // 3. Auto-generate email draft if requested
      let draft = null;
      if (generateEmailDraft) {
        const subject = generateEmailSubject(po.poNumber, data.supplier.name);
        const htmlBody = generateEmailHtml(data);
        const textBody = generateEmailPlainText(data);
        const vendorEmail = data.supplier.contactEmail;
        const toRecipients = vendorEmail ? [vendorEmail] : [];

        const [created] = await tx
          .insert(emailDrafts)
          .values({
            tenantId,
            orderId: poId,
            orderType: 'purchase_order',
            status: 'draft',
            toRecipients,
            subject,
            htmlBody,
            textBody,
            generatedHtmlBody: htmlBody,
            createdByUserId: userId,
            metadata: {
              orderNumber: po.poNumber,
              supplierName: data.supplier.name,
              approvedAt: now.toISOString(),
              workflow: 'po-approve',
            },
          })
          .returning();

        await writeAuditEntry(tx, {
          tenantId,
          userId: auditContext.userId,
          action: 'email_draft.created',
          entityType: 'email_draft',
          entityId: created.id,
          newState: {
            orderId: poId,
            orderType: 'purchase_order',
            status: 'draft',
            toRecipients,
            subject,
          },
          metadata: {
            source: 'po-workflow.approve',
            orderNumber: po.poNumber,
            supplierName: data.supplier.name,
            triggeredBy: 'po_approval',
          },
          ipAddress: auditContext.ipAddress,
          userAgent: auditContext.userAgent,
        });

        draft = created;
      }

      return { updatedPO, draft };
    });

    // Publish events outside transaction
    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.status_changed',
        tenantId,
        orderType: 'purchase_order',
        orderId: poId,
        orderNumber: po.poNumber,
        fromStatus: po.status,
        toStatus: 'approved',
        timestamp: now.toISOString(),
      });

      if (result.draft) {
        await eventBus.publish({
          type: 'order.email_draft_created',
          tenantId,
          draftId: result.draft.id,
          orderId: poId,
          orderType: 'purchase_order',
          timestamp: now.toISOString(),
        });
      }
    } catch (err) {
      log.error({ err, poId }, 'Failed to publish PO approval events');
    }

    void publishKpiRefreshed({
      tenantId,
      mutationType: 'purchase_order.status_changed',
      facilityId: po.facilityId,
      source: 'orders',
      correlationId: getCorrelationId(),
    });

    res.json({
      data: {
        purchaseOrder: result.updatedPO,
        emailDraft: result.draft,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Validation error: ' + error.errors.map((e) => e.message).join(', ')));
    }
    next(error);
  }
});

// ─── GET /po-workflow/:poId/status ──────────────────────────────────

poWorkflowRouter.get('/:poId/status', async (req: AuthRequest, res, next) => {
  try {
    const poId = z.string().uuid().parse(req.params.poId);
    const tenantId = req.user!.tenantId;

    const [po] = await db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.tenantId, tenantId)))
      .limit(1);

    if (!po) {
      throw new AppError(404, 'Purchase order not found');
    }

    // Find the latest email draft for this PO
    const [latestDraft] = await db
      .select()
      .from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.orderId, poId),
          eq(emailDrafts.orderType, 'purchase_order'),
          eq(emailDrafts.tenantId, tenantId),
        )
      )
      .orderBy(desc(emailDrafts.createdAt))
      .limit(1);

    // Derive workflow step
    type WorkflowStep = 'draft' | 'pending_approval' | 'approved' | 'email_editing' | 'email_ready' | 'sending' | 'sent' | 'failed' | 'cancelled';
    let workflowStep: WorkflowStep;

    if (po.status === 'cancelled') {
      workflowStep = 'cancelled';
    } else if (po.status === 'sent') {
      workflowStep = 'sent';
    } else if (po.status === 'approved' && latestDraft) {
      if (latestDraft.status === 'sent') workflowStep = 'sent';
      else if (latestDraft.status === 'failed') workflowStep = 'failed';
      else if (latestDraft.status === 'sending') workflowStep = 'sending';
      else if (latestDraft.status === 'ready') workflowStep = 'email_ready';
      else workflowStep = 'email_editing';
    } else if (po.status === 'approved') {
      workflowStep = 'approved';
    } else if (po.status === 'pending_approval') {
      workflowStep = 'pending_approval';
    } else {
      workflowStep = 'draft';
    }

    const steps = [
      { step: 'draft', label: 'Draft', completed: po.status !== 'draft' && po.status !== 'cancelled' },
      { step: 'pending_approval', label: 'Pending Approval', completed: ['approved', 'sent', 'acknowledged', 'partially_received', 'received', 'closed'].includes(po.status) },
      { step: 'approved', label: 'Approved', completed: ['sent', 'acknowledged', 'partially_received', 'received', 'closed'].includes(po.status) || (po.status === 'approved' && !!latestDraft) },
      { step: 'email_editing', label: 'Email Editing', completed: latestDraft ? ['ready', 'sending', 'sent'].includes(latestDraft.status) : false },
      { step: 'email_ready', label: 'Ready to Send', completed: latestDraft ? ['sending', 'sent'].includes(latestDraft.status) : false },
      { step: 'sent', label: 'Sent', completed: po.status === 'sent' || latestDraft?.status === 'sent' },
    ];

    res.json({
      data: {
        poId: po.id,
        poNumber: po.poNumber,
        poStatus: po.status,
        workflowStep,
        approvedAt: po.approvedAt?.toISOString() || null,
        approvedByUserId: po.approvedByUserId || null,
        sentAt: po.sentAt?.toISOString() || null,
        sentToEmail: po.sentToEmail || null,
        emailDraft: latestDraft ? {
          id: latestDraft.id,
          status: latestDraft.status,
          toRecipients: latestDraft.toRecipients,
          subject: latestDraft.subject,
          sentAt: latestDraft.sentAt?.toISOString() || null,
          errorMessage: latestDraft.errorMessage || null,
        } : null,
        steps,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid PO ID'));
    }
    next(error);
  }
});
