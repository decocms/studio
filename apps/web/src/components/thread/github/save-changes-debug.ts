/** Browser-side debug for Save changes / Up to date header button. */
const KEY = "DEBUG_SAVE_CHANGES";

function saveChangesDebugEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveChangesDebug(message: string, data?: unknown): void {
  if (!saveChangesDebugEnabled()) return;
  console.log(`[github-header] ${message}`, data ?? "");
}

if (import.meta.env.DEV) {
  (
    globalThis as { enableSaveChangesDebug?: () => void }
  ).enableSaveChangesDebug = () => {
    localStorage.setItem(KEY, "1");
    console.log(
      "[github-header] Save-changes debug enabled — reload the page, edit a file, watch console.",
    );
  };
}
