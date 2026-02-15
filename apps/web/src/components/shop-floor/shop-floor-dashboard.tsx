import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  PackageCheck,
  Factory,
  Boxes,
  BarChart3,
  ScanLine,
  ClipboardCheck,
  ArrowRightLeft,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

interface QuickAction {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  route: string;
  color: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "receiving",
    label: "Receive Materials",
    description: "Scan & verify incoming shipments",
    icon: PackageCheck,
    route: "/receiving",
    color: "hsl(142 71% 45%)",
  },
  {
    id: "production",
    label: "Production Queue",
    description: "View & update active jobs",
    icon: Factory,
    route: "/production",
    color: "hsl(221 83% 53%)",
  },
  {
    id: "inventory",
    label: "Check Inventory",
    description: "Look up stock levels",
    icon: Boxes,
    route: "/parts",
    color: "hsl(262 83% 58%)",
  },
  {
    id: "scan",
    label: "Scan Barcode",
    description: "Quick lookup by barcode / QR",
    icon: ScanLine,
    route: "/scan",
    color: "hsl(25 95% 53%)",
  },
  {
    id: "quality",
    label: "Quality Check",
    description: "Log inspection results",
    icon: ClipboardCheck,
    route: "/quality",
    color: "hsl(350 89% 60%)",
  },
  {
    id: "transfers",
    label: "Transfers",
    description: "Move items between locations",
    icon: ArrowRightLeft,
    route: "/transfers",
    color: "hsl(174 72% 40%)",
  },
];

interface ShopFloorDashboardProps {
  onExitShopFloor: () => void;
}

export function ShopFloorDashboard({ onExitShopFloor }: ShopFloorDashboardProps) {
  const navigate = useNavigate();
  const [currentTime, setCurrentTime] = React.useState(new Date());

  React.useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Compact Header */}
      <header className="flex items-center justify-between border-b bg-card px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Factory className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-lg font-bold leading-tight">Shop Floor</h1>
            <p className="text-xs text-muted-foreground">
              <Clock className="mr-1 inline-block h-3 w-3" />
              {currentTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {" · "}
              {currentTime.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onExitShopFloor}
          className="text-xs"
        >
          Exit Shop Floor
        </Button>
      </header>

      {/* Quick Actions Grid */}
      <main className="flex-1 p-4 sm:p-6">
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-3">
          {QUICK_ACTIONS.map((action) => {
            const ActionIcon = action.icon;
            return (
              <button
                key={action.id}
                onClick={() => navigate(action.route)}
                className={cn(
                  "group relative flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/50 bg-card",
                  "px-4 py-6 sm:py-8 text-center transition-all duration-200",
                  "hover:border-primary/30 hover:shadow-lg hover:-translate-y-0.5",
                  "focus:outline-none focus:ring-2 focus:ring-primary/50",
                  "active:scale-[0.97]",
                  "min-h-[120px] sm:min-h-[160px]" // Large touch targets
                )}
              >
                <div
                  className="flex h-12 w-12 items-center justify-center rounded-xl transition-transform group-hover:scale-110"
                  style={{ backgroundColor: `${action.color}20`, color: action.color }}
                >
                  <ActionIcon className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm font-semibold sm:text-base">{action.label}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground sm:text-xs">
                    {action.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Recent Activity */}
        <section className="mt-6">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <BarChart3 className="h-4 w-4" />
            Quick Stats
          </h2>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            {[
              { label: "Active Jobs", value: "—", color: "text-blue-500" },
              { label: "Pending Receipts", value: "—", color: "text-green-500" },
              { label: "Low Stock Items", value: "—", color: "text-orange-500" },
              { label: "Quality Alerts", value: "—", color: "text-red-500" },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border bg-card px-3 py-3 text-center"
              >
                <p className={cn("text-2xl font-bold", stat.color)}>{stat.value}</p>
                <p className="text-[11px] text-muted-foreground">{stat.label}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
