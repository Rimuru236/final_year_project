/**
 * useTheme — Day 6 (D6-4)
 *
 * Toggles a "dark" class on <html> and persists the choice in localStorage.
 * localStorage is appropriate here — this is a real browser app, not a
 * Claude.ai artifact — and it matches the expectation in §0.1 of the plan.
 *
 * The persisted server-side theme (via /settings/theme) is loaded on mount
 * by SettingsPage and applied here, so the preference survives across devices.
 */

import { useState, useEffect, useCallback } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "cs-theme";

function applyTheme(theme: Theme) {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    return stored ?? "light";
  });

  // Apply on mount + whenever theme changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
    applyTheme(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
