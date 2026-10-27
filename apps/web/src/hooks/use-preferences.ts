import { createContext, use } from "react";
import type { Locale } from "@/i18n/locale.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { authClient } from "@/lib/auth-client";
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
  /** Project-first navigation: the org rail, project launcher, project tree and
   *  Today/Agents home. Unset until the person picks; see `projectFirstNavEnabled`. */
  projectFirstNav?: boolean;
}

const DEFAULT_PREFERENCES: Preferences = {
  toolApprovalLevel: "auto",
  enableNotifications: typeof Notification !== "undefined",
  enableSounds: false,
  theme: "system",
  language: detectLocale(),
  taskBoardLaneVisibility: {},
  collapsedTaskBoardLanes: [],
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
      if (typeof merged.projectFirstNav !== "boolean") {
        delete merged.projectFirstNav;
      }
      return merged;
    },
  );
}

/** Set by `/site-editor`, which always renders in the New Layout, whatever
 *  this person's preference says. Scoped to that route's tree. */
export const ForceProjectFirstNav = createContext(false);

/**
 * Accounts created from this date start in project-first navigation. Older
 * accounts keep the classic one until they opt in, on any browser.
 */
export const PROJECT_FIRST_NAV_DEFAULT_SINCE = Date.parse(
  "2026-10-22T00:00:00Z",
);

/** A person's choice wins; without one, the account's age decides. */
export function projectFirstNavEnabled(
  stored: boolean | undefined,
  userCreatedAt: unknown,
): boolean {
  if (stored !== undefined) return stored;
  const created =
    userCreatedAt instanceof Date
      ? userCreatedAt.getTime()
      : typeof userCreatedAt === "string" || typeof userCreatedAt === "number"
        ? new Date(userCreatedAt).getTime()
        : Number.NaN;
  return Number.isFinite(created) && created >= PROJECT_FIRST_NAV_DEFAULT_SINCE;
}

export function useProjectFirstNav(): boolean {
  const forced = use(ForceProjectFirstNav);
  const [preferences] = usePreferences();
  const { data: session } = authClient.useSession();
  return (
    forced ||
    projectFirstNavEnabled(
      preferences.projectFirstNav,
      session?.user?.createdAt,
    )
  );
}
