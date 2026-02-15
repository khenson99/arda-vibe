import { useState, useEffect, useCallback, useRef } from "react";
import {
  isUnauthorized,
  parseApiError,
  fetchNotificationPreferences,
  updateNotificationPreferences,
  fetchDigestFrequency,
  updateDigestFrequency,
  fetchCurrentTenant,
} from "@/lib/api-client";
import type {
  NotificationPreferencesMap,
  NotificationChannel,
  DigestFrequency,
} from "@/types/notification-preferences";

/* ── Debounce delay for autosave ─────────────────────────────── */

const DEBOUNCE_MS = 600;

/* ── Hook interface ──────────────────────────────────────────── */

interface UseNotificationPreferencesOptions {
  token: string;
  onUnauthorized: () => void;
}

interface UseNotificationPreferencesReturn {
  preferences: NotificationPreferencesMap;
  digestFrequency: DigestFrequency;
  loading: boolean;
  saving: boolean;
  error: string | null;
  webhookFeatureEnabled: boolean;
  togglePreference: (notificationType: string, channel: NotificationChannel, value: boolean) => void;
  setDigestFrequency: (frequency: DigestFrequency) => void;
  reload: () => void;
}

export function useNotificationPreferences({
  token,
  onUnauthorized,
}: UseNotificationPreferencesOptions): UseNotificationPreferencesReturn {
  const [preferences, setPreferences] = useState<NotificationPreferencesMap>({});
  const [digestFrequency, setDigestFrequencyState] = useState<DigestFrequency>("daily");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhookFeatureEnabled, setWebhookFeatureEnabled] = useState(false);

  const isMountedRef = useRef(true);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPrefsRef = useRef<NotificationPreferencesMap | null>(null);

  /* ── Fetch preferences on mount ─────────────────────────────── */

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [prefs, freq, tenant] = await Promise.all([
        fetchNotificationPreferences(token),
        fetchDigestFrequency(token).catch(() => "daily" as DigestFrequency),
        fetchCurrentTenant(token),
      ]);

      if (!isMountedRef.current) return;

      setPreferences(prefs);
      setDigestFrequencyState(freq);

      // Check if tenant has webhook feature enabled
      const settings = tenant.settings;
      if (settings && "webhookEnabled" in settings) {
        setWebhookFeatureEnabled(Boolean((settings as Record<string, unknown>).webhookEnabled));
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setError(parseApiError(err));
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    isMountedRef.current = true;
    void load();
    return () => {
      isMountedRef.current = false;
    };
  }, [load]);

  /* ── Debounced save ─────────────────────────────────────────── */

  const flushSave = useCallback(
    async (prefsToSave: NotificationPreferencesMap) => {
      setSaving(true);
      try {
        const updated = await updateNotificationPreferences(token, prefsToSave);
        if (isMountedRef.current) {
          setPreferences(updated);
          pendingPrefsRef.current = null;
        }
        return { success: true as const };
      } catch (err) {
        if (!isMountedRef.current) return { success: false as const };
        if (isUnauthorized(err)) {
          onUnauthorized();
          return { success: false as const };
        }
        return { success: false as const, error: parseApiError(err) };
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    },
    [token, onUnauthorized],
  );

  const scheduleSave = useCallback(
    (nextPrefs: NotificationPreferencesMap) => {
      pendingPrefsRef.current = nextPrefs;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        if (pendingPrefsRef.current && isMountedRef.current) {
          void flushSave(pendingPrefsRef.current);
        }
      }, DEBOUNCE_MS);
    },
    [flushSave],
  );

  /* ── Cleanup debounce on unmount ────────────────────────────── */

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      // Flush pending save on unmount
      if (pendingPrefsRef.current) {
        void flushSave(pendingPrefsRef.current);
      }
    };
  }, [flushSave]);

  /* ── Toggle a single preference ─────────────────────────────── */

  const togglePreference = useCallback(
    (notificationType: string, channel: NotificationChannel, value: boolean) => {
      // In-app is always true, so don't allow toggling it
      if (channel === "inApp") return;

      setPreferences((prev) => {
        const current = prev[notificationType] ?? { inApp: true, email: true, webhook: false };
        const next: NotificationPreferencesMap = {
          ...prev,
          [notificationType]: {
            ...current,
            [channel]: value,
          },
        };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  /* ── Update digest frequency ────────────────────────────────── */

  const handleSetDigestFrequency = useCallback(
    async (frequency: DigestFrequency) => {
      setDigestFrequencyState(frequency);
      setSaving(true);
      try {
        const updated = await updateDigestFrequency(token, frequency);
        if (isMountedRef.current) {
          setDigestFrequencyState(updated);
        }
        return { success: true as const };
      } catch (err) {
        if (!isMountedRef.current) return { success: false as const };
        if (isUnauthorized(err)) {
          onUnauthorized();
          return { success: false as const };
        }
        return { success: false as const, error: parseApiError(err) };
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    },
    [token, onUnauthorized],
  );

  return {
    preferences,
    digestFrequency,
    loading,
    saving,
    error,
    webhookFeatureEnabled,
    togglePreference,
    setDigestFrequency: (f: DigestFrequency) => void handleSetDigestFrequency(f),
    reload: load,
  };
}
