import * as React from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Bell,
  Clock,
  Info,
  Loader2,
  Mail,
  Monitor,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui";
import { ErrorBanner } from "@/components/error-banner";
import { LoadingState } from "@/components/loading-state";
import { useNotificationPreferences } from "@/hooks/use-notification-preferences";
import {
  NOTIFICATION_CATEGORIES,
  DIGEST_FREQUENCY_OPTIONS,
} from "@/types/notification-preferences";
import type {
  NotificationChannel,
  DigestFrequency,
} from "@/types/notification-preferences";
import type { AuthSession } from "@/types";

/* ── Props ────────────────────────────────────────────────────── */

interface Props {
  session: AuthSession;
  onUnauthorized: () => void;
}

/* ── Channel column header ────────────────────────────────────── */

interface ChannelHeaderProps {
  channel: NotificationChannel;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  disabledTooltip?: string;
}

function ChannelHeader({ channel: _channel, label, icon, disabled, disabledTooltip }: ChannelHeaderProps) {
  const content = (
    <div className="flex flex-col items-center gap-1 text-center">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs font-semibold">{label}</span>
      {disabled && (
        <Badge variant="outline" className="text-[10px]">
          Always on
        </Badge>
      )}
    </div>
  );

  if (disabled && disabledTooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">{content}</div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px] text-center">
          {disabledTooltip}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

/* ── Preference toggle cell ───────────────────────────────────── */

interface ToggleCellProps {
  checked: boolean;
  disabled?: boolean;
  disabledReason?: string;
  saving?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

function ToggleCell({ checked, disabled, disabledReason, saving, onChange, label }: ToggleCellProps) {
  const handleChange = React.useCallback(
    (value: boolean) => {
      onChange(value);
      toast.success("Preference saved", { duration: 1500 });
    },
    [onChange],
  );

  const switchElement = (
    <Switch
      checked={checked}
      onCheckedChange={handleChange}
      disabled={disabled || saving}
      aria-label={label}
      className={disabled ? "opacity-50" : ""}
    />
  );

  if (disabled && disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-not-allowed">{switchElement}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px] text-center">
          {disabledReason}
        </TooltipContent>
      </Tooltip>
    );
  }

  return switchElement;
}

/* ── Preference matrix table ──────────────────────────────────── */

interface PreferenceMatrixProps {
  preferences: Record<string, { inApp: boolean; email: boolean; webhook: boolean }>;
  saving: boolean;
  webhookFeatureEnabled: boolean;
  onToggle: (notificationType: string, channel: NotificationChannel, value: boolean) => void;
}

function PreferenceMatrix({
  preferences,
  saving,
  webhookFeatureEnabled,
  onToggle,
}: PreferenceMatrixProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" role="grid" aria-label="Notification preference matrix">
        <thead>
          <tr className="border-b border-border bg-muted">
            <th className="py-3 pl-4 pr-2 text-left font-semibold">Notification</th>
            <th className="w-[100px] px-2 py-3 text-center">
              <ChannelHeader
                channel="inApp"
                label="In-app"
                icon={<Monitor className="h-4 w-4" />}
                disabled
                disabledTooltip="In-app notifications are always enabled to ensure you see critical alerts."
              />
            </th>
            <th className="w-[100px] px-2 py-3 text-center">
              <ChannelHeader
                channel="email"
                label="Email"
                icon={<Mail className="h-4 w-4" />}
              />
            </th>
            {webhookFeatureEnabled && (
              <th className="w-[100px] px-2 py-3 text-center">
                <ChannelHeader
                  channel="webhook"
                  label="Webhook"
                  icon={<Webhook className="h-4 w-4" />}
                />
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_CATEGORIES.map((category) => (
            <React.Fragment key={category.id}>
              {/* Category header row */}
              <tr className="border-b border-border/60">
                <td
                  colSpan={webhookFeatureEnabled ? 4 : 3}
                  className="bg-muted/30 px-4 py-2"
                >
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    {category.label}
                  </span>
                </td>
              </tr>

              {/* Notification type rows */}
              {category.types.map((notifType) => {
                const prefs = preferences[notifType.id] ?? {
                  inApp: true,
                  email: true,
                  webhook: false,
                };

                return (
                  <tr
                    key={notifType.id}
                    className="border-b border-border/40 hover:bg-muted/50"
                  >
                    <td className="py-3 pl-4 pr-2">
                      <div>
                        <p className="font-medium">{notifType.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {notifType.description}
                        </p>
                      </div>
                    </td>

                    {/* In-app: always on, disabled toggle */}
                    <td className="px-2 py-3 text-center">
                      <div className="flex justify-center">
                        <ToggleCell
                          checked={true}
                          disabled
                          disabledReason="In-app notifications cannot be turned off"
                          saving={false}
                          onChange={() => {}}
                          label={`In-app notification for ${notifType.label}`}
                        />
                      </div>
                    </td>

                    {/* Email toggle */}
                    <td className="px-2 py-3 text-center">
                      <div className="flex justify-center">
                        <ToggleCell
                          checked={prefs.email}
                          saving={saving}
                          onChange={(v) => onToggle(notifType.id, "email", v)}
                          label={`Email notification for ${notifType.label}`}
                        />
                      </div>
                    </td>

                    {/* Webhook toggle (feature-gated) */}
                    {webhookFeatureEnabled && (
                      <td className="px-2 py-3 text-center">
                        <div className="flex justify-center">
                          <ToggleCell
                            checked={prefs.webhook}
                            saving={saving}
                            onChange={(v) => onToggle(notifType.id, "webhook", v)}
                            label={`Webhook notification for ${notifType.label}`}
                          />
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Digest frequency section ─────────────────────────────────── */

interface DigestSectionProps {
  frequency: DigestFrequency;
  saving: boolean;
  onChange: (frequency: DigestFrequency) => void;
}

function DigestSection({ frequency, saving, onChange }: DigestSectionProps) {
  const handleChange = React.useCallback(
    (value: string) => {
      onChange(value as DigestFrequency);
      toast.success("Digest frequency updated", { duration: 1500 });
    },
    [onChange],
  );

  const currentOption = DIGEST_FREQUENCY_OPTIONS.find((opt) => opt.value === frequency);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Email Digest Frequency</CardTitle>
            <CardDescription>
              Control how often email notifications are batched and sent
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <label className="text-sm font-medium" htmlFor="digest-frequency">
              Frequency
            </label>
            <Select
              value={frequency}
              onValueChange={handleChange}
              disabled={saving}
            >
              <SelectTrigger id="digest-frequency" className="w-full sm:max-w-[240px]">
                <SelectValue placeholder="Select frequency" />
              </SelectTrigger>
              <SelectContent>
                {DIGEST_FREQUENCY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {currentOption && (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Info className="h-3 w-3" />
                {currentOption.description}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Page component ───────────────────────────────────────────── */

export function NotificationPreferencesRoute({ session, onUnauthorized }: Props) {
  const {
    preferences,
    digestFrequency,
    loading,
    saving,
    error,
    webhookFeatureEnabled,
    togglePreference,
    setDigestFrequency,
    reload,
  } = useNotificationPreferences({
    token: session.tokens.accessToken,
    onUnauthorized,
  });

  if (loading) {
    return <LoadingState message="Loading notification preferences..." />;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" asChild>
              <Link to="/">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>
            </Button>
            <div className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-muted-foreground" />
              <div>
                <h1 className="text-lg font-semibold">Notification Preferences</h1>
                <p className="text-xs text-muted-foreground">
                  Choose how you want to be notified for each event type
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {saving && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Saving...
              </span>
            )}
            <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        {error && <ErrorBanner message={error} onRetry={reload} />}

        {/* Preference matrix card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Notification Channels</CardTitle>
            <CardDescription>
              Toggle which channels receive each notification type. Changes save automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <PreferenceMatrix
              preferences={preferences}
              saving={saving}
              webhookFeatureEnabled={webhookFeatureEnabled}
              onToggle={togglePreference}
            />
          </CardContent>
        </Card>

        {/* Digest frequency */}
        <DigestSection
          frequency={digestFrequency}
          saving={saving}
          onChange={setDigestFrequency}
        />
      </div>
    </TooltipProvider>
  );
}
