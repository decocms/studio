import { useLocalStorage } from "./use-local-storage.ts";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys.ts";

export type ToolApprovalLevel = "none" | "readonly" | "yolo";

interface Preferences {
  devMode: boolean;
  experimental_projects: boolean;
  toolApprovalLevel: ToolApprovalLevel;
  enableNotifications: boolean;
}

const DEFAULT_PREFERENCES: Preferences = {
  devMode: false,
  experimental_projects: false,
  toolApprovalLevel: "none",
  enableNotifications: typeof Notification !== "undefined" ? true : false,
};

export function usePreferences() {
  return useLocalStorage<Preferences>(
    LOCALSTORAGE_KEYS.preferences(),
    (existing) => ({ ...DEFAULT_PREFERENCES, ...existing }),
  );
}
