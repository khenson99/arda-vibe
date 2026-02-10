import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Bell,
  Boxes,
  CircleAlert,
  Loader2,
  SquareKanban,
} from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { ErrorBanner } from "@/components/error-banner";
import { MetricCard } from "@/components/metric-card";
import { NextActionBanner } from "@/components/next-action-banner";
import { OnboardingOverlay } from "@/components/order-pulse";
import { useWorkspaceData } from "@/hooks/use-workspace-data";
import { formatRelativeTime, queueAgingHours } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { AuthSession } from "@/types";
import { LOOP_ORDER, LOOP_META } from "@/types";

export function DashboardRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const {
    isLoading,
    isRefreshing,
    error,
    queueSummary,
    queueByLoop,
    parts,
    partCount,
    notifications,
    unreadNotifications,
    refreshAll,
  } = useWorkspaceData(session.tokens.accessToken, onUnauthorized);

  if (isLoading) {
    return (
      <div className="space-y-6">
        {/* Hero banner skeleton */}
        <Skeleton className="h-32 w-full rounded-2xl" />

        {/* Metric cards skeleton */}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-4">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Loop columns skeleton */}
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-3">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="mt-1 h-3 w-40" />
              </CardHeader>
              <CardContent className="space-y-2">
                {Array.from({ length: 2 }).map((_, j) => (
                  <Skeleton key={j} className="h-16 w-full rounded-xl" />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
    {/* Onboarding overlay — shown when tenant has no parts */}
    <OnboardingOverlay
      tenantName={session.user.tenantName}
      partCount={partCount || parts.length}
    />

    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border bg-[linear-gradient(120deg,hsl(var(--arda-orange))_0%,hsl(var(--arda-orange-hover))_50%,hsl(var(--arda-blue))_120%)] p-6 text-white shadow-arda-orange">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.24),transparent_45%)]" />
        <div className="relative z-10 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold">Live queue command view</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/90">
              Track triggered cards by loop type, prioritize aging work, and keep scan operations in sync with Railway services.
            </p>
          </div>
          <Button asChild variant="secondary">
            <Link to="/queue">
              Open Queue Board
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={refreshAll} />}

      <NextActionBanner queueSummary={queueSummary} queueByLoop={queueByLoop} />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Triggered cards"
          value={String(queueSummary?.totalAwaitingOrders ?? 0)}
          detail="Awaiting order creation"
          icon={SquareKanban}
        />
        <MetricCard
          label="Oldest queue age"
          value={`${queueSummary?.oldestCardAgeHours ?? 0}h`}
          detail="Oldest triggered card"
          icon={CircleAlert}
          tone={(queueSummary?.oldestCardAgeHours ?? 0) >= 24 ? "warning" : "default"}
        />
        <MetricCard
          label="Active parts"
          value={String(partCount || parts.length)}
          detail="Catalog records available"
          icon={Boxes}
        />
        <MetricCard
          label="Unread alerts"
          value={String(unreadNotifications)}
          detail="From notifications service"
          icon={Bell}
          tone={unreadNotifications > 0 ? "accent" : "default"}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {LOOP_ORDER.map((loopType) => {
          const loopCards = queueByLoop[loopType] ?? [];
          const Icon = LOOP_META[loopType].icon;

          return (
            <Card key={loopType} className="card-arda">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Icon className="h-4 w-4 text-accent" />
                    {LOOP_META[loopType].label}
                  </CardTitle>
                  <Badge variant="accent">{loopCards.length}</Badge>
                </div>
                <CardDescription>Recent cards from this loop</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {loopCards.length === 0 && (
                  <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                    No triggered cards.
                  </p>
                )}

                {loopCards.slice(0, 3).map((card) => {
                  const ageHours = queueAgingHours(card);
                  return (
                    <div key={card.id} className="card-order-item">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold">
                            <span className="link-arda">Card #{card.cardNumber}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">Part {card.partId.slice(0, 8)}...</p>
                        </div>
                        <Badge variant={ageHours >= 24 ? "warning" : "secondary"}>{ageHours}h</Badge>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Recent notifications</CardTitle>
            <Button asChild variant="link" size="sm">
              <Link to="/notifications">View all</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {notifications.length === 0 && (
            <p className="text-sm text-muted-foreground">No notifications yet.</p>
          )}

          {notifications.slice(0, 5).map((notification) => (
            <div
              key={notification.id}
              className={cn(
                "rounded-lg border px-3 py-3",
                notification.isRead
                  ? "border-border bg-card"
                  : "border-[hsl(var(--arda-blue)/0.35)] bg-[hsl(var(--arda-blue)/0.06)]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{notification.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{notification.body}</p>
                </div>
                {!notification.isRead && <Badge variant="accent">New</Badge>}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{formatRelativeTime(notification.createdAt)}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {isRefreshing && (
        <div className="fixed bottom-4 right-4 rounded-full bg-card px-3 py-2 shadow-arda-md">
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Refreshing live data...
          </span>
        </div>
      )}
    </div>
    </>
  );
}
