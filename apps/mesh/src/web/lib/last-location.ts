import { LOCALSTORAGE_KEYS } from "./localstorage-keys";

/**
 * Where the user last was, restored on cold app entry ("/"). Recorded on every
 * org-scoped navigation: `org` alone for an org home / non-thread route, plus
 * `taskId` + `virtualmcpid` once a thread is open. Single source of truth, so
 * it can never disagree with itself the way two separate keys could.
 */
export interface LastLocation {
  org: string;
  taskId?: string;
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
    if (typeof parsed?.org === "string") {
      return {
        org: parsed.org,
        taskId: typeof parsed.taskId === "string" ? parsed.taskId : undefined,
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
