import * as React from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading2,
  Undo,
  Redo,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import {
  updateItemRecord,
  isUnauthorized,
  parseApiError,
  normalizeOptionalString,
} from "@/lib/api-client";
import type { AuthSession, PartRecord } from "@/types";

interface NotesEditorProps {
  part: PartRecord;
  session: AuthSession;
  onUnauthorized: () => void;
  onSaved: () => Promise<void>;
}

export function NotesEditor({
  part,
  session,
  onUnauthorized,
  onSaved,
}: NotesEditorProps) {
  const [isSaving, setIsSaving] = React.useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Placeholder.configure({
        placeholder: "Add notes about this item...",
      }),
    ],
    content: part.notes || "",
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none min-h-[200px] px-3 py-2 focus:outline-none [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_p]:text-sm [&_p]:leading-relaxed [&_ul]:text-sm [&_ol]:text-sm",
      },
    },
  });

  // Reset editor content when part changes
  React.useEffect(() => {
    if (editor && part.notes !== undefined) {
      const currentContent = editor.getHTML();
      const newContent = part.notes || "";
      if (currentContent !== newContent) {
        editor.commands.setContent(newContent);
      }
    }
  }, [editor, part.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = React.useCallback(async () => {
    if (!editor) return;

    const html = editor.getHTML();
    // tiptap returns <p></p> for empty content
    const notesValue = html === "<p></p>" ? null : html;

    const entityId = part.eId || part.externalGuid?.trim() || part.partNumber;
    const author =
      normalizeOptionalString(session.user.email) || session.user.id;

    setIsSaving(true);
    try {
      await updateItemRecord(session.tokens.accessToken, {
        entityId,
        tenantId: session.user.tenantId,
        author,
        payload: {
          externalGuid:
            normalizeOptionalString(part.externalGuid) || part.partNumber,
          name: part.name?.trim() || part.partNumber,
          orderMechanism:
            part.orderMechanism?.trim() || part.type?.trim() || "unspecified",
          location: normalizeOptionalString(part.location),
          minQty:
            typeof part.minQty === "number" && Number.isFinite(part.minQty)
              ? part.minQty
              : 0,
          minQtyUnit: part.minQtyUnit?.trim() || part.uom?.trim() || "each",
          orderQty:
            typeof part.orderQty === "number" && Number.isFinite(part.orderQty)
              ? part.orderQty
              : null,
          orderQtyUnit: normalizeOptionalString(
            part.orderQtyUnit ?? part.uom ?? null,
          ),
          primarySupplier:
            part.primarySupplier?.trim() || "Unknown supplier",
          primarySupplierLink: normalizeOptionalString(
            part.primarySupplierLink,
          ),
          imageUrl: normalizeOptionalString(part.imageUrl ?? null),
          notes: notesValue,
        },
      });
      toast.success("Notes saved.");
      await onSaved();
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      toast.error(parseApiError(error));
    } finally {
      setIsSaving(false);
    }
  }, [editor, onSaved, onUnauthorized, part, session]);

  if (!editor) return null;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Item Notes</h3>
        <p className="text-xs text-muted-foreground">
          Rich text notes are saved with the item record.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 rounded-t-md border border-border bg-muted/50 px-1.5 py-1">
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title="Bold"
        >
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title="Italic"
        >
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <ToolbarButton
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          isActive={editor.isActive("heading", { level: 2 })}
          title="Heading"
        >
          <Heading2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title="Bullet list"
        >
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title="Numbered list"
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>
        <div className="mx-1 h-4 w-px bg-border" />
        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          isActive={false}
          title="Undo"
        >
          <Undo className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          isActive={false}
          title="Redo"
        >
          <Redo className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>

      {/* Editor */}
      <div className="-mt-3 rounded-b-md border border-t-0 border-border bg-background">
        <EditorContent editor={editor} />
      </div>

      {/* Save */}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void handleSave()} disabled={isSaving}>
          {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save notes
        </Button>
      </div>
    </div>
  );
}

/* ── Toolbar button ─────────────────────────────────────────── */

function ToolbarButton({
  onClick,
  isActive,
  title,
  children,
}: {
  onClick: () => void;
  isActive: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded p-1.5 transition-colors ${
        isActive
          ? "bg-background text-foreground shadow-xs"
          : "text-muted-foreground hover:bg-background hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
