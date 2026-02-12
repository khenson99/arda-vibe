import * as React from 'react';
import { Download, Loader2, Printer } from 'lucide-react';
import type { CardFormat, CardTemplateDefinition, CardTemplateRecord } from '@arda/shared-types';
import { toast } from 'sonner';
import { Button, Input } from '@/components/ui';
import { CanvasSurface } from './canvas-surface';
import { ElementToolbox } from './element-toolbox';
import { InspectorPanel } from './inspector-panel';
import { TemplateToolbar } from './template-toolbar';
import { useHistoryState } from './history-store';
import { createDefaultCardTemplateDefinition } from './template-defaults';
import type { KanbanPrintData } from '../types';
import { FORMAT_CONFIGS } from '../types';
import { downloadCardsPdf } from '../print-pipeline';
import {
  ApiError,
  apiRequest,
  archiveCardTemplate,
  cloneCardTemplate,
  createCardTemplate,
  fetchCardTemplates,
  isUnauthorized,
  parseApiError,
  setDefaultCardTemplate,
  updateCardTemplate,
} from '@/lib/api-client';
import { printCardsFromIds } from '@/lib/kanban-printing';
import type { KanbanCard } from '@/types';

const TEMPLATE_FORMAT: CardFormat = 'order_card_3x5_portrait';
const LAST_TEMPLATE_STORAGE_KEY = 'card_template_designer:last_template_id';
const LAST_FORMAT_STORAGE_KEY = 'card_template_designer:last_format';
const CUSTOM_ICON_URLS_STORAGE_KEY = 'card_template_designer:custom_icon_urls';

const FORMAT_OPTIONS: CardFormat[] = ['order_card_3x5_portrait', '3x5_card', '4x6_card', 'business_card'];

interface OverrideDraft {
  title: string;
  sku: string;
  minimumText: string;
  locationText: string;
  orderText: string;
  supplierText: string;
  notesText: string;
  imageUrl: string;
}

function buildOverrides(data: KanbanPrintData): OverrideDraft {
  return {
    title: data.partDescription || data.partNumber,
    sku: data.sku || data.partNumber,
    minimumText: data.minimumText || '',
    locationText: data.locationText || '',
    orderText: data.orderText || '',
    supplierText: data.supplierText || '',
    notesText: data.notesText || '',
    imageUrl: data.imageUrl || '',
  };
}

function applyOverrides(data: KanbanPrintData, overrides: OverrideDraft): KanbanPrintData {
  return {
    ...data,
    partDescription: overrides.title,
    sku: overrides.sku,
    minimumText: overrides.minimumText,
    locationText: overrides.locationText,
    orderText: overrides.orderText,
    supplierText: overrides.supplierText,
    notesText: overrides.notesText,
    imageUrl: overrides.imageUrl,
  };
}

function isCardTemplateApiUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status !== 404) return false;
  const message = error.message.toLowerCase();
  return message.includes('cannot get /card-templates') || message.includes('not found');
}

function labelForFormat(format: CardFormat): string {
  switch (format) {
    case 'order_card_3x5_portrait':
      return '3x5 Portrait';
    case '3x5_card':
      return '3x5 Landscape';
    case '4x6_card':
      return '4x6 Landscape';
    case 'business_card':
      return 'Business Card';
    default:
      return format;
  }
}

function resizeDefinitionCanvas(definition: CardTemplateDefinition, width: number, height: number): CardTemplateDefinition {
  if (definition.canvas.width === width && definition.canvas.height === height) {
    return definition;
  }

  const scaleX = width / definition.canvas.width;
  const scaleY = height / definition.canvas.height;

  return {
    ...definition,
    canvas: {
      ...definition.canvas,
      width,
      height,
      background: '#ffffff',
    },
    safeArea: {
      top: Math.max(0, Math.round(definition.safeArea.top * scaleY)),
      right: Math.max(0, Math.round(definition.safeArea.right * scaleX)),
      bottom: Math.max(0, Math.round(definition.safeArea.bottom * scaleY)),
      left: Math.max(0, Math.round(definition.safeArea.left * scaleX)),
    },
    elements: definition.elements.map((element) => ({
      ...element,
      x: Math.max(0, Math.round(element.x * scaleX)),
      y: Math.max(0, Math.round(element.y * scaleY)),
      w: Math.max(1, Math.round(element.w * scaleX)),
      h: Math.max(1, Math.round(element.h * scaleY)),
    })),
  };
}

