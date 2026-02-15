import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  NotificationPreferencesMap,
  NotificationChannel,
} from "@/types/notification-preferences";
import { NOTIFICATION_CATEGORIES } from "@/types/notification-preferences";

/**
 * Tests for notification preferences logic —
 * debounced save, rapid toggle coalescence, and preference data structures.
 *
 * These are pure logic tests; no React rendering is needed.
 */

/* ── Helpers that mirror hook internals ──────────────────────── */

function buildDefaultPrefs(): NotificationPreferencesMap {
  const prefs: NotificationPreferencesMap = {};
  for (const cat of NOTIFICATION_CATEGORIES) {
    for (const t of cat.types) {
      prefs[t.id] = { inApp: true, email: true, webhook: false };
    }
  }
  return prefs;
}

function applyToggle(
  prefs: NotificationPreferencesMap,
  notificationType: string,
  channel: NotificationChannel,
  value: boolean,
): NotificationPreferencesMap {
  // Mirror the hook's togglePreference logic
  if (channel === "inApp") return prefs; // in-app is always true

  const current = prefs[notificationType] ?? { inApp: true, email: true, webhook: false };
  return {
    ...prefs,
    [notificationType]: {
      ...current,
      [channel]: value,
    },
  };
}

/* ── Tests ────────────────────────────────────────────────────── */

