import * as React from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  ArrowUpDown,
  BarChart3,
  Bell,
  Boxes,
  Building2,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  CreditCard,
  Filter,
  HardHat,
  Loader2,
  LogOut,
  Network,
  PackageCheck,
  Palette,
  QrCode,
  Repeat2,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  SquareKanban,
  TrendingUp,
  Wifi,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { Button, Input, Toaster } from '@/components/ui';
import { ImportContextProvider, AddItemsFab, ModuleDialog } from '@/components/order-pulse';
import { CommandPalette } from '@/components/command-palette';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useShopFloorMode } from '@/hooks/use-shop-floor-mode';
import { useWebSocket, WebSocketProvider, type ConnectionStatus } from '@/hooks/use-websocket';
import { cn } from '@/lib/utils';
import { ShopFloorDashboard } from '@/components/shop-floor/shop-floor-dashboard';
import type { AuthSession } from '@/types';

interface AppShellProps {
  session: AuthSession;
  onSignOut: () => void;
}

export interface HeaderOption {
  value: string;
  label: string;
}

export interface QueueHeaderControls {
  query: string;
  onQueryChange: (value: string) => void;
  queryPlaceholder?: string;
  scope: string;
  onScopeChange: (value: string) => void;
  scopeOptions: HeaderOption[];
  sortKey: string;
  onSortKeyChange: (value: string) => void;
  sortOptions: HeaderOption[];
}

/* ─── Connection Status Indicator ───────────────────────────────────  */

const STATUS_CONFIG: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: 'bg-emerald-500', label: 'Connected' },
  connecting: { color: 'bg-amber-500 animate-pulse', label: 'Connecting…' },
  reconnecting: { color: 'bg-amber-500 animate-pulse', label: 'Reconnecting…' },
  disconnected: { color: 'bg-red-500', label: 'Offline' },
};

function ConnectionIndicator() {
  const { status } = useWebSocket();
  const cfg = STATUS_CONFIG[status];

  return (
    <button
      type="button"
      className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50"
      title={cfg.label}
      aria-label={`Connection status: ${cfg.label}`}
    >
      {status === 'connected' ? (
        <Wifi className="h-4 w-4" />
      ) : (
        <WifiOff className="h-4 w-4" />
      )}
      <span
        className={cn('absolute right-1 top-1 h-1.5 w-1.5 rounded-full', cfg.color)}
      />
    </button>
  );
}

export interface AppShellOutletContext {
  setQueueHeaderControls: React.Dispatch<React.SetStateAction<QueueHeaderControls | null>>;
  setPageHeaderActions: React.Dispatch<React.SetStateAction<React.ReactNode>>;
}

/* ─── Nav section types ─────────────────────────────────────────────── */

interface NavItem {
  to: string;
  label: string;
  icon: React.ElementType;
}

interface NavSection {
  key: string;
  label: string;
  icon: React.ElementType;
  /** A single-page section (no sub-items). `to` is the route path. */
  to?: string;
  children?: NavItem[];
}

const STORAGE_KEY = 'arda:nav:collapsed';

function readCollapsedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCollapsedState(state: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota errors */
  }
}

/* ─── Section definitions (the required IA) ─────────────────────────  */

const NAV_SECTIONS: NavSection[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    icon: Activity,
    to: '/',
  },
  {
    key: 'inventory',
    label: 'Inventory',
    icon: Boxes,
    children: [
      { to: '/parts', label: 'Items', icon: Boxes },
      { to: '/inventory/cross-location', label: 'Network Inventory', icon: Network },
    ],
  },
  {
    key: 'orders',
    label: 'Orders',
    icon: ShoppingCart,
    children: [
      { to: '/queue', label: 'Order Queue', icon: SquareKanban },
      { to: '/orders', label: 'Order History', icon: ClipboardList },
    ],
  },
  {
    key: 'production',
    label: 'Production',
    icon: Wrench,
    children: [
      { to: '/cards', label: 'Cards', icon: CreditCard },
      { to: '/loops', label: 'Loops', icon: Repeat2 },
      { to: '/scan', label: 'Scan', icon: QrCode },
    ],
  },
  {
    key: 'receiving',
    label: 'Receiving',
    icon: PackageCheck,
    to: '/receiving',
  },
  {
    key: 'sales',
    label: 'Sales',
    icon: TrendingUp,
    to: '/sales',
  },
  {
    key: 'analytics',
    label: 'Analytics',
    icon: BarChart3,
    children: [
      { to: '/analytics', label: 'Dashboards', icon: BarChart3 },
      { to: '/admin/audit', label: 'Audit Trail', icon: ShieldCheck },
    ],
  },
  {
    key: 'my-business',
    label: 'My Business',
    icon: Building2,
    to: '/my-business',
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: Settings,
    children: [
      { to: '/settings', label: 'General', icon: Settings },
      { to: '/settings/colors', label: 'Color Coding', icon: Palette },
    ],
  },
];