interface CardTemplateDesignerProps {
  token: string;
  partId: string;
  selectedCard: KanbanCard;
  basePrintData: KanbanPrintData;
  onUnauthorized: () => void;
  onSaved?: () => Promise<void>;
  onImageUrlSaved?: (url: string) => void;
}

export function CardTemplateDesigner({
  token,
  partId,
  selectedCard,
  basePrintData,
  onUnauthorized,
  onSaved,
  onImageUrlSaved,
}: CardTemplateDesignerProps) {
  const history = useHistoryState<CardTemplateDefinition>(createDefaultCardTemplateDefinition(), 100);
  const {
    value: definition,
    canUndo,
    canRedo,
    set: setDefinition,
    undo,
    redo,
    reset,
  } = history;

  const [templates, setTemplates] = React.useState<CardTemplateRecord[]>([]);
  const [currentDefaultId, setCurrentDefaultId] = React.useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string | null>(null);
  const [selectedElementId, setSelectedElementId] = React.useState<string | null>(null);
  const [templateName, setTemplateName] = React.useState('Default 3x5 Portrait');
  const [isLoadingTemplates, setIsLoadingTemplates] = React.useState(false);
  const [isSavingTemplate, setIsSavingTemplate] = React.useState(false);
  const [isPrinting, setIsPrinting] = React.useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = React.useState(false);
  const [isSavingImageUrl, setIsSavingImageUrl] = React.useState(false);
  const [templateApiAvailable, setTemplateApiAvailable] = React.useState(true);
  const [selectedFormat, setSelectedFormat] = React.useState<CardFormat>(() => {
    const stored = window.localStorage.getItem(LAST_FORMAT_STORAGE_KEY);
    if (stored && FORMAT_OPTIONS.includes(stored as CardFormat)) return stored as CardFormat;
    return TEMPLATE_FORMAT;
  });
  const [zoom, setZoom] = React.useState(2);
  const [customIconUrls, setCustomIconUrls] = React.useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(CUSTOM_ICON_URLS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
    } catch {
      return [];
    }
  });
  const [overrides, setOverrides] = React.useState<OverrideDraft>(() => buildOverrides(basePrintData));

  const previewData = React.useMemo(() => applyOverrides(basePrintData, overrides), [basePrintData, overrides]);

  const activeTemplate = React.useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );
  const hasShownTemplateApiFallback = React.useRef(false);

  React.useEffect(() => {
    setOverrides(buildOverrides(basePrintData));
  }, [basePrintData]);

  const applySelectedTemplate = React.useCallback((template: CardTemplateRecord | null) => {
    if (!template) {
      setSelectedTemplateId(null);
      setTemplateName('Default 3x5 Portrait');
      reset(createDefaultCardTemplateDefinition());
      setSelectedElementId(null);
      return;
    }

    setSelectedTemplateId(template.id);
    setTemplateName(template.name);
    reset({
      ...template.definition,
      canvas: {
        ...template.definition.canvas,
        background: '#ffffff',
      },
    });
    setSelectedElementId(null);
  }, [reset]);

  const loadTemplates = React.useCallback(async (preferredTemplateId?: string | null) => {
    setIsLoadingTemplates(true);
    try {
      const response = await fetchCardTemplates(token, TEMPLATE_FORMAT);
      setTemplateApiAvailable(true);
      setTemplates(response.data);
      setCurrentDefaultId(response.currentDefaultId);

      const storedTemplateId = window.localStorage.getItem(LAST_TEMPLATE_STORAGE_KEY);
      const pickId = preferredTemplateId ?? storedTemplateId ?? response.currentDefaultId ?? response.data[0]?.id ?? null;
      const selected = pickId
        ? response.data.find((template) => template.id === pickId) ?? null
        : null;

      applySelectedTemplate(selected);
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      if (isCardTemplateApiUnavailable(error)) {
        setTemplateApiAvailable(false);
        if (!hasShownTemplateApiFallback.current) {
          toast.warning('Template API is unavailable in this environment. Designer is running in local mode.');
          hasShownTemplateApiFallback.current = true;
        }
      } else {
        toast.error(parseApiError(error));
      }
      applySelectedTemplate(null);
    } finally {
      setIsLoadingTemplates(false);
    }
  }, [applySelectedTemplate, onUnauthorized, token]);

  React.useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  React.useEffect(() => {
    if (!selectedTemplateId) {
      window.localStorage.removeItem(LAST_TEMPLATE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(LAST_TEMPLATE_STORAGE_KEY, selectedTemplateId);
  }, [selectedTemplateId]);

  React.useEffect(() => {
    window.localStorage.setItem(LAST_FORMAT_STORAGE_KEY, selectedFormat);
  }, [selectedFormat]);

  React.useEffect(() => {
    window.localStorage.setItem(CUSTOM_ICON_URLS_STORAGE_KEY, JSON.stringify(customIconUrls));
  }, [customIconUrls]);

  React.useEffect(() => {
    const config = FORMAT_CONFIGS[selectedFormat];
    if (definition.canvas.width === config.widthPx && definition.canvas.height === config.heightPx) {
      return;
    }
    setDefinition(resizeDefinitionCanvas(definition, config.widthPx, config.heightPx));
  }, [definition, selectedFormat, setDefinition]);

  const handleAddElement = React.useCallback((factory: () => CardTemplateDefinition['elements'][number]) => {
    setDefinition({
      ...definition,
      elements: [...definition.elements, factory()],
    });
  }, [definition, setDefinition]);

  const handleSaveTemplate = React.useCallback(async () => {
    if (!templateApiAvailable) {
      toast.error('Template API is unavailable. You can still print with local unsaved edits.');
      return;
    }

    const name = templateName.trim();
    if (!name) {
      toast.error('Template name is required.');
      return;
    }

    setIsSavingTemplate(true);
    try {
      let savedId: string | null = null;
      if (selectedTemplateId) {
        const updated = await updateCardTemplate(token, selectedTemplateId, {
          name,
          definition,
        });
        savedId = updated.id;
      } else {
        const created = await createCardTemplate(token, {
          name,
          format: TEMPLATE_FORMAT,
          definition,
          makeDefault: templates.length === 0,
        });
        savedId = created.id;
      }

      await loadTemplates(savedId);
      toast.success('Template saved.');
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setIsSavingTemplate(false);
    }
  }, [definition, loadTemplates, onUnauthorized, selectedTemplateId, templateApiAvailable, templateName, templates.length, token]);

  const handleSetDefault = React.useCallback(async () => {
    if (!templateApiAvailable) {
      toast.error('Template API is unavailable in this environment.');
      return;
    }
    if (!selectedTemplateId) {
      toast.error('Save the template before setting it as default.');
      return;
    }

    try {
      await setDefaultCardTemplate(token, selectedTemplateId);
      await loadTemplates(selectedTemplateId);
      toast.success('Default template updated.');
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    }
  }, [loadTemplates, onUnauthorized, selectedTemplateId, templateApiAvailable, token]);

  const handleCloneTemplate = React.useCallback(async () => {
    if (!templateApiAvailable) {
      toast.error('Template API is unavailable in this environment.');
      return;
    }
    try {
      if (selectedTemplateId) {
        const clone = await cloneCardTemplate(token, selectedTemplateId);
        await loadTemplates(clone.id);
      } else {
        const created = await createCardTemplate(token, {
          name: `${templateName.trim() || 'Untitled'} (Copy)`,
          format: TEMPLATE_FORMAT,
          definition,
        });
        await loadTemplates(created.id);
      }
      toast.success('Template duplicated.');
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    }
  }, [definition, loadTemplates, onUnauthorized, selectedTemplateId, templateApiAvailable, templateName, token]);

  const handleArchiveTemplate = React.useCallback(async () => {
    if (!templateApiAvailable) {
      toast.error('Template API is unavailable in this environment.');
      return;
    }
    if (!selectedTemplateId) return;
    try {
      await archiveCardTemplate(token, selectedTemplateId);
      await loadTemplates();
      toast.success('Template archived.');
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    }
  }, [loadTemplates, onUnauthorized, selectedTemplateId, templateApiAvailable, token]);

  const handlePrint = React.useCallback(async () => {
    setIsPrinting(true);
    try {
      const result = await printCardsFromIds({
        token,
        cardIds: [selectedCard.id],
        format: selectedFormat,
        onUnauthorized,
        templateId: selectedTemplateId ?? undefined,
        templateDefinition: definition,
        overridesByCardId: {
          [selectedCard.id]: {
            partDescription: previewData.partDescription,
            sku: previewData.sku,
            minimumText: previewData.minimumText,
            locationText: previewData.locationText,
            orderText: previewData.orderText,
            supplierText: previewData.supplierText,
            notesText: previewData.notesText,
            imageUrl: previewData.imageUrl,
          },
        },
      });
      toast.success(`Print dialog opened for card #${selectedCard.cardNumber}`);
      if (result.auditError) {
        toast.warning(`Printed, but audit logging failed: ${result.auditError}`);
      }
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setIsPrinting(false);
    }
  }, [definition, onUnauthorized, previewData, selectedCard.cardNumber, selectedCard.id, selectedFormat, selectedTemplateId, token]);

  const handleDownloadPdf = React.useCallback(async () => {
    setIsDownloadingPdf(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadCardsPdf([previewData], selectedFormat, {
        templateDefinition: definition,
        filename: `card-${previewData.partNumber}-${stamp}.pdf`,
      });
      toast.success('PDF downloaded.');
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setIsDownloadingPdf(false);
    }
  }, [definition, previewData, selectedFormat]);

  const handleSaveImageUrl = React.useCallback(async () => {
    const normalized = overrides.imageUrl.trim();
    if (!normalized) {
      toast.error('Enter an image URL before saving.');
      return;
    }

    try {
      const parsed = new URL(normalized);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        toast.error('Image URL must start with http:// or https://');
        return;
      }
    } catch {
      toast.error('Image URL must be a valid URL.');
      return;
    }

    setIsSavingImageUrl(true);
    try {
      await apiRequest(`/api/catalog/parts/${encodeURIComponent(partId)}`, {
        method: 'PATCH',
        token,
        body: { imageUrl: normalized },
      });
      onImageUrlSaved?.(normalized);
      if (onSaved) await onSaved();
      toast.success('Item image URL updated.');
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setIsSavingImageUrl(false);
    }
  }, [onImageUrlSaved, onSaved, onUnauthorized, overrides.imageUrl, partId, token]);

  return (
    <div className="space-y-3">
      <TemplateToolbar
        templateName={templateName}
        onTemplateNameChange={setTemplateName}
        onNewTemplate={() => {
          setSelectedTemplateId(null);
          setTemplateName('Untitled Template');
          const base = createDefaultCardTemplateDefinition();
          const config = FORMAT_CONFIGS[selectedFormat];
          reset(resizeDefinitionCanvas(base, config.widthPx, config.heightPx));
          setSelectedElementId(null);
        }}
        onSaveTemplate={() => void handleSaveTemplate()}
        onCloneTemplate={() => void handleCloneTemplate()}
        onSetDefault={() => void handleSetDefault()}
        onResetSeed={() => {
          const base = createDefaultCardTemplateDefinition();
          const config = FORMAT_CONFIGS[selectedFormat];
          setDefinition(resizeDefinitionCanvas(base, config.widthPx, config.heightPx));
        }}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        isSaving={isSavingTemplate}
        hasSelectedTemplate={!!selectedTemplateId}
      />

      {!templateApiAvailable ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Template persistence is unavailable in this environment. You can still edit and print local templates.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
        <label className="text-xs font-medium text-muted-foreground">Card Size</label>
        <select
          className="h-9 min-w-[180px] rounded-md border border-input bg-background px-3 text-sm"
          value={selectedFormat}
          onChange={(event) => setSelectedFormat(event.target.value as CardFormat)}
        >
          {FORMAT_OPTIONS.map((format) => (
            <option key={format} value={format}>
              {labelForFormat(format)}
            </option>
          ))}
        </select>

        <label className="text-xs font-medium text-muted-foreground">Template</label>
        <select
          className="h-9 min-w-[260px] rounded-md border border-input bg-background px-3 text-sm"
          value={selectedTemplateId ?? ''}
          onChange={(event) => {
            const id = event.target.value || null;
            const found = id ? templates.find((template) => template.id === id) ?? null : null;
            applySelectedTemplate(found);
          }}
          disabled={isLoadingTemplates}
        >
          <option value="">Unsaved template</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
              {template.id === currentDefaultId ? ' (Default)' : ''}
            </option>
          ))}
        </select>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void loadTemplates(selectedTemplateId)}
          disabled={isLoadingTemplates || !templateApiAvailable}
        >
          Refresh
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleArchiveTemplate()}
          disabled={!selectedTemplateId || !templateApiAvailable}
        >
          Archive
        </Button>

        {activeTemplate ? (
          <span className="text-xs text-muted-foreground">
            Updated {new Date(activeTemplate.updatedAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 xl:grid-cols-[220px_minmax(0,1fr)_340px]">
        <div className="space-y-3">
          <ElementToolbox onAddElement={handleAddElement} />

          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="text-xs font-semibold text-muted-foreground">Print Overrides</div>
            <BoundField label="Title" value={overrides.title} onChange={(value) => setOverrides((prev) => ({ ...prev, title: value }))} />
            <BoundField label="SKU" value={overrides.sku} onChange={(value) => setOverrides((prev) => ({ ...prev, sku: value }))} />
            <BoundField label="Minimum" value={overrides.minimumText} onChange={(value) => setOverrides((prev) => ({ ...prev, minimumText: value }))} />
            <BoundField label="Location" value={overrides.locationText} onChange={(value) => setOverrides((prev) => ({ ...prev, locationText: value }))} />
            <BoundField label="Order" value={overrides.orderText} onChange={(value) => setOverrides((prev) => ({ ...prev, orderText: value }))} />
            <BoundField label="Supplier" value={overrides.supplierText} onChange={(value) => setOverrides((prev) => ({ ...prev, supplierText: value }))} />
            <label className="block space-y-1 text-xs">
              <span className="text-[11px] text-muted-foreground">Notes</span>
              <textarea
                value={overrides.notesText}
                onChange={(event) => setOverrides((prev) => ({ ...prev, notesText: event.target.value }))}
                className="min-h-[72px] w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
            </label>
            <BoundField label="Image URL" value={overrides.imageUrl} onChange={(value) => setOverrides((prev) => ({ ...prev, imageUrl: value }))} />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleSaveImageUrl()}
                disabled={isSavingImageUrl}
              >
                {isSavingImageUrl ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save image URL
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-end gap-2 rounded-md border border-border p-2">
            <label className="text-xs text-muted-foreground">Zoom</label>
            <input
              type="range"
              min={0.75}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="w-40"
            />
            <span className="w-12 text-right text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
            <Button type="button" size="sm" variant="outline" onClick={() => setZoom(2)}>
              Reset
            </Button>
          </div>
          <CanvasSurface
            definition={definition}
            data={previewData}
            selectedElementId={selectedElementId}
            onSelectElement={setSelectedElementId}
            onDefinitionChange={setDefinition}
            scale={zoom}
          />
        </div>

        <div className="space-y-3">
          <InspectorPanel
            definition={definition}
            selectedElementId={selectedElementId}
            onDefinitionChange={setDefinition}
            customIconUrls={customIconUrls}
            onCustomIconUrlsChange={setCustomIconUrls}
          />

          <div className="space-y-2 rounded-md border border-border p-3">
            <Button type="button" className="w-full" onClick={() => void handlePrint()} disabled={isPrinting}>
              {isPrinting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
              Print {labelForFormat(selectedFormat)}
            </Button>

            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => void handleDownloadPdf()}
              disabled={isDownloadingPdf}
            >
              {isDownloadingPdf ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Download PDF
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BoundField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
      <Input value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}
