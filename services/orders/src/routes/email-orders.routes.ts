import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest, AuditContext } from '@arda/auth-utils';
import { getEventBus } from '@arda/events';
import { config, createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';

const log = createLogger('email-orders');

export const emailOrdersRouter = Router();

const {
  emailDrafts,
  purchaseOrders,
  purchaseOrderLines,
  workOrders,
  transferOrders,
  transferOrderLines,
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

const orderTypeEnum = z.enum(['purchase_order', 'work_order', 'transfer_order']);

// ─── Email Template Generation ──────────────────────────────────────

interface OrderLineItem {
  lineNumber: number;
  partNumber: string;
  description: string;
  quantity: number;
  unitCost: string;
  lineTotal: string;
  supplierPartNumber?: string | null;
  notes?: string | null;
}

interface OrderEmailData {
  orderNumber: string;
  orderType: string;
  orderDate: string;
  supplierName: string;
  supplierContact?: string | null;
  facilityName?: string;
  lines: OrderLineItem[];
  subtotal: string;
  taxAmount: string;
  shippingAmount: string;
  totalAmount: string;
  currency: string;
  notes?: string | null;
  paymentTerms?: string | null;
  shippingTerms?: string | null;
  expectedDeliveryDate?: string | null;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateSubjectLine(data: OrderEmailData): string {
  return `Order ${data.orderNumber} — ${data.supplierName}`;
}

function generateEmailHtml(data: OrderEmailData): string {
  const linesHtml = data.lines
    .map(
      (line) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${line.lineNumber}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${escapeHtml(line.partNumber)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;">${escapeHtml(line.description)}</td>
        ${line.supplierPartNumber ? `<td style="padding:8px;border-bottom:1px solid #e5e5e5;">${escapeHtml(line.supplierPartNumber)}</td>` : '<td style="padding:8px;border-bottom:1px solid #e5e5e5;">—</td>'}
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${line.quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${data.currency} ${line.unitCost}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right;">${data.currency} ${line.lineTotal}</td>
      </tr>`
    )
    .join('');

  const deliveryLine = data.expectedDeliveryDate
    ? `<p><strong>Expected Delivery:</strong> ${data.expectedDeliveryDate}</p>`
    : '';
  const paymentLine = data.paymentTerms
    ? `<p><strong>Payment Terms:</strong> ${escapeHtml(data.paymentTerms)}</p>`
    : '';
  const shippingLine = data.shippingTerms
    ? `<p><strong>Shipping Terms:</strong> ${escapeHtml(data.shippingTerms)}</p>`
    : '';
  const notesLine = data.notes
    ? `<p><strong>Notes:</strong> ${escapeHtml(data.notes)}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'Open Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#0a0a0a;line-height:1.5;">
  <div style="max-width:700px;margin:0 auto;">
    <h2 style="color:#0a0a0a;margin-bottom:4px;">Order ${escapeHtml(data.orderNumber)}</h2>
    <p style="color:#737373;margin-top:0;">Date: ${data.orderDate}</p>

    <p>Dear ${escapeHtml(data.supplierContact || data.supplierName)},</p>
    <p>Please find below the details for our order. We kindly request confirmation of receipt and expected delivery timeline.</p>

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
          <td style="padding:8px;text-align:right;">${data.currency} ${data.subtotal}</td>
        </tr>
        <tr>
          <td colspan="6" style="padding:8px;text-align:right;">Tax</td>
          <td style="padding:8px;text-align:right;">${data.currency} ${data.taxAmount}</td>
        </tr>
        <tr>
          <td colspan="6" style="padding:8px;text-align:right;">Shipping</td>
          <td style="padding:8px;text-align:right;">${data.currency} ${data.shippingAmount}</td>
        </tr>
        <tr style="font-weight:700;">
          <td colspan="6" style="padding:8px;text-align:right;border-top:2px solid #0a0a0a;">Total</td>
          <td style="padding:8px;text-align:right;border-top:2px solid #0a0a0a;">${data.currency} ${data.totalAmount}</td>
        </tr>
      </tfoot>
    </table>

    ${deliveryLine}
    ${paymentLine}
    ${shippingLine}
    ${notesLine}

    <p>Thank you for your continued partnership.</p>
    <p style="color:#737373;font-size:12px;margin-top:24px;">This email was generated by Arda.</p>
  </div>
</body>
</html>`;
}

function generatePlainTextBody(data: OrderEmailData): string {
  const lines = data.lines
    .map(
      (line) =>
        `  ${line.lineNumber}. ${line.partNumber} — ${line.description}` +
        (line.supplierPartNumber ? ` (Vendor SKU: ${line.supplierPartNumber})` : '') +
        `\n     Qty: ${line.quantity}  |  Unit Cost: ${data.currency} ${line.unitCost}  |  Total: ${data.currency} ${line.lineTotal}` +
        (line.notes ? `\n     Notes: ${line.notes}` : '')
    )
    .join('\n');

  let body = `Order ${data.orderNumber}\nDate: ${data.orderDate}\n\n`;
  body += `Dear ${data.supplierContact || data.supplierName},\n\n`;
  body += `Please find below the details for our order. We kindly request confirmation of receipt and expected delivery timeline.\n\n`;
  body += `ORDER ITEMS:\n${lines}\n\n`;
  body += `Subtotal: ${data.currency} ${data.subtotal}\n`;
  body += `Tax: ${data.currency} ${data.taxAmount}\n`;
  body += `Shipping: ${data.currency} ${data.shippingAmount}\n`;
  body += `Total: ${data.currency} ${data.totalAmount}\n\n`;
  if (data.expectedDeliveryDate) body += `Expected Delivery: ${data.expectedDeliveryDate}\n`;
  if (data.paymentTerms) body += `Payment Terms: ${data.paymentTerms}\n`;
  if (data.shippingTerms) body += `Shipping Terms: ${data.shippingTerms}\n`;
  if (data.notes) body += `Notes: ${data.notes}\n`;
  body += '\nThank you for your continued partnership.\n';
  return body;
}

// ─── Validation Schemas ──────────────────────────────────────────────

const generateDraftSchema = z.object({
  orderId: z.string().uuid(),
  orderType: orderTypeEnum,
});

const updateDraftSchema = z.object({
  toRecipients: z.array(z.string().email()).min(1).optional(),
  ccRecipients: z.array(z.string().email()).optional(),
  bccRecipients: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500).optional(),
  htmlBody: z.string().min(1).optional(),
  textBody: z.string().optional(),
});

const listDraftsQuerySchema = z.object({
  orderId: z.string().uuid().optional(),
  orderType: orderTypeEnum.optional(),
  status: z.enum(['draft', 'editing', 'ready', 'sending', 'sent', 'failed']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// ─── POST /email-orders/generate ────────────────────────────────────
emailOrdersRouter.post('/generate', async (req: AuthRequest, res, next) => {
  try {
    const payload = generateDraftSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);

    const orderData = await fetchOrderData(tenantId, payload.orderId, payload.orderType);
    if (!orderData) {
      throw new AppError(404, `Order not found: ${payload.orderId}`);
    }

    const subject = generateSubjectLine(orderData);
    const htmlBody = generateEmailHtml(orderData);
    const textBody = generatePlainTextBody(orderData);
    const vendorEmail = orderData.supplierEmail;
    const toRecipients = vendorEmail ? [vendorEmail] : [];

    const [draft] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(emailDrafts)
        .values({
          tenantId,
          orderId: payload.orderId,
          orderType: payload.orderType,
          status: 'draft',
          toRecipients,
          subject,
          htmlBody,
          textBody,
          generatedHtmlBody: htmlBody,
          createdByUserId: userId,
          metadata: {
            orderNumber: orderData.orderNumber,
            supplierName: orderData.supplierName,
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
          orderId: payload.orderId,
          orderType: payload.orderType,
          status: 'draft',
          toRecipients,
          subject,
        },
        metadata: {
          source: 'email-orders.generate',
          orderNumber: orderData.orderNumber,
          supplierName: orderData.supplierName,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return [created];
    });

    try {
      const eventBus = getEventBus(config.REDIS_URL);
      await eventBus.publish({
        type: 'order.email_draft_created',
        tenantId,
        draftId: draft.id,
        orderId: payload.orderId,
        orderType: payload.orderType,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err, draftId: draft.id }, 'Failed to publish email draft created event');
    }

    res.status(201).json({ data: draft });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Validation error: ' + error.errors.map((e) => e.message).join(', ')));
    }
    next(error);
  }
});

// ─── GET /email-orders ──────────────────────────────────────────────
emailOrdersRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = listDraftsQuerySchema.parse(req.query);
    const tenantId = req.user!.tenantId;
    const offset = (query.page - 1) * query.limit;

    const conditions = [eq(emailDrafts.tenantId, tenantId)];
    if (query.orderId) conditions.push(eq(emailDrafts.orderId, query.orderId));
    if (query.orderType) conditions.push(eq(emailDrafts.orderType, query.orderType));
    if (query.status) conditions.push(eq(emailDrafts.status, query.status));

    const rows = await db
      .select()
      .from(emailDrafts)
      .where(and(...conditions))
      .orderBy(desc(emailDrafts.createdAt))
      .limit(query.limit)
      .offset(offset);

    res.json({ data: rows, page: query.page, limit: query.limit });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Validation error'));
    }
    next(error);
  }
});

// ─── GET /email-orders/:draftId ─────────────────────────────────────
emailOrdersRouter.get('/:draftId', async (req: AuthRequest, res, next) => {
  try {
    const draftId = z.string().uuid().parse(req.params.draftId);
    const tenantId = req.user!.tenantId;

    const [draft] = await db
      .select()
      .from(emailDrafts)
      .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.tenantId, tenantId)))
      .limit(1);

    if (!draft) {
      throw new AppError(404, 'Email draft not found');
    }

    res.json({ data: draft });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid draft ID'));
    }
    next(error);
  }
});

// ─── PUT /email-orders/:draftId ─────────────────────────────────────
emailOrdersRouter.put('/:draftId', async (req: AuthRequest, res, next) => {
  try {
    const draftId = z.string().uuid().parse(req.params.draftId);
    const updates = updateDraftSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const [updated] = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(emailDrafts)
        .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        throw new AppError(404, 'Email draft not found');
      }

      if (existing.status === 'sent' || existing.status === 'sending') {
        throw new AppError(409, `Cannot edit a draft in "${existing.status}" status`);
      }

      const setValues: Record<string, unknown> = {
        updatedAt: new Date(),
        status: 'editing',
      };
      if (updates.toRecipients !== undefined) setValues.toRecipients = updates.toRecipients;
      if (updates.ccRecipients !== undefined) setValues.ccRecipients = updates.ccRecipients;
      if (updates.bccRecipients !== undefined) setValues.bccRecipients = updates.bccRecipients;
      if (updates.subject !== undefined) setValues.subject = updates.subject;
      if (updates.htmlBody !== undefined) setValues.htmlBody = updates.htmlBody;
      if (updates.textBody !== undefined) setValues.textBody = updates.textBody;

      const [result] = await tx
        .update(emailDrafts)
        .set(setValues)
        .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.tenantId, tenantId)))
        .returning();

      const changedFields: Record<string, unknown> = {};
      const previousFields: Record<string, unknown> = {};
      for (const key of Object.keys(updates) as Array<keyof typeof updates>) {
        if (updates[key] !== undefined) {
          changedFields[key] = updates[key];
          previousFields[key] = existing[key as keyof typeof existing];
        }
      }

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'email_draft.updated',
        entityType: 'email_draft',
        entityId: draftId,
        previousState: previousFields,
        newState: changedFields,
        metadata: { source: 'email-orders.update' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return [result];
    });

    res.json({ data: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Validation error: ' + error.errors.map((e) => e.message).join(', ')));
    }
    next(error);
  }
});

// ─── POST /email-orders/:draftId/ready ──────────────────────────────
emailOrdersRouter.post('/:draftId/ready', async (req: AuthRequest, res, next) => {
  try {
    const draftId = z.string().uuid().parse(req.params.draftId);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const [updated] = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(emailDrafts)
        .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        throw new AppError(404, 'Email draft not found');
      }

      if (existing.status === 'sent' || existing.status === 'sending') {
        throw new AppError(409, `Cannot mark draft as ready in "${existing.status}" status`);
      }

      if (!existing.toRecipients || (existing.toRecipients as string[]).length === 0) {
        throw new AppError(400, 'Draft must have at least one recipient before marking as ready');
      }

      const [result] = await tx
        .update(emailDrafts)
        .set({ status: 'ready', updatedAt: new Date() })
        .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'email_draft.marked_ready',
        entityType: 'email_draft',
        entityId: draftId,
        previousState: { status: existing.status },
        newState: { status: 'ready' },
        metadata: { source: 'email-orders.ready' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return [result];
    });

    res.json({ data: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid draft ID'));
    }
    next(error);
  }
});

// ─── POST /email-orders/:draftId/send ───────────────────────────────
emailOrdersRouter.post('/:draftId/send', async (req: AuthRequest, res, next) => {
  try {
    const draftId = z.string().uuid().parse(req.params.draftId);
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const auditContext = getRequestAuditContext(req);

    const [draft] = await db
      .select()
      .from(emailDrafts)
      .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.tenantId, tenantId)))
      .limit(1);

    if (!draft) {
      throw new AppError(404, 'Email draft not found');
    }

    if (draft.status === 'sent') {
      throw new AppError(409, 'Email has already been sent');
    }

    if (draft.status === 'sending') {
      throw new AppError(409, 'Email is currently being sent');
    }

    const recipients = draft.toRecipients as string[];
    if (!recipients || recipients.length === 0) {
      throw new AppError(400, 'Draft must have at least one recipient');
    }

    // Mark as sending
    await db
      .update(emailDrafts)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(eq(emailDrafts.id, draftId));

    try {
      const notificationsUrl = config.NOTIFICATIONS_SERVICE_URL || `http://localhost:${config.NOTIFICATIONS_SERVICE_PORT || 3004}`;
      const gmailResponse = await fetch(`${notificationsUrl}/gmail/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: req.headers.authorization || '',
          'x-tenant-id': tenantId,
        },
        body: JSON.stringify({
          to: recipients,
          cc: (draft.ccRecipients as string[]) || [],
          bcc: (draft.bccRecipients as string[]) || [],
          subject: draft.subject,
          htmlBody: draft.htmlBody,
          textBody: draft.textBody || undefined,
        }),
      });

      if (!gmailResponse.ok) {
        const errorBody = await gmailResponse.text();
        log.error({ status: gmailResponse.status, body: errorBody, draftId }, 'Gmail send failed');

        await db
          .update(emailDrafts)
          .set({
            status: 'failed',
            errorMessage: `Gmail API error: ${gmailResponse.status} — ${errorBody.slice(0, 500)}`,
            updatedAt: new Date(),
          })
          .where(eq(emailDrafts.id, draftId));

        throw new AppError(502, 'Failed to send email via Gmail');
      }

      const gmailResult = await gmailResponse.json() as {
        sent?: boolean;
        messageId?: string;
        threadId?: string;
      };

      const now = new Date();
      const [sentDraft] = await db.transaction(async (tx) => {
        const [result] = await tx
          .update(emailDrafts)
          .set({
            status: 'sent',
            gmailMessageId: gmailResult.messageId || null,
            gmailThreadId: gmailResult.threadId || null,
            sentAt: now,
            sentByUserId: userId,
            errorMessage: null,
            updatedAt: now,
          })
          .where(eq(emailDrafts.id, draftId))
          .returning();

        if (draft.orderType === 'purchase_order') {
          await tx
            .update(purchaseOrders)
            .set({
              sentAt: now,
              sentToEmail: recipients[0],
              status: 'sent',
              updatedAt: now,
            })
            .where(
              and(
                eq(purchaseOrders.id, draft.orderId),
                eq(purchaseOrders.tenantId, tenantId)
              )
            );
        }

        await writeAuditEntry(tx, {
          tenantId,
          userId: auditContext.userId,
          action: 'email_draft.sent',
          entityType: 'email_draft',
          entityId: draftId,
          previousState: { status: 'sending' },
          newState: {
            status: 'sent',
            gmailMessageId: gmailResult.messageId,
            sentAt: now.toISOString(),
            recipients,
          },
          metadata: {
            source: 'email-orders.send',
            orderId: draft.orderId,
            orderType: draft.orderType,
          },
          ipAddress: auditContext.ipAddress,
          userAgent: auditContext.userAgent,
        });

        return [result];
      });

      try {
        const eventBus = getEventBus(config.REDIS_URL);
        await eventBus.publish({
          type: 'order.email_sent',
          tenantId,
          draftId,
          orderId: draft.orderId,
          orderType: draft.orderType as 'purchase_order' | 'work_order' | 'transfer_order',
          gmailMessageId: gmailResult.messageId || '',
          timestamp: now.toISOString(),
        });
      } catch (err) {
        log.error({ err, draftId }, 'Failed to publish email sent event');
      }

      res.json({ data: sentDraft });
    } catch (sendError) {
      if (sendError instanceof AppError) throw sendError;

      const errorMsg = sendError instanceof Error ? sendError.message : 'Unknown send error';
      log.error({ err: sendError, draftId }, 'Email send failed unexpectedly');

      await db
        .update(emailDrafts)
        .set({
          status: 'failed',
          errorMessage: errorMsg.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(emailDrafts.id, draftId));

      throw new AppError(502, 'Failed to send email');
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid draft ID'));
    }
    next(error);
  }
});

// ─── POST /email-orders/:draftId/reset ──────────────────────────────
emailOrdersRouter.post('/:draftId/reset', async (req: AuthRequest, res, next) => {
  try {
    const draftId = z.string().uuid().parse(req.params.draftId);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const [updated] = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(emailDrafts)
        .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        throw new AppError(404, 'Email draft not found');
      }

      if (existing.status === 'sent' || existing.status === 'sending') {
        throw new AppError(409, `Cannot reset a draft in "${existing.status}" status`);
      }

      if (!existing.generatedHtmlBody) {
        throw new AppError(400, 'No generated body available to reset to');
      }

      const [result] = await tx
        .update(emailDrafts)
        .set({
          htmlBody: existing.generatedHtmlBody,
          status: 'draft',
          updatedAt: new Date(),
        })
        .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'email_draft.reset',
        entityType: 'email_draft',
        entityId: draftId,
        previousState: { status: existing.status },
        newState: { status: 'draft', bodyReset: true },
        metadata: { source: 'email-orders.reset' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return [result];
    });

    res.json({ data: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid draft ID'));
    }
    next(error);
  }
});

// ─── Data Fetching ──────────────────────────────────────────────────

interface FetchedOrderData extends OrderEmailData {
  supplierEmail?: string | null;
}

async function fetchOrderData(
  tenantId: string,
  orderId: string,
  orderType: string
): Promise<FetchedOrderData | null> {
  if (orderType === 'purchase_order') {
    return fetchPurchaseOrderData(tenantId, orderId);
  }
  if (orderType === 'work_order') {
    return fetchWorkOrderData(tenantId, orderId);
  }
  if (orderType === 'transfer_order') {
    return fetchTransferOrderData(tenantId, orderId);
  }
  return null;
}

async function fetchPurchaseOrderData(
  tenantId: string,
  orderId: string
): Promise<FetchedOrderData | null> {
  const [order] = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.tenantId, tenantId)))
    .limit(1);

  if (!order) return null;

  const lines = await db
    .select({
      lineNumber: purchaseOrderLines.lineNumber,
      quantityOrdered: purchaseOrderLines.quantityOrdered,
      unitCost: purchaseOrderLines.unitCost,
      lineTotal: purchaseOrderLines.lineTotal,
      notes: purchaseOrderLines.notes,
      description: purchaseOrderLines.description,
      partId: purchaseOrderLines.partId,
    })
    .from(purchaseOrderLines)
    .where(
      and(
        eq(purchaseOrderLines.purchaseOrderId, orderId),
        eq(purchaseOrderLines.tenantId, tenantId)
      )
    );

  const [supplier] = await db
    .select()
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, order.supplierId))
    .limit(1);

  const partIds = lines.map((l) => l.partId);
  const parts = partIds.length > 0
    ? await db
        .select({
          id: schema.parts.id,
          partNumber: schema.parts.partNumber,
          name: schema.parts.name,
        })
        .from(schema.parts)
        .where(inArray(schema.parts.id, partIds))
    : [];

  const supplierParts = partIds.length > 0 && supplier
    ? await db
        .select({
          partId: schema.supplierParts.partId,
          supplierPartNumber: schema.supplierParts.supplierPartNumber,
        })
        .from(schema.supplierParts)
        .where(
          and(
            eq(schema.supplierParts.supplierId, supplier.id),
            eq(schema.supplierParts.tenantId, tenantId)
          )
        )
    : [];

  const partMap = new Map(parts.map((p) => [p.id, p]));
  const supplierPartMap = new Map(supplierParts.map((sp) => [sp.partId, sp.supplierPartNumber]));

  const orderLines: OrderLineItem[] = lines.map((line) => {
    const part = partMap.get(line.partId);
    return {
      lineNumber: line.lineNumber,
      partNumber: part?.partNumber || 'N/A',
      description: line.description || part?.name || '',
      quantity: line.quantityOrdered,
      unitCost: line.unitCost,
      lineTotal: line.lineTotal,
      supplierPartNumber: supplierPartMap.get(line.partId) || null,
      notes: line.notes,
    };
  });

  const formatDate = (d: Date | null | undefined) =>
    d ? d.toISOString().split('T')[0] : '';

  return {
    orderNumber: order.poNumber,
    orderType: 'purchase_order',
    orderDate: formatDate(order.orderDate) || formatDate(order.createdAt),
    supplierName: supplier?.name || 'Unknown Vendor',
    supplierContact: supplier?.contactName,
    supplierEmail: supplier?.contactEmail,
    lines: orderLines,
    subtotal: order.subtotal || '0.00',
    taxAmount: order.taxAmount || '0.00',
    shippingAmount: order.shippingAmount || '0.00',
    totalAmount: order.totalAmount || '0.00',
    currency: order.currency || 'USD',
    notes: order.notes,
    paymentTerms: order.paymentTerms,
    shippingTerms: order.shippingTerms,
    expectedDeliveryDate: formatDate(order.expectedDeliveryDate),
  };
}

async function fetchWorkOrderData(
  tenantId: string,
  orderId: string
): Promise<FetchedOrderData | null> {
  const [order] = await db
    .select()
    .from(workOrders)
    .where(and(eq(workOrders.id, orderId), eq(workOrders.tenantId, tenantId)))
    .limit(1);

  if (!order) return null;

  const [part] = await db
    .select({
      partNumber: schema.parts.partNumber,
      name: schema.parts.name,
    })
    .from(schema.parts)
    .where(eq(schema.parts.id, order.partId))
    .limit(1);

  return {
    orderNumber: order.woNumber,
    orderType: 'work_order',
    orderDate: order.createdAt.toISOString().split('T')[0],
    supplierName: 'Internal Production',
    lines: [
      {
        lineNumber: 1,
        partNumber: part?.partNumber || 'N/A',
        description: part?.name || '',
        quantity: order.quantityToProduce,
        unitCost: '0.00',
        lineTotal: '0.00',
      },
    ],
    subtotal: '0.00',
    taxAmount: '0.00',
    shippingAmount: '0.00',
    totalAmount: '0.00',
    currency: 'USD',
    supplierEmail: null,
  };
}

async function fetchTransferOrderData(
  tenantId: string,
  orderId: string
): Promise<FetchedOrderData | null> {
  const [order] = await db
    .select()
    .from(transferOrders)
    .where(and(eq(transferOrders.id, orderId), eq(transferOrders.tenantId, tenantId)))
    .limit(1);

  if (!order) return null;

  const lines = await db
    .select({
      partId: transferOrderLines.partId,
      quantityRequested: transferOrderLines.quantityRequested,
    })
    .from(transferOrderLines)
    .where(
      and(
        eq(transferOrderLines.transferOrderId, orderId),
        eq(transferOrderLines.tenantId, tenantId)
      )
    );

  const partIds = lines.map((l) => l.partId);
  const parts = partIds.length > 0
    ? await db
        .select({
          id: schema.parts.id,
          partNumber: schema.parts.partNumber,
          name: schema.parts.name,
        })
        .from(schema.parts)
        .where(inArray(schema.parts.id, partIds))
    : [];

  const partMap = new Map(parts.map((p) => [p.id, p]));

  const orderLines: OrderLineItem[] = lines.map((line, idx) => {
    const part = partMap.get(line.partId);
    return {
      lineNumber: idx + 1,
      partNumber: part?.partNumber || 'N/A',
      description: part?.name || '',
      quantity: line.quantityRequested,
      unitCost: '0.00',
      lineTotal: '0.00',
    };
  });

  return {
    orderNumber: order.toNumber,
    orderType: 'transfer_order',
    orderDate: order.createdAt.toISOString().split('T')[0],
    supplierName: 'Internal Transfer',
    lines: orderLines,
    subtotal: '0.00',
    taxAmount: '0.00',
    shippingAmount: '0.00',
    totalAmount: '0.00',
    currency: 'USD',
    supplierEmail: null,
  };
}
