import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import type { CardFormat, CardTemplateDefinition, CardTemplateElement } from '@arda/shared-types';
import { AppError } from '../middleware/error-handler.js';

export const cardTemplatesRouter = Router();
const { cardTemplates } = schema;

const CARD_TEMPLATE_REQUIRED_KEYS = [
  'title',
  'sku',
  'qr',
  'minimum',
  'location',
  'order',
  'supplier',
  'image',
  'notes',
  'top_line',
  'bottom_bar',
] as const;

const tokenSchema = z.enum([
  'title',
  'itemName',
  'sku',
  'partNumberText',
  'minimumText',
  'locationText',
  'orderText',
  'supplierText',
  'supplierNameText',
  'unitPriceText',
  'orderQuantityValue',
  'orderUnitsText',
  'minQuantityValue',
  'minUnitsText',
  'cardsCountText',
  'orderMethodText',
  'itemLocationText',
  'statusText',
  'updatedAtText',
  'glCodeText',
  'itemTypeText',
  'itemSubtypeText',
  'uomText',
  'facilityNameText',
  'sourceFacilityNameText',
  'storageLocationText',
  'scanUrlText',
  'notesText',
  'imageUrl',
  'qrCodeDataUrl',
]);

const styleSchema = z.object({
  fontFamily: z.string().max(100).optional(),
  fontSize: z.number().min(6).max(120).optional(),
  fontWeight: z.number().min(100).max(900).optional(),
  color: z.string().max(30).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  lineHeight: z.number().min(0.5).max(4).optional(),
  backgroundColor: z.string().max(30).optional(),
  borderColor: z.string().max(30).optional(),
  borderWidth: z.number().min(0).max(20).optional(),
  borderRadius: z.number().min(0).max(100).optional(),
  padding: z.number().min(0).max(100).optional(),
  opacity: z.number().min(0).max(1).optional(),
  strokeColor: z.string().max(30).optional(),
  strokeWidth: z.number().min(0).max(20).optional(),
}).optional();

const baseElementSchema = z.object({
  id: z.string().min(1).max(120),
  key: z.string().min(1).max(120).optional(),
  x: z.number().min(0),
  y: z.number().min(0),
  w: z.number().min(1),
  h: z.number().min(1),
  z: z.number().int().min(0).max(9999),
  rotation: z.number().min(-360).max(360).optional(),
  locked: z.boolean().optional(),
  style: styleSchema,
});

const elementSchema = z.discriminatedUnion('type', [
  baseElementSchema.extend({
    type: z.literal('bound_text'),
    token: tokenSchema,
    fallbackText: z.string().max(500).optional(),
  }),
  baseElementSchema.extend({
    type: z.literal('text'),
    text: z.string().max(5_000),
  }),
  baseElementSchema.extend({
    type: z.literal('image'),
    token: z.literal('imageUrl').optional(),
    src: z.string().url().optional(),
    fit: z.enum(['contain', 'cover']).optional(),
  }),
  baseElementSchema.extend({
    type: z.literal('qr'),
  }),
  baseElementSchema.extend({
    type: z.literal('icon'),
    iconName: z.enum(['minimum', 'location', 'order', 'supplier']),
    iconUrl: z.string().url().optional(),
  }),
  baseElementSchema.extend({
    type: z.literal('line'),
    orientation: z.enum(['horizontal', 'vertical']),
  }),
  baseElementSchema.extend({
    type: z.literal('rect'),
  }),
  baseElementSchema.extend({
    type: z.literal('notes_box'),
    token: z.literal('notesText').optional(),
  }),
  baseElementSchema.extend({
    type: z.literal('field_row_group'),
    iconName: z.enum(['minimum', 'location', 'order', 'supplier']),
    iconUrl: z.string().url().optional(),
    label: z.string().max(120),
    token: tokenSchema,
  }),
]);

const definitionSchema: z.ZodType<CardTemplateDefinition> = z.object({
  version: z.literal(1),
  canvas: z.object({
    width: z.number().int().positive().max(2_000),
    height: z.number().int().positive().max(2_000),
    background: z.string().max(30),
  }),
  grid: z.object({
    enabled: z.boolean(),
    size: z.number().int().min(2).max(200),
    snapThreshold: z.number().min(0).max(100),
  }),
  safeArea: z.object({
    top: z.number().min(0).max(500),
    right: z.number().min(0).max(500),
    bottom: z.number().min(0).max(500),
    left: z.number().min(0).max(500),
  }),
  requiredElementKeys: z.array(z.string().min(1).max(120)).min(1).max(200),
  elements: z.array(elementSchema).min(1).max(200),
});

const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  format: z.enum(['order_card_3x5_portrait']) as z.ZodType<CardFormat>,
  definition: definitionSchema,
  makeDefault: z.boolean().optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  definition: definitionSchema.optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const listTemplateSchema = z.object({
  format: z.enum(['order_card_3x5_portrait']).default('order_card_3x5_portrait'),
});

function validateDefinition(definition: CardTemplateDefinition): void {
  const requiredSet = new Set(definition.requiredElementKeys);
  for (const required of CARD_TEMPLATE_REQUIRED_KEYS) {
    if (!requiredSet.has(required)) {
      throw new AppError(400, `Missing requiredElementKeys entry: ${required}`);
    }
  }

  const presentKeys = new Set(
    definition.elements
      .map((element) => element.key)
      .filter((key): key is string => !!key),
  );

  for (const required of CARD_TEMPLATE_REQUIRED_KEYS) {
    if (!presentKeys.has(required)) {
      throw new AppError(400, `Missing required element key in elements[]: ${required}`);
    }
  }

  const maxX = definition.canvas.width - definition.safeArea.right;
  const maxY = definition.canvas.height - definition.safeArea.bottom;

  for (const element of definition.elements) {
    const left = element.x;
    const top = element.y;
    const right = element.x + element.w;
    const bottom = element.y + element.h;

    if (left < definition.safeArea.left || top < definition.safeArea.top || right > maxX || bottom > maxY) {
      throw new AppError(400, `Element ${element.id} is outside safe bounds`);
    }
  }
}

