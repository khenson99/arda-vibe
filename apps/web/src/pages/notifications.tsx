import * as React from "react";
import { Link } from "react-router-dom";
import { Filter, Loader2, RefreshCw, Settings } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBanner } from "@/components/error-banner";
import { LoadingState } from "@/components/loading-state";
import { useWorkspaceData } from "@/hooks/use-workspace-data";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { AuthSession } from "@/types";

const NOTIFICATION_TYPES = [
  { value: "all", label: "All Types" },
  { value: "card_triggered", label: "Card Triggered" },
  { value: "po_created", label: "PO Created" },
  { value: "po_sent", label: "PO Sent" },
  { value: "po_received", label: "PO Received" },
  { value: "stockout_warning", label: "Stockout Warning" },
  { value: "relowisa_recommendation", label: "Relowisa Recommendation" },
  { value: "exception_alert", label: "Exception Alert" },
  { value: "wo_status_change", label: "WO Status Change" },
  { value: "transfer_status_change", label: "Transfer Status Change" },
  { value: "system_alert", label: "System Alert" },
];

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

  const [typeFilter, setTypeFilter] = React.useState("all");
  const [unreadOnlyFilter, setUnreadOnlyFilter] = React.useState(false);

  const filteredNotifications = React.useMemo(() => {
    let filtered = notifications;

    if (typeFilter !== "all") {
      filtered = filtered.filter((n) => n.type === typeFilter);
    }

    if (unreadOnlyFilter) {
      filtered = filtered.filter((n) => !n.isRead);
    }

    return filtered;
  }, [notifications, typeFilter, unreadOnlyFilter]);

  if (isLoading) {
    return <LoadingState message="Loading notifications..." />;
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onRetry={refreshNotificationsOnly} />}

      <Card className="card-arda">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Notifications</CardTitle>
              <CardDescription>
                {unreadNotifications} unread notification{unreadNotifications !== 1 ? "s" : ""}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/profile">
                  <Settings className="h-4 w-4" />
                  Preferences
                </Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshNotificationsOnly()}
                disabled={isRefreshing}
              >
                {isRefreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh
              </Button>
              {unreadNotifications > 0 && (
                <Button size="sm" onClick={() => void markEveryNotificationRead()}>
                  Mark All Read
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-3">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                {NOTIFICATION_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant={unreadOnlyFilter ? "default" : "outline"}
              size="sm"
              onClick={() => setUnreadOnlyFilter((prev) => !prev)}
            >
              <Filter className="h-4 w-4" />
              Unread Only
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-2">
          {filteredNotifications.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              No notifications found.
            </p>
          )}

          {filteredNotifications.map((notification) => (
            <article
              key={notification.id}
              className={cn(
                "rounded-xl border p-3",
                notification.isRead
                  ? "border-border bg-card"
                  : "border-[hsl(var(--link)/0.4)] bg-[hsl(var(--link)/0.07)]"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-semibold">{notification.title}</p>
                  <p className="text-sm text-muted-foreground">{notification.body}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!notification.isRead && (
                    <>
                      <Badge variant="accent">Unread</Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void markOneNotificationRead(notification.id)}
                      >
                        Mark Read
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span className="capitalize">{notification.type.replaceAll("_", " ")}</span>
                <span>{formatRelativeTime(notification.createdAt)}</span>
              </div>

              {notification.actionUrl && (
                <div className="mt-2">
                  <Button variant="link" size="sm" className="h-auto p-0" asChild>
                    <Link to={notification.actionUrl} className="text-[hsl(var(--link))]">
                      View Details →
                    </Link>
                  </Button>
                </div>
              )}
            </article>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
