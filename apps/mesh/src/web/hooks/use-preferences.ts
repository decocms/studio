import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys.ts";

export type ToolApprovalLevel = "auto" | "readonly" | "plan";

interface Preferences {
  devMode: boolean;
  toolApprovalLevel: ToolApprovalLevel;
  enableNotifications: boolean;
}

const DEFAULT_PREFERENCES: Preferences = {
  devMode: false,
  toolApprovalLevel: "readonly",
  enableNotifications: typeof Notification !== "undefined" ? true : false,
};

const VALID_TOOL_APPROVAL_LEVELS: ToolApprovalLevel[] = [
  "auto",
  "readonly",
  "plan",
];

export function usePreferences() {
  return useLocalStorage<Preferences>(
    LOCALSTORAGE_KEYS.preferences(),
    (existing) => {
      const merged = { ...DEFAULT_PREFERENCES, ...existing };
      if (!VALID_TOOL_APPROVAL_LEVELS.includes(merged.toolApprovalLevel)) {
        merged.toolApprovalLevel = "readonly";
      }
      return merged;
    },
  );
}