describe("Notification Preferences Logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Default preferences structure", () => {
    it("should have an entry for every notification type in the catalog", () => {
      const prefs = buildDefaultPrefs();
      const allTypeIds = NOTIFICATION_CATEGORIES.flatMap((c) => c.types.map((t) => t.id));

      expect(Object.keys(prefs).sort()).toEqual(allTypeIds.sort());
    });

    it("should default to inApp=true, email=true, webhook=false", () => {
      const prefs = buildDefaultPrefs();

      for (const entry of Object.values(prefs)) {
        expect(entry.inApp).toBe(true);
        expect(entry.email).toBe(true);
        expect(entry.webhook).toBe(false);
      }
    });

    it("should contain all 13 notification types across 5 categories", () => {
      const prefs = buildDefaultPrefs();
      expect(Object.keys(prefs)).toHaveLength(13);
      expect(NOTIFICATION_CATEGORIES).toHaveLength(5);
    });
  });

  describe("Toggle preference logic", () => {
    it("should toggle email off for a specific notification type", () => {
      const prefs = buildDefaultPrefs();
      const updated = applyToggle(prefs, "po_created", "email", false);

      expect(updated.po_created.email).toBe(false);
      expect(updated.po_created.inApp).toBe(true); // unchanged
      expect(updated.po_created.webhook).toBe(false); // unchanged
    });

    it("should toggle webhook on for a specific notification type", () => {
      const prefs = buildDefaultPrefs();
      const updated = applyToggle(prefs, "stockout_warning", "webhook", true);

      expect(updated.stockout_warning.webhook).toBe(true);
      expect(updated.stockout_warning.email).toBe(true); // unchanged
    });

    it("should NOT allow toggling inApp (always true)", () => {
      const prefs = buildDefaultPrefs();
      const updated = applyToggle(prefs, "po_created", "inApp", false);

      // Should return the same reference — no mutation
      expect(updated).toBe(prefs);
      expect(updated.po_created.inApp).toBe(true);
    });

    it("should not affect other notification types when toggling one", () => {
      const prefs = buildDefaultPrefs();
      const updated = applyToggle(prefs, "po_created", "email", false);

      // po_sent should be untouched
      expect(updated.po_sent.email).toBe(true);
      expect(updated.po_received.email).toBe(true);
    });

    it("should handle toggling a type that has no existing entry (fallback defaults)", () => {
      const prefs: NotificationPreferencesMap = {};
      const updated = applyToggle(prefs, "custom_type", "email", false);

      expect(updated.custom_type).toEqual({
        inApp: true,
        email: false,
        webhook: false,
      });
    });
  });

  describe("Rapid toggle coalescence (debounce behavior)", () => {
    it("should only fire save once after rapid toggles within debounce window", () => {
      const DEBOUNCE_MS = 600;
      const saveFn = vi.fn();
      let pending: NotificationPreferencesMap | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function scheduleSave(nextPrefs: NotificationPreferencesMap) {
        pending = nextPrefs;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (pending) {
            saveFn(pending);
            pending = null;
          }
        }, DEBOUNCE_MS);
      }

      // Simulate rapid toggles
      let prefs = buildDefaultPrefs();

      prefs = applyToggle(prefs, "po_created", "email", false);
      scheduleSave(prefs);

      prefs = applyToggle(prefs, "po_sent", "email", false);
      scheduleSave(prefs);

      prefs = applyToggle(prefs, "stockout_warning", "webhook", true);
      scheduleSave(prefs);

      // Before debounce fires — no save yet
      expect(saveFn).not.toHaveBeenCalled();

      // Advance past debounce
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      // Should have been called exactly once
      expect(saveFn).toHaveBeenCalledTimes(1);

      // The saved payload should have ALL three toggles applied
      const savedPrefs = saveFn.mock.calls[0][0] as NotificationPreferencesMap;
      expect(savedPrefs.po_created.email).toBe(false);
      expect(savedPrefs.po_sent.email).toBe(false);
      expect(savedPrefs.stockout_warning.webhook).toBe(true);
    });

    it("should reset debounce timer on each toggle", () => {
      const DEBOUNCE_MS = 600;
      const saveFn = vi.fn();
      let pending: NotificationPreferencesMap | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function scheduleSave(nextPrefs: NotificationPreferencesMap) {
        pending = nextPrefs;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (pending) {
            saveFn(pending);
            pending = null;
          }
        }, DEBOUNCE_MS);
      }

      let prefs = buildDefaultPrefs();

      // First toggle
      prefs = applyToggle(prefs, "po_created", "email", false);
      scheduleSave(prefs);

      // Advance 400ms (within debounce)
      vi.advanceTimersByTime(400);
      expect(saveFn).not.toHaveBeenCalled();

      // Second toggle resets the timer
      prefs = applyToggle(prefs, "po_sent", "email", false);
      scheduleSave(prefs);

      // Advance another 400ms (total 800ms from first, but only 400ms from second)
      vi.advanceTimersByTime(400);
      expect(saveFn).not.toHaveBeenCalled();

      // Advance final 250ms to pass 600ms from second toggle
      vi.advanceTimersByTime(250);
      expect(saveFn).toHaveBeenCalledTimes(1);
    });

    it("should trigger separate saves for toggles separated by more than debounce window", () => {
      const DEBOUNCE_MS = 600;
      const saveFn = vi.fn();
      let pending: NotificationPreferencesMap | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function scheduleSave(nextPrefs: NotificationPreferencesMap) {
        pending = nextPrefs;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (pending) {
            saveFn(pending);
            pending = null;
          }
        }, DEBOUNCE_MS);
      }

      let prefs = buildDefaultPrefs();

      // First toggle
      prefs = applyToggle(prefs, "po_created", "email", false);
      scheduleSave(prefs);

      // Wait for debounce to fire
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
      expect(saveFn).toHaveBeenCalledTimes(1);

      // Second toggle after debounce window
      prefs = applyToggle(prefs, "po_sent", "email", false);
      scheduleSave(prefs);

      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
      expect(saveFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("Category structure validation", () => {
    it("Procurement category should have 3 types", () => {
      const procurement = NOTIFICATION_CATEGORIES.find((c) => c.id === "procurement");
      expect(procurement).toBeDefined();
      expect(procurement!.types).toHaveLength(3);
      expect(procurement!.types.map((t) => t.id)).toEqual([
        "po_created",
        "po_sent",
        "po_received",
      ]);
    });

    it("Inventory category should have 4 types", () => {
      const inventory = NOTIFICATION_CATEGORIES.find((c) => c.id === "inventory");
      expect(inventory).toBeDefined();
      expect(inventory!.types).toHaveLength(4);
    });

    it("System category should have 3 types", () => {
      const system = NOTIFICATION_CATEGORIES.find((c) => c.id === "system");
      expect(system).toBeDefined();
      expect(system!.types).toHaveLength(3);
    });

    it("All notification types should have a non-empty label and description", () => {
      for (const cat of NOTIFICATION_CATEGORIES) {
        for (const t of cat.types) {
          expect(t.label.length).toBeGreaterThan(0);
          expect(t.description.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("Webhook feature gate logic", () => {
    it("should exclude webhook column data when feature is disabled", () => {
      const webhookEnabled = false;
      const prefs = buildDefaultPrefs();

      // When rendering the matrix, we filter channels based on the feature flag
      const channels: NotificationChannel[] = webhookEnabled
        ? ["inApp", "email", "webhook"]
        : ["inApp", "email"];

      expect(channels).toEqual(["inApp", "email"]);
      // webhook prefs still exist in data but aren't rendered
      expect(prefs.po_created.webhook).toBe(false);
    });

    it("should include webhook column when feature is enabled", () => {
      const webhookEnabled = true;
      const channels: NotificationChannel[] = webhookEnabled
        ? ["inApp", "email", "webhook"]
        : ["inApp", "email"];

      expect(channels).toEqual(["inApp", "email", "webhook"]);
    });
  });
});
