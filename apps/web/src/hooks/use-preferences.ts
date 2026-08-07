import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys.ts";
import { detectLocale, VALID_LOCALES, type Locale } from "@/i18n/locale.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";

export type ToolApprovalLevel = "auto" | "readonly";
export type ThemeMode = "light" | "dark" | "system";
interface Preferences {
  toolApprovalLevel: ToolApprovalLevel;
  enableNotifications: boolean;
  enableSounds: boolean;
  theme: ThemeMode;
  language: Locale;
  /**
   * Default visibility of the sandbox preview terminal on surfaces that have
   * one. `false` keeps the historical opt-in behavior; `true` shows it by
   * default. A per-VM Show/Hide choice still overrides this default.
   */
  terminalVisibleByDefault: boolean;
}

const DEFAULT_PREFERENCES: Preferences = {
  toolApprovalLevel: "auto",
  enableNotifications: typeof Notification !== "undefined",
  enableSounds: false,
  theme: "system",
  language: detectLocale(),
  terminalVisibleByDefault: false,
};

const VALID_TOOL_APPROVAL_LEVELS: ToolApprovalLevel[] = ["auto", "readonly"];

export const APPROVAL_LEVEL_OPTIONS: {
  value: ToolApprovalLevel;
  labelKey: TranslationKey;
  shortKey: TranslationKey;
}[] = [
  {
    value: "readonly",
    labelKey: "settings.preferences.toolApprovalAsk",
    shortKey: "settings.preferences.toolApprovalAskShort",
  },
  {
    value: "auto",
    labelKey: "settings.preferences.toolApprovalAuto",
    shortKey: "settings.preferences.toolApprovalAutoShort",
  },
];

const VALID_THEME_MODES: ThemeMode[] = ["light", "dark", "system"];

/**
 * Read toolApprovalLevel directly from localStorage (no React state).
 * Useful when the value must be fresh outside the React render cycle.
 */
export function readToolApprovalLevel(): ToolApprovalLevel {
  try {
    const raw = JSON.parse(
      localStorage.getItem(LOCALSTORAGE_KEYS.preferences()) ?? "{}",
    );
    if (VALID_TOOL_APPROVAL_LEVELS.includes(raw.toolApprovalLevel)) {
      return raw.toolApprovalLevel;
    }
  } catch {}
  return "auto";
}

/**
 * Read the language directly from localStorage (no React state), for the same
 * reason as [`readToolApprovalLevel`] — see `i18n/use-t.ts`'s `translate`.
 */
export function readLanguage(): Locale {
  try {
    const raw = JSON.parse(
      localStorage.getItem(LOCALSTORAGE_KEYS.preferences()) ?? "{}",
    );
    if (VALID_LOCALES.includes(raw.language)) return raw.language;
  } catch {}
  return detectLocale();
}

export function usePreferences() {
  return useLocalStorage<Preferences>(
    LOCALSTORAGE_KEYS.preferences(),
    (existing) => {
      const merged = { ...DEFAULT_PREFERENCES, ...existing };
      if (!VALID_TOOL_APPROVAL_LEVELS.includes(merged.toolApprovalLevel)) {
        merged.toolApprovalLevel = "auto";
      }
      if (!VALID_THEME_MODES.includes(merged.theme)) {
        merged.theme = "system";
      }
      if (!VALID_LOCALES.includes(merged.language)) {
        merged.language = detectLocale();
      }
      return merged;
    },
  );
}
