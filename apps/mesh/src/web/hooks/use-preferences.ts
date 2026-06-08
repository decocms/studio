import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys.ts";

export type ToolApprovalLevel = "auto" | "readonly";
export type ThemeMode = "light" | "dark" | "system";
interface Preferences {
  toolApprovalLevel: ToolApprovalLevel;
  enableNotifications: boolean;
  enableSounds: boolean;
  theme: ThemeMode;
}

const DEFAULT_PREFERENCES: Preferences = {
  toolApprovalLevel: "auto",
  enableNotifications: typeof Notification !== "undefined" ? true : false,
  enableSounds: false,
  theme: "system",
};

const VALID_TOOL_APPROVAL_LEVELS: ToolApprovalLevel[] = ["auto", "readonly"];

export const APPROVAL_LEVEL_OPTIONS: {
  value: ToolApprovalLevel;
  label: string;
  short: string;
}[] = [
  { value: "readonly", label: "Ask before edit", short: "Ask" },
  { value: "auto", label: "Auto approve", short: "Auto" },
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
      return merged;
    },
  );
}
