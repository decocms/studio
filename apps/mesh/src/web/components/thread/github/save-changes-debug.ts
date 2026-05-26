/** Browser-side debug for Save changes / Up to date header button. */
const KEY = "DEBUG_SAVE_CHANGES";

export function saveChangesDebugEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveChangesDebug(
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!saveChangesDebugEnabled()) return;
  console.log(`[github-header] ${message}`, data ?? "");
}

/** Run once in the browser console: localStorage.setItem('DEBUG_SAVE_CHANGES','1') */
export function enableSaveChangesDebug(): void {
  localStorage.setItem(KEY, "1");
  console.log(
    "[github-header] Save-changes debug enabled — reload the page, edit a file, watch console.",
  );
}

if (import.meta.env.DEV) {
  (
    globalThis as { enableSaveChangesDebug?: () => void }
  ).enableSaveChangesDebug = enableSaveChangesDebug;
}
