import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys.ts";
import { detectLocale, VALID_LOCALES, type Locale } from "@/web/i18n/locale.ts";
import type { TranslationKey } from "@/web/i18n/en/index.ts";

export type ToolApprovalLevel = "auto" | "readonly";
export type ThemeMode = "light" | "dark" | "system";
interface Preferences {
  toolApprovalLevel: ToolApprovalLevel;
  enableNotifications: boolean;
  enableSounds: boolean;
  theme: ThemeMode;
  language: Locale;
}

const DEFAULT_PREFERENCES: Preferences = {
  toolApprovalLevel: "auto",
  enableNotifications: typeof Notification !== "undefined",
  enableSounds: false,
  theme: "system",
  language: detectLocale(),
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
