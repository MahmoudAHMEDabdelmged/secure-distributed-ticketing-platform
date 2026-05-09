"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeChoice) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const storageKey = "ezbook_theme";
const legacyStorageKey = "secure_tickets_theme";
const themeChangeEventName = "ezbook-theme-change";

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

function getStoredThemeSnapshot(): ThemeChoice {
  if (typeof window === "undefined") {
    return "system";
  }

  const storedTheme =
    window.localStorage.getItem(storageKey) ||
    window.localStorage.getItem(legacyStorageKey);

  return isThemeChoice(storedTheme) ? storedTheme : "system";
}

function getStoredThemeServerSnapshot(): ThemeChoice {
  return "system";
}

function subscribeToStoredTheme(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  window.addEventListener("storage", onStoreChange);
  window.addEventListener(themeChangeEventName, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(themeChangeEventName, onStoreChange);
  };
}

function getSystemThemeSnapshot(): ResolvedTheme {
  if (typeof window === "undefined") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getSystemThemeServerSnapshot(): ResolvedTheme {
  return "light";
}

function subscribeToSystemTheme(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", onStoreChange);

  return () => {
    mediaQuery.removeEventListener("change", onStoreChange);
  };
}

function resolveTheme(theme: ThemeChoice, systemTheme: ResolvedTheme): ResolvedTheme {
  if (theme === "light" || theme === "dark") {
    return theme;
  }

  return systemTheme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore<ThemeChoice>(
    subscribeToStoredTheme,
    getStoredThemeSnapshot,
    getStoredThemeServerSnapshot,
  );

  const systemTheme = useSyncExternalStore<ResolvedTheme>(
    subscribeToSystemTheme,
    getSystemThemeSnapshot,
    getSystemThemeServerSnapshot,
  );

  const resolvedTheme = resolveTheme(theme, systemTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme(nextTheme) {
        window.localStorage.setItem(storageKey, nextTheme);
        window.localStorage.removeItem(legacyStorageKey);
        window.dispatchEvent(new Event(themeChangeEventName));
      },
    }),
    [theme, resolvedTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }

  return context;
}