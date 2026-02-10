import * as React from "react";

const STORAGE_KEY = "arda.web.shopFloorMode";

/**
 * Manages the "Shop Floor Mode" preference.
 *
 * When active, applies `.shop-floor-mode` to `<html>`, which:
 * - Forces `density-comfortable` (40px rows)
 * - Minimum 48×48px touch targets
 * - 16px base font
 * - Larger checkboxes and icons
 *
 * Persisted in localStorage so the preference survives page reloads.
 */
export function useShopFloorMode() {
  const [isActive, setIsActive] = React.useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  });

  // Apply / remove the class on <html> whenever the state changes
  React.useEffect(() => {
    const root = document.documentElement;
    if (isActive) {
      root.classList.add("shop-floor-mode");
    } else {
      root.classList.remove("shop-floor-mode");
    }
  }, [isActive]);

  const toggle = React.useCallback(() => {
    setIsActive((prev) => {
      const next = !prev;
      window.localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { isShopFloorMode: isActive, toggleShopFloorMode: toggle } as const;
}
