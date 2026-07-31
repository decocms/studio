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

/** Forget where the user was — both the location and the cached org slug. */
export function clearRestoreState(): void {
  try {
    localStorage.removeItem(LOCALSTORAGE_KEYS.lastLocation());
    localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
  } catch {
    // ignore
  }
}

/**
 * Restore state is browser-global, but it describes ONE principal's history: a
 * second account signing in on the same browser (or a session that expired and
 * was replaced) would otherwise be redirected into the previous user's org and
 * dead-end on the no-access screen. Called from the shell once the session
 * resolves — the first moment the real principal is known, since cold entry's
 * redirect happens before any network call.
 */
export function claimRestoreStateFor(userId: string): void {
  try {
    if (localStorage.getItem(LOCALSTORAGE_KEYS.lastUserId()) === userId) return;
    localStorage.setItem(LOCALSTORAGE_KEYS.lastUserId(), userId);
    clearRestoreState();
  } catch {
    // ignore
  }
}

// Per-tab, one-shot marker: "the home loader sent the user here from restore
// state", as opposed to the user opening the URL themselves. lastLocation can't
// answer that — orgLayout.beforeLoad rewrites it to the current org on arrival.
const RESTORE_REDIRECT_KEY = "studio:restore-redirect";

// `undefined` = not read yet. The answer is memoized because the gate asks
// during render, and a re-render (StrictMode, a refetch) must get the same
// answer as the first one — a plain one-shot read would say "not a restore" the
// second time and render the dead-end screen instead of bouncing.
let restoredOrg: string | null | undefined;

export function markRestoreRedirect(org: string): void {
  restoredOrg = undefined;
  try {
    sessionStorage.setItem(RESTORE_REDIRECT_KEY, org);
  } catch {
    // ignore
  }
}

/** Whether `org` was reached via a restore redirect (consumes the marker). */
export function consumeRestoreRedirect(org: string): boolean {
  if (restoredOrg === undefined) {
    try {
      restoredOrg = sessionStorage.getItem(RESTORE_REDIRECT_KEY);
      sessionStorage.removeItem(RESTORE_REDIRECT_KEY);
    } catch {
      restoredOrg = null;
    }
  }
  return restoredOrg === org;
}
