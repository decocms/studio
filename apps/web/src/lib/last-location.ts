import { LOCALSTORAGE_KEYS } from "./localstorage-keys";

/**
 * The organization restored on cold app entry (`/`). Conversations and page
 * layout intentionally do not resume in a fresh tab.
 */
export interface LastLocation {
  org: string;
}

export function saveLastLocation(loc: LastLocation): void {
  try {
    localStorage.setItem(LOCALSTORAGE_KEYS.lastLocation(), JSON.stringify(loc));
  } catch {
    // ignore quota / privacy-mode failures — restore is best-effort
  }
}

export function readLastLocation(): LastLocation | null {
  try {
    const raw = localStorage.getItem(LOCALSTORAGE_KEYS.lastLocation());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastLocation>;
    if (typeof parsed?.org === "string") {
      return { org: parsed.org };
    }
  } catch {
    // corrupt value — treat as absent
  }
  return null;
}

export function clearLastLocation(): void {
  try {
    localStorage.removeItem(LOCALSTORAGE_KEYS.lastLocation());
  } catch {
    // ignore
  }
}