async function setDefaultTemplate(
  tenantId: string,
  templateId: string,
  format: CardFormat,
  updatedByUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(cardTemplates)
      .set({
        isDefault: false,
        updatedByUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cardTemplates.tenantId, tenantId),
          eq(cardTemplates.format, format),
          eq(cardTemplates.status, 'active'),
          eq(cardTemplates.isDefault, true),
          ne(cardTemplates.id, templateId),
        ),
      );

    const [updated] = await tx
      .update(cardTemplates)
      .set({
        isDefault: true,
        status: 'active',
        updatedByUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cardTemplates.id, templateId),
          eq(cardTemplates.tenantId, tenantId),
        ),
      )
      .returning();

    if (!updated) {
      throw new AppError(404, 'Template not found');
    }
  });
}

cardTemplatesRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const query = listTemplateSchema.parse(req.query);

    const rows = await db
      .select()
      .from(cardTemplates)
      .where(
        and(
          eq(cardTemplates.tenantId, tenantId),
          eq(cardTemplates.format, query.format),
          eq(cardTemplates.status, 'active'),
        ),
      )
      .orderBy(desc(cardTemplates.updatedAt));

    const currentDefaultId = rows.find((row) => row.isDefault)?.id ?? null;
    res.json({ data: rows, currentDefaultId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

cardTemplatesRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const input = createTemplateSchema.parse(req.body);
    validateDefinition(input.definition);

    let createdId: string | null = null;

    await db.transaction(async (tx) => {
      if (input.makeDefault) {
        await tx
          .update(cardTemplates)
          .set({
            isDefault: false,
            updatedByUserId: userId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(cardTemplates.tenantId, tenantId),
              eq(cardTemplates.format, input.format),
              eq(cardTemplates.status, 'active'),
              eq(cardTemplates.isDefault, true),
            ),
          );
      }

      const [created] = await tx
        .insert(cardTemplates)
        .values({
          tenantId,
          name: input.name,
          format: input.format,
          isDefault: input.makeDefault ?? false,
          status: 'active',
          definition: input.definition as unknown as Record<string, unknown>,
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .returning();

      createdId = created.id;
    });

    if (!createdId) {
      throw new AppError(500, 'Failed to create template');
    }

    const [created] = await db
      .select()
      .from(cardTemplates)
      .where(and(eq(cardTemplates.id, createdId), eq(cardTemplates.tenantId, tenantId)));

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

cardTemplatesRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const templateId = req.params.id as string;
    const input = updateTemplateSchema.parse(req.body);

    if (Object.keys(input).length === 0) {
      throw new AppError(400, 'No updates provided');
    }

    if (input.definition) {
      validateDefinition(input.definition);
    }

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedByUserId: userId,
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.status !== undefined) {
      updateData.status = input.status;
      if (input.status === 'archived') updateData.isDefault = false;
    }
    if (input.definition !== undefined) {
      updateData.definition = input.definition as unknown as Record<string, unknown>;
    }

    const [updated] = await db
      .update(cardTemplates)
      .set(updateData)
      .where(and(eq(cardTemplates.id, templateId), eq(cardTemplates.tenantId, tenantId)))
      .returning();

    if (!updated) {
      throw new AppError(404, 'Template not found');
    }

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

cardTemplatesRouter.post('/:id/set-default', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const templateId = req.params.id as string;

    const [row] = await db
      .select({ id: cardTemplates.id, format: cardTemplates.format })
      .from(cardTemplates)
      .where(and(eq(cardTemplates.id, templateId), eq(cardTemplates.tenantId, tenantId)));

    if (!row) {
      throw new AppError(404, 'Template not found');
    }

    await setDefaultTemplate(tenantId, templateId, row.format as CardFormat, userId);

    const [updated] = await db
      .select()
      .from(cardTemplates)
      .where(and(eq(cardTemplates.id, templateId), eq(cardTemplates.tenantId, tenantId)));

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

cardTemplatesRouter.post('/:id/clone', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const templateId = req.params.id as string;

    const [source] = await db
      .select()
      .from(cardTemplates)
      .where(and(eq(cardTemplates.id, templateId), eq(cardTemplates.tenantId, tenantId)));

    if (!source) {
      throw new AppError(404, 'Template not found');
    }

    const [created] = await db
      .insert(cardTemplates)
      .values({
        tenantId,
        name: `${source.name} (Copy)`,
        format: source.format,
        isDefault: false,
        status: 'active',
        definition: source.definition,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning();

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

cardTemplatesRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const templateId = req.params.id as string;

    const [updated] = await db
      .update(cardTemplates)
      .set({
        status: 'archived',
        isDefault: false,
        updatedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(cardTemplates.id, templateId), eq(cardTemplates.tenantId, tenantId)))
      .returning();

    if (!updated) {
      throw new AppError(404, 'Template not found');
    }

    res.json({ success: true, id: updated.id });
  } catch (err) {
    next(err);
  }
});

export function _validateTemplateDefinitionForTests(definition: CardTemplateDefinition): void {
  validateDefinition(definition);
}

export function _templateElementSchemaForTests(): z.ZodType<CardTemplateElement> {
  return elementSchema as unknown as z.ZodType<CardTemplateElement>;
}
