import * as z from "zod";

/**
 * During a rolling deploy, pods of both builds serve traffic and each one has
 * only its own build's `/assets`, so a page and the chunk it asks for can come
 * from different builds. Chromium caches a failed module fetch for the life of
 * the document, so retrying the import never refetches; only a reload does.
 * Reloads back off so a user whose reload lands on mismatched pods again keeps
 * retrying until the rollout settles, instead of facing a dead-end screen.
 */

const STORAGE_KEY = "__studio_stale_build_reload";

const RELOAD_DELAYS_MS = [
  0, 2_000, 5_000, 10_000, 15_000, 30_000, 30_000, 30_000, 60_000, 60_000,
];

/** A failure this long after the last reload starts a new episode. */
const EPISODE_GAP_MS = 5 * 60_000;

const reloadStateSchema = z.object({
  attempt: z.number().int().nonnegative(),
  reloadAt: z.number(),
});

type ReloadState = z.infer<typeof reloadStateSchema>;

export type StaleBuildReload =
  | { status: "scheduled" }
  | { status: "exhausted" };

export function isStaleAssetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("Unable to preload CSS")
  );
}

interface ReloadEnv {
  /** A getter, because touching `sessionStorage` throws when storage is blocked. */
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  reload: () => void;
  schedule: (fn: () => void, delayMs: number) => void;
  now: () => number;
}

export function createStaleBuildReload(env: ReloadEnv) {
  let pending: StaleBuildReload | null = null;

  const readState = (now: number): ReloadState | null => {
    try {
      const raw = env.storage().getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = reloadStateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      return now - parsed.data.reloadAt > EPISODE_GAP_MS ? null : parsed.data;
    } catch {
      return null;
    }
  };

  const writeState = (state: ReloadState | null) => {
    try {
      if (state) env.storage().setItem(STORAGE_KEY, JSON.stringify(state));
      else env.storage().removeItem(STORAGE_KEY);
    } catch {
      // Unavailable storage degrades to an immediate reload on every failure.
    }
  };

  return {
    /** Schedules the next backed-off reload; repeat calls are no-ops. */
    schedule(): StaleBuildReload {
      if (pending) return pending;
      const now = env.now();
      const attempt = (readState(now)?.attempt ?? -1) + 1;
      const delay = RELOAD_DELAYS_MS[attempt];
      if (delay === undefined) {
        pending = { status: "exhausted" };
        return pending;
      }
      writeState({ attempt, reloadAt: now + delay });
      env.schedule(env.reload, delay);
      pending = { status: "scheduled" };
      return pending;
    },
    /** A manual refresh starts a fresh episode of automatic retries. */
    reloadNow() {
      writeState(null);
      env.reload();
    },
  };
}

const staleBuildReload = createStaleBuildReload({
  storage: () => sessionStorage,
  reload: () => window.location.reload(),
  schedule: (fn, delayMs) => setTimeout(fn, delayMs),
  now: Date.now,
});

export const scheduleStaleBuildReload = staleBuildReload.schedule;
export const reloadNow = staleBuildReload.reloadNow;

/** Vite fires this when a lazy chunk or its CSS fails to load, including
 *  imports outside React render that no error boundary sees. */
export function installStaleBuildReload() {
  window.addEventListener("vite:preloadError", () => {
    scheduleStaleBuildReload();
  });
}
