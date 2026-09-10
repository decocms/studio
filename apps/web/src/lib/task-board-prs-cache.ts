/**
 * localStorage cache for a task's PR cards.
 *
 * The card's data comes from a live GitHub read, and the server can only make
 * that fast, not instant. On a cold page load React Query has nothing, so
 * opening a task painted `PrCardSkeleton` and the Links section reflowed once
 * the read landed — every single time.
 *
 * Seeding the query from here paints the last known card immediately and
 * revalidates in the background (the card shows a breathing border while it
 * does). Non-secret org metadata only — PR titles, numbers, check names, the
 * preview URL — the same class as the connection list `query-persist.ts`
 * already persists.
 *
 * Its own capped store rather than the bootstrap `dehydrate` blob: that one is
 * parsed synchronously before React mounts, and every task a user ever opened
 * has no business on the boot path.
 */

import { LOCALSTORAGE_KEYS } from "./localstorage-keys";
import type { ProjectLocator } from "@/sdk";

/** Stale entries are still SERVED (they revalidate immediately); past this they
 *  are dropped, so a task nobody has opened in a day stops taking up room. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Cap on tasks cached per org. Bounds growth for someone who opens hundreds of
 *  cards over a week; the least-recently-written go first. */
const MAX_CACHED_TASKS = 40;

type Entry = { data: unknown; updatedAt: number };
type Store = Record<string, Entry>;

function read(locator: ProjectLocator): Store {
  try {
    const raw = window.localStorage.getItem(
      LOCALSTORAGE_KEYS.taskBoardPrs(locator),
    );
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

/** Drop expired entries, then keep the `MAX_CACHED_TASKS` most recent. Without
 *  it the map only ever grows. */
function prune(store: Store): Store {
  const now = Date.now();
  const fresh = Object.entries(store).filter(
    ([, e]) => now - e.updatedAt <= MAX_AGE_MS,
  );
  fresh.sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
  while (fresh.length > MAX_CACHED_TASKS) fresh.shift();
  return Object.fromEntries(fresh);
}

/** The cached cards for a task, or null on a miss/expiry. */
export function readCachedTaskPrs(
  locator: ProjectLocator,
  itemId: string,
): Entry | null {
  if (typeof window === "undefined") return null;
  const entry = read(locator)[itemId];
  if (!entry || Date.now() - entry.updatedAt > MAX_AGE_MS) return null;
  return entry;
}

/** Store a task's cards. Best-effort: a quota failure must never break a read. */
export function writeCachedTaskPrs(
  locator: ProjectLocator,
  itemId: string,
  data: unknown,
): void {
  if (typeof window === "undefined") return;
  try {
    const store = read(locator);
    store[itemId] = { data, updatedAt: Date.now() };
    // Prune AFTER inserting: pruning first lets the store settle one entry
    // above the cap forever, since the new write always lands on top of it.
    window.localStorage.setItem(
      LOCALSTORAGE_KEYS.taskBoardPrs(locator),
      JSON.stringify(prune(store)),
    );
  } catch {
    // Quota / serialization failure — the query just runs cold next time.
  }
}
