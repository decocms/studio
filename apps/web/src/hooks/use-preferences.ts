import type { Locale } from "@/i18n/locale.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys.ts";
import { detectLocale, VALID_LOCALES } from "@/i18n/locale.ts";

export type ToolApprovalLevel = "auto" | "readonly";
export type ThemeMode = "light" | "dark" | "system";
interface Preferences {
  toolApprovalLevel: ToolApprovalLevel;
  enableNotifications: boolean;
  enableSounds: boolean;
  theme: ThemeMode;
  language: Locale;
  /**
   * Task-board lanes this person showed (`true`) or hid (`false`), overriding
   * the default (`HIDDEN_STATUSES`). Keyed by status, not lane index, so a
   * reordered or renamed lane can't resurrect the wrong column.
   */
  taskBoardLaneVisibility: Record<string, boolean>;
  /** Task-board lanes this person collapsed to a narrow strip. Statuses, for
   *  the same reason as `taskBoardLaneVisibility`. */
  collapsedTaskBoardLanes: string[];
  /** Project-first navigation opt-in: the org rail, project launcher, project tree and Today/Agents home. */
  projectFirstNav: boolean;
}

const DEFAULT_PREFERENCES: Preferences = {
  toolApprovalLevel: "auto",
  enableNotifications: typeof Notification !== "undefined",
  enableSounds: false,
  theme: "system",
  language: detectLocale(),
  taskBoardLaneVisibility: {},
  collapsedTaskBoardLanes: [],
  projectFirstNav: false,
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

/** The stored lane overrides, keeping only boolean entries. Folds in the
 *  retired `shownTaskBoardLanes` list, whose lanes were all shown. */
export function readLaneVisibility(
  stored: Record<string, unknown>,
): Record<string, boolean> {
  const visibility: Record<string, boolean> = {};
  if (Array.isArray(stored.shownTaskBoardLanes)) {
    for (const status of stored.shownTaskBoardLanes) {
      if (typeof status === "string") visibility[status] = true;
    }
  }
  const current = stored.taskBoardLaneVisibility;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    for (const [status, shown] of Object.entries(current)) {
      if (typeof shown === "boolean") visibility[status] = shown;
    }
  }
  return visibility;
}

export function usePreferences() {
  return useLocalStorage<Preferences>(
    LOCALSTORAGE_KEYS.preferences(),
    (existing) => {
      const merged = { ...DEFAULT_PREFERENCES, ...existing };
      // Remove retired settings (the blocks editor is now an org flag).
      if ("showProjectSettingsGear" in merged) {
        delete merged.showProjectSettingsGear;
      }
      if ("compactPageLayout" in merged) {
        delete merged.compactPageLayout;
      }
      if (!VALID_TOOL_APPROVAL_LEVELS.includes(merged.toolApprovalLevel)) {
        merged.toolApprovalLevel = "auto";
      }
      if (!VALID_THEME_MODES.includes(merged.theme)) {
        merged.theme = "system";
      }
      if (!VALID_LOCALES.includes(merged.language)) {
        merged.language = detectLocale();
      }
      merged.taskBoardLaneVisibility = readLaneVisibility(merged);
      if ("shownTaskBoardLanes" in merged) {
        delete merged.shownTaskBoardLanes;
      }
      if (!Array.isArray(merged.collapsedTaskBoardLanes)) {
        merged.collapsedTaskBoardLanes = [];
      }
      merged.projectFirstNav = merged.projectFirstNav === true;
      return merged;
    },
  );
}

export function useProjectFirstNav(): boolean {
  const [preferences] = usePreferences();
  return preferences.projectFirstNav;
}
