import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  fetchNotificationPreferences,
  updateNotificationPreferences,
  parseApiError,
  isUnauthorized,
  type NotificationPreferences,
} from "@/lib/api-client";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LoadingState } from "@/components/loading-state";
import { ErrorBanner } from "@/components/error-banner";

interface NotificationPreferencesProps {
  token: string;
  onUnauthorized: () => void;
}

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  card_triggered: "Card Triggered",
  po_created: "Purchase Order Created",
  po_sent: "Purchase Order Sent",
  po_received: "Purchase Order Received",
  stockout_warning: "Stockout Warning",
  relowisa_recommendation: "Relowisa Recommendation",
  exception_alert: "Exception Alert",
  wo_status_change: "Work Order Status Change",
  transfer_status_change: "Transfer Order Status Change",
  system_alert: "System Alert",
};

export function NotificationPreferencesForm({
  token,
  onUnauthorized,
}: NotificationPreferencesProps) {
  const [preferences, setPreferences] = React.useState<NotificationPreferences>({});
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadPreferences = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchNotificationPreferences(token);
      setPreferences(data);
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [token, onUnauthorized]);

  React.useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const handleToggle = (notificationType: string, channel: "inApp" | "email" | "webhook") => {
    setPreferences((prev) => ({
      ...prev,
      [notificationType]: {
        ...prev[notificationType],
        [channel]: !prev[notificationType]?.[channel],
      },
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const updated = await updateNotificationPreferences(token, preferences);
      setPreferences(updated);
      toast.success("Preferences saved successfully");
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      const errorMessage = parseApiError(err);
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <LoadingState message="Loading notification preferences..." />;
  }

  return (
    <Card className="card-arda" id="preferences">
      <CardHeader>
        <CardTitle>Notification Preferences</CardTitle>
        <CardDescription>
          Control which notifications you receive and how you receive them
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <ErrorBanner message={error} onRetry={loadPreferences} />}

        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-4 border-b border-border pb-2 text-sm font-semibold">
            <div>Notification Type</div>
            <div className="text-center">In-App</div>
            <div className="text-center">Email</div>
            <div className="text-center">Webhook</div>
          </div>

          {Object.entries(NOTIFICATION_TYPE_LABELS).map(([type, label]) => {
            const pref = preferences[type] || { inApp: true, email: false, webhook: false };

            return (
              <div key={type} className="grid grid-cols-4 gap-4 items-center">
                <Label className="text-sm">{label}</Label>
                <div className="flex justify-center">
                  <Checkbox
                    checked={pref.inApp}
                    onChange={() => handleToggle(type, "inApp")}
                  />
                </div>
                <div className="flex justify-center">
                  <Checkbox
                    checked={pref.email}
                    onChange={() => handleToggle(type, "email")}
                  />
                </div>
                <div className="flex justify-center">
                  <Checkbox
                    checked={pref.webhook}
                    onChange={() => handleToggle(type, "webhook")}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={loadPreferences} disabled={isSaving}>
            Reset
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save Preferences
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
