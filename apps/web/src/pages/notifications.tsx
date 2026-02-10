import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ErrorBanner } from "@/components/error-banner";
import { LoadingState } from "@/components/loading-state";
import { useWorkspaceData } from "@/hooks/use-workspace-data";
import { formatLoopType, formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { AuthSession } from "@/types";
import { Loader2, RefreshCw } from "lucide-react";

export function NotificationsRoute({
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
    notifications,
    unreadNotifications,
    refreshNotificationsOnly,
    markOneNotificationRead,
    markEveryNotificationRead,
  } = useWorkspaceData(session.tokens.accessToken, onUnauthorized);

  if (isLoading) {
    return <LoadingState message="Loading notifications..." />;
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onRetry={refreshNotificationsOnly} />}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Notification feed</CardTitle>
              <CardDescription>{unreadNotifications} unread notifications</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void refreshNotificationsOnly()}>
                {isRefreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh
              </Button>
              <Button variant="secondary" onClick={() => void markEveryNotificationRead()}>
                Mark all read
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-2">
          {notifications.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              No notifications found.
            </p>
          )}

          {notifications.map((notification) => (
            <article
              key={notification.id}
              className={cn(
                "rounded-xl border p-3",
                notification.isRead
                  ? "border-border bg-card"
                  : "border-[hsl(var(--arda-blue)/0.4)] bg-[hsl(var(--arda-blue)/0.07)]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <p className="text-sm font-semibold">{notification.title}</p>
                  <p className="text-sm text-muted-foreground">{notification.body}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!notification.isRead && <Badge variant="accent">Unread</Badge>}
                  {!notification.isRead && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void markOneNotificationRead(notification.id)}
                    >
                      Mark read
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{formatLoopType(notification.type)}</span>
                <span>{formatRelativeTime(notification.createdAt)}</span>
              </div>
            </article>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
