/**
 * Add Items FAB — Floating Action Button with popover menu.
 *
 * Fixed bottom-right, always visible on authenticated pages.
 * Opens a hierarchically prioritized menu of import methods.
 */

import * as React from "react";
import {
  Camera,
  FileSpreadsheet,
  Link2,
  Mail,
  Package,
  Plus,
  QrCode,
  ShieldCheck,
} from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ImportModuleId } from "./types";
import { useImportContext } from "./import-context";

/* ------------------------------------------------------------------ */
/*  Menu items — hierarchically prioritized                           */
/* ------------------------------------------------------------------ */

interface FabMenuItem {
  id: ImportModuleId;
  label: string;
  description: string;
  icon: React.ElementType;
}

const MENU_ITEMS: FabMenuItem[] = [
  {
    id: "email-scan",
    label: "Connect Email & Scan",
    description: "Automated bulk import from inbox",
    icon: Mail,
  },
  {
    id: "import-links",
    label: "Import Product Links",
    description: "Paste product URLs to scrape item details",
    icon: Link2,
  },
  {
    id: "upload-csv",
    label: "Upload CSV",
    description: "Import spreadsheet rows as products",
    icon: FileSpreadsheet,
  },
  {
    id: "vendor-discovery",
    label: "Vendor Product Search",
    description: "Browse & enrich from vendor catalogs",
    icon: Package,
  },
  {
    id: "scan-upcs",
    label: "Scan UPC Barcodes",
    description: "Phone-based barcode scanning",
    icon: QrCode,
  },
  {
    id: "ai-identify",
    label: "AI Photo Identify",
    description: "Upload photos for AI matching",
    icon: Camera,
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function AddItemsFab() {
  const { dispatch, pendingItemCount } = useImportContext();
  const [open, setOpen] = React.useState(false);

  const handleSelect = (moduleId: ImportModuleId) => {
    dispatch({ type: "OPEN_MODULE", module: moduleId });
    setOpen(false);
  };

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:bg-[hsl(var(--arda-orange-hover))] hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
              open && "rotate-45",
            )}
            aria-label="Add items"
          >
            <Plus className="h-6 w-6 transition-transform" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          side="top"
          align="end"
          sideOffset={12}
          className="w-80 p-0"
        >
          <div className="p-3 pb-2">
            <p className="text-sm font-semibold">Add Items</p>
            <p className="text-xs text-muted-foreground">
              Choose an import method to add products
            </p>
          </div>

          <div className="px-1 pb-1">
            {MENU_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelect(item.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--arda-blue)/0.1)]">
                    <Icon className="h-4 w-4 text-[hsl(var(--arda-blue))]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                </button>
              );
            })}
          </div>

          <Separator />

          {/* Review & Sync — always at bottom */}
          <div className="px-1 py-1">
            <button
              type="button"
              onClick={() => handleSelect("reconcile")}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--arda-success)/0.1)]">
                <ShieldCheck className="h-4 w-4 text-[hsl(var(--arda-success))]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Review & Sync</p>
                <p className="text-xs text-muted-foreground">
                  Reconcile and push to Arda
                </p>
              </div>
              {pendingItemCount > 0 && (
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                  {pendingItemCount}
                </span>
              )}
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
