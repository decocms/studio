import { LOCALSTORAGE_KEYS } from "./localstorage-keys";

/** The thread the user last had open, restored on cold app entry ("/"). */
export interface LastLocation {
  org: string;
  taskId: string;
  virtualmcpid?: string;
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
    if (typeof parsed?.org === "string" && typeof parsed?.taskId === "string") {
      return {
        org: parsed.org,
        taskId: parsed.taskId,
        virtualmcpid:
          typeof parsed.virtualmcpid === "string"
            ? parsed.virtualmcpid
            : undefined,
      };
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
