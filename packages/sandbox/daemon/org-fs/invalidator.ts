/**
 * Near-realtime mount freshness for an org-fs volume.
 *
 * WebDAV has no ChangeNotify, so rclone can't learn about *external* writes on
 * its own — its only lever is the dir-cache TTL (a blunt time bound). This
 * closes that gap: poll the studio change feed (`/api/:org/fs/:volume/changes`,
 * a single indexed query — NOT a directory re-listing) and, for every changed
 * path, tell rclone via its rc API to `vfs/refresh` that path's parent dir.
 * That re-lists only that dir, picking up adds/deletes and (via the refreshed
 * modtime) modified content.
 *
 * `vfs/refresh`, NOT `vfs/forget`: forget drops VFS nodes (it's a memory
 * reclaim), which kills handles open on them — and the mount's own writes echo
 * through the change feed, so forget would sever a file mid-write (observed on
 * macOS NFS: hung writer + an empty flushed file). Refresh re-lists in place;
 * open handles and dirty cache entries survive.
 *
 * The change feed is long-polled (`changes` blocks server-side until a write
 * nudge or its hold timeout), so steady state is push-driven: no timer poll
 * while idle, and external changes surface as soon as the write commits. The
 * `pollMs` floor only kicks in if the server returns fast with nothing — i.e.
 * long-poll isn't available (NATS down) — so the loop degrades to timer polling
 * instead of busy-looping.
 *
 * Deps are injected so the loop is unit-testable without a real studio or rclone.
 */

import { sleep } from "@decocms/std";

export interface InvalidatorDeps {
  /**
   * Read the change feed from `since` ("0" = beginning). Long-polls: the call
   * blocks until a change or the server's hold timeout.
   */
  changes: (since: string) => Promise<{
    entries: { parent: string }[];
    cursor: string;
    hasMore: boolean;
  }>;
  /** Re-list one directory's cached entries (rclone `vfs/refresh dir=`). */
  refresh: (dir: string) => Promise<void>;
  /** Aborts the loop (mount teardown). */
  signal: AbortSignal;
  /** Floor between cycles when the long-poll returns fast-empty; default 1s. */
  pollMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

const DEFAULT_POLL_MS = 1000;

/**
 * Run until `signal` aborts. First drains the feed to its head WITHOUT
 * refreshing (the mount's initial listing already reflects that state), then
 * refreshes the parent dir of every subsequent change. Never throws.
 */
export async function runInvalidator(deps: InvalidatorDeps): Promise<void> {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const log = deps.log ?? (() => {});
  let since = "0";
  let primed = false;

  while (!deps.signal.aborted) {
    const startedAt = Date.now();
    let page: Awaited<ReturnType<InvalidatorDeps["changes"]>>;
    try {
      page = await deps.changes(since);
    } catch (err) {
      // rclone rc not up yet, transient studio error, etc. — back off and retry.
      log("change-feed poll failed", err);
      await sleep(pollMs, { signal: deps.signal }).catch(() => {});
      continue;
    }

    if (primed && page.entries.length > 0) {
      // Dedupe: many changes in one dir collapse to a single refresh.
      const dirs = new Set(page.entries.map((e) => e.parent));
      for (const dir of dirs) {
        if (deps.signal.aborted) break;
        try {
          await deps.refresh(dir);
        } catch (err) {
          log(`vfs/refresh failed for "${dir}"`, err);
        }
      }
    }

    since = page.cursor;
    if (!page.hasMore) {
      primed = true; // caught up to head; everything after this is a real change
      // Long-poll already absorbs the idle wait, so don't sleep on top of it.
      // Only back off when it returned fast-empty (long-poll unavailable / NATS
      // down) — that prevents a busy loop without delaying real changes.
      if (page.entries.length === 0) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < pollMs) {
          await sleep(pollMs - elapsed, { signal: deps.signal }).catch(
            () => {},
          );
        }
      }
    }
    // hasMore → loop immediately to drain the backlog.
  }
}

/**
 * The real `refresh`: POST rclone's rc `vfs/refresh`. Loopback + `--rc-no-auth`
 * (same trust boundary as the loopback WebDAV server). An empty `dir` (a
 * root-level change) refreshes the root listing.
 */
export function makeRcRefresh(rcUrl: string) {
  return async (dir: string): Promise<void> => {
    const res = await fetch(`${rcUrl}/vfs/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dir ? { dir } : {}),
    });
    if (!res.ok) {
      throw new Error(`vfs/refresh ${res.status}: ${await res.text()}`);
    }
  };
}
