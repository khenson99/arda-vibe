import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  Bell,
  Boxes,
  HardHat,
  QrCode,
  RefreshCw,
  SquareKanban,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";

/* ── Types ──────────────────────────────────────────────── */

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isShopFloorMode: boolean;
  onToggleShopFloorMode: () => void;
}

/* ── Static data ────────────────────────────────────────── */

const PAGE_ITEMS = [
  { to: "/", label: "Dashboard", icon: Activity },
  { to: "/parts", label: "Items", icon: Boxes },
  { to: "/queue", label: "Order Queue", icon: SquareKanban },
  { to: "/notifications", label: "Order History", icon: Bell },
  { to: "/scan", label: "Receiving", icon: QrCode },
] as const;

/* ── Component ──────────────────────────────────────────── */

export function CommandPalette({
  open,
  onOpenChange,
  isShopFloorMode,
  onToggleShopFloorMode,
}: CommandPaletteProps) {
  const navigate = useNavigate();

  const runAction = React.useCallback(
    (action: () => void) => {
      onOpenChange(false);
      // Defer action to next frame so the dialog exit animation starts
      // before a route change potentially unmounts the current tree.
      requestAnimationFrame(action);
    },
    [onOpenChange],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Pages">
          {PAGE_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.to}
                value={item.label}
                onSelect={() => runAction(() => navigate(item.to))}
              >
                <Icon className="mr-2 h-4 w-4" />
                <span>{item.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Quick Actions">
          <CommandItem
            value="Refresh data"
            onSelect={() => runAction(() => window.location.reload())}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            <span>Refresh data</span>
            <CommandShortcut>R</CommandShortcut>
          </CommandItem>

          <CommandItem
            value={isShopFloorMode ? "Disable shop floor mode" : "Enable shop floor mode"}
            onSelect={() => runAction(onToggleShopFloorMode)}
          >
            <HardHat className="mr-2 h-4 w-4" />
            <span>
              {isShopFloorMode ? "Disable shop floor mode" : "Enable shop floor mode"}
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
