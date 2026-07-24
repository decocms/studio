/**
 * Per-thread layout memory.
 *
 * The workspace tab layout (`?main=<tabId>` + `?sidepanel=`) lives in the URL,
 * so switching threads drops it and the target thread opens on its agent
 * default. This module remembers each thread's last layout, keyed by task id,
 * so returning to a thread restores the tabs/side-panel the user left it with.
 *
 * Storage is **sessionStorage**: layout is a within-session working state, not a
 * durable preference. Per-tab isolation is intentional — the same thread open in
 * two tabs keeps independent layouts, and nothing accumulates across sessions.
 *
 * All access is best-effort: sessionStorage can throw (privacy mode, quota, SSR)
 * and stored JSON can be tampered with, so every read is sanitized and every
 * write is wrapped. A read failure means "no memory", never a crash.
 */

const STORAGE_KEY = "studio:thread-layout:v1";

/** LRU cap. Bounds growth within a session; oldest threads evict first. */
const MAX_THREADS = 50;

export interface ThreadLayout {
  /** `?main` value: a tab id, or `0` for the closed main panel. */
  main?: string | 0;
  /** `?sidepanel` value: `"chat"` open, or `0` closed. */
  sidepanel?: "chat" | 0;
}

/** Most-recent entry last, so `.shift()` evicts the least-recently-saved. */
type StoredEntry = [taskId: string, layout: ThreadLayout];

/**
 * Keep only well-shaped values. Guards against tampered storage and against
 * accidentally persisting unrelated search params. Absent/invalid fields are
 * dropped (meaning "use the default"), which is distinct from an absent entry.
 */
export function sanitizeThreadLayout(layout: ThreadLayout): ThreadLayout {
  const clean: ThreadLayout = {};
  if (layout.main === 0 || typeof layout.main === "string") {
    clean.main = layout.main;
  }
  if (layout.sidepanel === 0 || layout.sidepanel === "chat") {
    clean.sidepanel = layout.sidepanel;
  }
  return clean;
}

/**
 * LRU upsert: move `taskId` to the most-recent slot with `layout`, evicting the
 * oldest entries past the cap. Pure — takes and returns the entry list.
 */
export function upsertThreadLayoutEntries(
  entries: StoredEntry[],
  taskId: string,
  layout: ThreadLayout,
  cap: number = MAX_THREADS,
): StoredEntry[] {
  const next = entries.filter(([id]) => id !== taskId);
  next.push([taskId, sanitizeThreadLayout(layout)]);
  while (next.length > cap) next.shift();
  return next;
}

function readStore(): StoredEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is StoredEntry =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === "string",
    );
  } catch {
    return [];
  }
}

function writeStore(entries: StoredEntry[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // sessionStorage unavailable or over quota — layout memory is best-effort.
  }
}

/** Remember `taskId`'s current layout. No-op for a falsy id or empty session. */
export function saveThreadLayout(taskId: string, layout: ThreadLayout): void {
  if (!taskId) return;
  writeStore(upsertThreadLayoutEntries(readStore(), taskId, layout));
}

/** The remembered layout for `taskId`, or null when nothing is stored. */
export function readThreadLayout(taskId: string): ThreadLayout | null {
  if (!taskId) return null;
  const entry = readStore().find(([id]) => id === taskId);
  return entry ? sanitizeThreadLayout(entry[1]) : null;
}

/** Drop a thread's memory — called when the thread is archived/deleted. */
export function forgetThreadLayout(taskId: string): void {
  if (!taskId) return;
  const entries = readStore();
  const next = entries.filter(([id]) => id !== taskId);
  if (next.length !== entries.length) writeStore(next);
}