/* ─── Collapsible Section Component ─────────────────────────────────  */

function SidebarSection({
  section,
  collapsed,
  onToggle,
  pathname,
}: {
  section: NavSection;
  collapsed: boolean;
  onToggle: () => void;
  pathname: string;
}) {
  const SectionIcon = section.icon;

  // single-page section (no sub-items)
  if (section.to && !section.children) {
    const isActive =
      section.to === '/'
        ? pathname === '/'
        : pathname === section.to || pathname.startsWith(`${section.to}/`);

    return (
      <NavLink
        to={section.to}
        end={section.to === '/'}
        className={cn('sidebar-nav-item', isActive && 'active')}
      >
        <SectionIcon className="h-4 w-4" />
        <span>{section.label}</span>
      </NavLink>
    );
  }

  // collapsible section with children
  const isChildActive = section.children?.some(
    (c) => pathname === c.to || pathname.startsWith(`${c.to}/`),
  );

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'sidebar-nav-item w-full justify-between',
          isChildActive && 'text-sidebar-active-foreground',
        )}
      >
        <span className="flex items-center gap-2">
          <SectionIcon className="h-4 w-4" />
          <span>{section.label}</span>
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-200',
            collapsed && '-rotate-90',
          )}
        />
      </button>

      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-in-out',
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-3 border-l border-sidebar-border/40 pl-2 pt-0.5">
            {section.children?.map((child) => {
              const ChildIcon = child.icon;
              return (
                <NavLink
                  key={child.to}
                  to={child.to}
                  end
                  className={({ isActive }) =>
                    cn(
                      'sidebar-nav-item text-[13px]',
                      isActive && 'active',
                    )
                  }
                >
                  <ChildIcon className="h-3.5 w-3.5" />
                  <span>{child.label}</span>
                </NavLink>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── AppShell ──────────────────────────────────────────────────────  */

function AppShellInner({ session, onSignOut }: AppShellProps) {
  const location = useLocation();
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);
  const [queueHeaderControls, setQueueHeaderControls] = React.useState<QueueHeaderControls | null>(
    null,
  );
  const [pageHeaderActions, setPageHeaderActions] = React.useState<React.ReactNode>(null);

  const { isShopFloorMode, toggleShopFloorMode } = useShopFloorMode();

  useKeyboardShortcuts({
    onFocusSearch: () => setCommandPaletteOpen(true),
  });

  // ── Collapsed state persisted to localStorage
  const [collapsedMap, setCollapsedMap] = React.useState<Record<string, boolean>>(() =>
    readCollapsedState(),
  );

  const toggleSection = React.useCallback((key: string) => {
    setCollapsedMap((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeCollapsedState(next);
      return next;
    });
  }, []);

  // Build flat list for mobile nav
  const flatNavItems = React.useMemo(() => {
    const items: NavItem[] = [];
    for (const s of NAV_SECTIONS) {
      if (s.to && !s.children) {
        items.push({ to: s.to, label: s.label, icon: s.icon });
      } else if (s.children) {
        for (const c of s.children) {
          items.push(c);
        }
      }
    }
    return items;
  }, []);

  return (
    <ImportContextProvider>
      {/* Shop Floor Mode: full-screen dashboard when on root */}
      {isShopFloorMode && location.pathname === '/' ? (
        <ShopFloorDashboard onExitShopFloor={toggleShopFloorMode} />
      ) : (
      <div className={cn(
        "app-shell-backdrop min-h-screen",
        !isShopFloorMode && "md:grid md:grid-cols-[228px_minmax(0,1fr)]"
      )}>
        {/* Hide sidebar in shop floor mode */}
        {!isShopFloorMode && (
        <aside className="hidden border-r border-sidebar-border/80 bg-[linear-gradient(165deg,hsl(var(--sidebar-background))_16%,#14171f_58%,#060709_100%)] md:flex md:flex-col">
          <div className="border-b border-sidebar-border/70 px-3 py-3">
            <div className="rounded-md border border-white/10 bg-gradient-to-b from-white/10 to-black/45 px-4 py-2 text-center">
              <h1 className="text-[38px] font-light leading-none tracking-tight text-white">
                Arda
              </h1>
            </div>
            <div className="mt-3 flex items-center gap-2 px-1">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-xs font-semibold text-white">
                {session.user.tenantName.slice(0, 1).toUpperCase()}
              </span>
              <p className="truncate text-sm font-semibold text-sidebar-foreground">
                {session.user.tenantName}
              </p>
            </div>
          </div>

          <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
            {NAV_SECTIONS.map((section) => (
              <SidebarSection
                key={section.key}
                section={section}
                collapsed={!!collapsedMap[section.key]}
                onToggle={() => toggleSection(section.key)}
                pathname={location.pathname}
              />
            ))}
          </nav>

          <div className="border-t border-sidebar-border/70 px-3 py-4 text-xs text-sidebar-muted">
            <p className="font-semibold text-sidebar-foreground">
              {session.user.firstName} {session.user.lastName}
            </p>
            <p className="mt-0.5">{session.user.role.replaceAll('_', ' ')}</p>
          </div>
        </aside>
        )}

        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-20 border-b border-border/70 bg-card/85 px-3 py-1.5 backdrop-blur-md md:px-4">
            <div className="flex items-center gap-2">
              {!queueHeaderControls && (
                <button
                  type="button"
                  onClick={() => setCommandPaletteOpen(true)}
                  className="relative hidden h-9 w-full max-w-[420px] items-center rounded-md border border-input bg-background px-3 text-sm text-muted-foreground md:flex"
                >
                  <Search className="mr-2 h-4 w-4 shrink-0" />
                  <span className="flex-1 text-left">Search...</span>
                  <kbd className="pointer-events-none ml-auto rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    ⌘K
                  </kbd>
                </button>
              )}

              <div className="ml-auto flex items-center gap-2">
                {!queueHeaderControls && pageHeaderActions && (
                  <div className="hidden items-center gap-1.5 md:flex">{pageHeaderActions}</div>
                )}
                <Button asChild variant="outline" size="sm">
                  <Link to="/scan">
                    <QrCode className="h-4 w-4" />
                    Scan
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-8 w-8',
                    isShopFloorMode ? 'text-primary' : 'text-muted-foreground',
                  )}
                  onClick={toggleShopFloorMode}
                  aria-label={
                    isShopFloorMode ? 'Disable shop floor mode' : 'Enable shop floor mode'
                  }
                  title={isShopFloorMode ? 'Shop floor mode: ON' : 'Shop floor mode: OFF'}
                >
                  <HardHat className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href="mailto:support@arda.app?subject=Arda%20Support%20Request">
                    <CircleHelp className="h-4 w-4" />
                    Support
                  </a>
                </Button>
                <ConnectionIndicator />
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative h-8 w-8 text-muted-foreground"
                >
                  <Bell className="h-4 w-4" />
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
                </Button>
                <Button variant="outline" size="sm" onClick={onSignOut}>
                  <LogOut className="h-4 w-4" />
                  <span className="hidden lg:inline">Sign out</span>
                </Button>
              </div>
            </div>

            {queueHeaderControls && (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-md border border-input bg-background">
                  <label className="flex h-8 items-center gap-1 border-r border-border px-2 text-xs text-muted-foreground">
                    <Filter className="h-3.5 w-3.5" />
                    <select
                      className="h-7 bg-transparent text-sm text-foreground outline-none"
                      value={queueHeaderControls.scope}
                      onChange={(event) => queueHeaderControls.onScopeChange(event.target.value)}
                    >
                      {queueHeaderControls.scopeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={queueHeaderControls.query}
                      onChange={(event) => queueHeaderControls.onQueryChange(event.target.value)}
                      placeholder={queueHeaderControls.queryPlaceholder ?? 'Search'}
                      className="h-8 border-0 bg-transparent pl-8 text-sm shadow-none focus-visible:ring-0"
                    />
                  </div>
                </div>

                <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    value={queueHeaderControls.sortKey}
                    onChange={(event) => queueHeaderControls.onSortKeyChange(event.target.value)}
                  >
                    {queueHeaderControls.sortOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 md:hidden">
              {flatNavItems.map((item) => {
                const ItemIcon = item.icon;
                const active =
                  item.to === '/'
                    ? location.pathname === '/'
                    : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);

                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold whitespace-nowrap',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-card text-foreground',
                    )}
                  >
                    <ItemIcon className="h-3.5 w-3.5" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </header>

          <main className="flex-1 p-2 md:p-3">
            <Outlet
              context={
                {
                  setQueueHeaderControls,
                  setPageHeaderActions,
                } satisfies AppShellOutletContext
              }
            />
          </main>
        </div>

        {/* Import system: FAB + dialog render on every authenticated page */}
        <AddItemsFab />
        <ModuleDialog />

        {/* Command palette (Cmd+K) + toast container */}
        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          isShopFloorMode={isShopFloorMode}
          onToggleShopFloorMode={toggleShopFloorMode}
        />
        <Toaster />
      </div>
      )}
    </ImportContextProvider>
  );
}

export function AppShell(props: AppShellProps) {
  return (
    <WebSocketProvider>
      <AppShellInner {...props} />
    </WebSocketProvider>
  );
}
