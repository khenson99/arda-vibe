import * as React from "react";
import { SidePanel } from "@/components/ui";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { ItemEditForm } from "./item-edit-form";
import { NotesEditor } from "./notes-editor";
import { CardLabelDesigner } from "./card-label-designer";
import { LoopManagementSection } from "./loop-management-section";
import type { AuthSession, PartRecord } from "@/types";

type TabId = "details" | "editor" | "loops";

interface ItemDetailPanelProps {
  open: boolean;
  mode: "create" | "edit";
  part: PartRecord | null;
  session: AuthSession;
  onUnauthorized: () => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function ItemDetailPanel({
  open,
  mode,
  part,
  session,
  onUnauthorized,
  onClose,
  onSaved,
}: ItemDetailPanelProps) {
  const [activeTab, setActiveTab] = React.useState<TabId>("details");
  const isCreateMode = mode === "create";

  // Reset tab when panel opens
  React.useEffect(() => {
    if (open) setActiveTab("details");
  }, [open]);

  const tabs: { id: TabId; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "editor", label: "Card Editor" },
    { id: "loops", label: "Loops & Cards" },
  ];

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={isCreateMode ? "Create Item" : (part?.name || part?.partNumber || "Item Detail")}
      subtitle={
        isCreateMode
          ? "Save to create the item and provision an initial card."
          : part?.partNumber
      }
      width="wide"
    >
      {!isCreateMode && (
        <div className="border-b border-border px-4">
          <Tabs>
            <TabsList className="w-full justify-start bg-transparent p-0">
              {tabs.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  active={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="rounded-none border-b-2 border-transparent px-4 py-2.5"
                  style={activeTab === tab.id ? { borderBottomColor: "hsl(var(--link))" } : undefined}
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      {(isCreateMode || activeTab === "details") && (
        <ItemEditForm
          mode={mode}
          part={part}
          session={session}
          onUnauthorized={onUnauthorized}
          onSaved={onSaved}
          onClose={onClose}
        />
      )}

      {!isCreateMode && activeTab === "editor" && part && (
        <div className="space-y-6 px-4 py-4">
          <NotesEditor
            part={part}
            session={session}
            onUnauthorized={onUnauthorized}
            onSaved={onSaved}
          />
          <div className="border-t border-border pt-4">
            <CardLabelDesigner
              part={part}
              token={session.tokens.accessToken}
              onUnauthorized={onUnauthorized}
            />
          </div>
        </div>
      )}

      {!isCreateMode && activeTab === "loops" && part && (
        <LoopManagementSection
          part={part}
          token={session.tokens.accessToken}
          onUnauthorized={onUnauthorized}
          onSaved={onSaved}
        />
      )}
    </SidePanel>
  );
}
