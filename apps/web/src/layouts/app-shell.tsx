import * as React from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  ArrowUpDown,
  Bell,
  Boxes,
  CircleHelp,
  ClipboardList,
  CreditCard,
  Filter,
  HardHat,
  Loader2,
  LogOut,
  PackageCheck,
  QrCode,
  RefreshCw,
  Repeat2,
  Search,
  SquareKanban,
} from 'lucide-react';
import { Button, Input, Toaster } from '@/components/ui';
import { ImportContextProvider, AddItemsFab, ModuleDialog } from '@/components/order-pulse';
import { CommandPalette } from '@/components/command-palette';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useShopFloorMode } from '@/hooks/use-shop-floor-mode';
import { cn } from '@/lib/utils';
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
  onRefresh: () => void;
  isRefreshing: boolean;
}

export interface AppShellOutletContext {
  setQueueHeaderControls: React.Dispatch<React.SetStateAction<QueueHeaderControls | null>>;
  setPageHeaderActions: React.Dispatch<React.SetStateAction<React.ReactNode>>;
}

export function AppShell({ session, onSignOut }: AppShellProps) {
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

  const navItems = React.useMemo(
    () => [
      { to: '/', label: 'Dashboard', icon: Activity, section: 'kanban' as const },
      { to: '/cards', label: 'Cards', icon: CreditCard, section: 'kanban' as const },
      { to: '/loops', label: 'Loops', icon: Repeat2, section: 'kanban' as const },
      { to: '/parts', label: 'Items', icon: Boxes, section: 'operations' as const },
      { to: '/queue', label: 'Order Queue', icon: SquareKanban, section: 'operations' as const },
      {
        to: '/orders',
        label: 'Order History',
        icon: ClipboardList,
        section: 'operations' as const,
      },
      { to: '/receiving', label: 'Receiving', icon: PackageCheck, section: 'operations' as const },
    ],
    [],
  );

  return (
    <ImportContextProvider>
      <div className="app-shell-backdrop min-h-screen md:grid md:grid-cols-[228px_minmax(0,1fr)]">
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

          <nav className="flex-1 px-2 py-3">
            {navItems.map((item, index) => {
              const ItemIcon = item.icon;
              const prevSection = index > 0 ? navItems[index - 1].section : null;
              const showSeparator = prevSection && prevSection !== item.section;

              return (
                <React.Fragment key={item.to}>
                  {showSeparator && <div className="my-2 border-t border-sidebar-border/40" />}
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) => cn('sidebar-nav-item', isActive && 'active')}
                  >
                    <ItemIcon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </NavLink>
                </React.Fragment>
              );
            })}
          </nav>

          <div className="border-t border-sidebar-border/70 px-3 py-4 text-xs text-sidebar-muted">
            <p className="font-semibold text-sidebar-foreground">
              {session.user.firstName} {session.user.lastName}
            </p>
            <p className="mt-0.5">{session.user.role.replaceAll('_', ' ')}</p>
          </div>
        </aside>

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
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-2">
                <div className="flex min-w-[250px] flex-1 items-center overflow-hidden rounded-md border border-input bg-background">
                  <label className="flex h-9 items-center gap-1.5 border-r border-border px-2 text-xs text-muted-foreground">
                    <Filter className="h-3.5 w-3.5" />
                    <select
                      className="h-8 bg-transparent text-sm text-foreground outline-none"
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
                  <div className="relative min-w-[180px] flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={queueHeaderControls.query}
                      onChange={(event) => queueHeaderControls.onQueryChange(event.target.value)}
                      placeholder={queueHeaderControls.queryPlaceholder ?? 'Search'}
                      className="h-9 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
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

                <Button variant="accent" size="sm" onClick={queueHeaderControls.onRefresh}>
                  {queueHeaderControls.isRefreshing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Refresh
                </Button>
              </div>
            )}

            {!queueHeaderControls && pageHeaderActions && (
              <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
                {pageHeaderActions}
              </div>
            )}

            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 md:hidden">
              {navItems.map((item) => {
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
    </ImportContextProvider>
  );
}
