/**
 * Near-realtime mount freshness for an org-fs volume.
 *
 * WebDAV has no ChangeNotify, so rclone can't learn about *external* writes on
 * its own — its only lever is the dir-cache TTL (a blunt time bound). This
 * closes that gap: poll the mesh change feed (`/api/:org/fs/:volume/changes`,
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
 * Freshness is push-driven. Preferred path: an SSE stream (`stream`) the server
 * holds open, pushing a page per write and a keepalive to beat the idle
 * timeout — zero reconnects while idle. Fallback (old mesh / NATS down): the
 * long-polled `changes` feed, which blocks server-side until a write nudge or
 * its hold timeout; the `pollMs` floor only kicks in if it returns fast-empty,
 * so the loop degrades to timer polling instead of busy-looping.
 *
 * Deps are injected so the loop is unit-testable without a real mesh or rclone.
 */

import { sleep } from "@decocms/std";

/** A change-feed page (live rows + tombstones), shared by both feed paths. */
export interface ChangePage {
  entries: { parent: string }[];
  cursor: string;
  hasMore: boolean;
}

export interface InvalidatorDeps {
  /**
   * Read the change feed from `since` ("0" = beginning). Long-polls: the call
   * blocks until a change or the server's hold timeout. The fallback path.
   */
  changes: (since: string) => Promise<ChangePage>;
  /**
   * Preferred path: open the SSE change stream from `since`, invoking `onPage`
   * per page. Resolves when the server ends the stream (reconnect); rejects
   * when streaming is unavailable (old mesh / no NATS) or on a transport error.
   * Optional — without it the loop uses `changes` only.
   */
  stream?: (
    since: string,
    onPage: (page: ChangePage) => void | Promise<void>,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Re-list one directory's cached entries (rclone `vfs/refresh dir=`). */
  refresh: (dir: string) => Promise<void>;
  /** Aborts the loop (mount teardown). */
  signal: AbortSignal;
  /** Floor between cycles when the long-poll returns fast-empty; default 1s. */
  pollMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

const DEFAULT_POLL_MS = 1000;

/** Cursor + prime state, advanced in place as pages are consumed. */
interface FeedState {
  since: string;
  /** Caught up to head once — refresh only fires for pages after this. */
  primed: boolean;
}

/**
 * Apply one change-feed page: refresh the parent dir of every change (deduped)
 * once primed, then advance the cursor. Before prime we only drain — the
 * mount's initial listing already reflects that state. Never throws.
 */
async function applyPage(
  page: ChangePage,
  state: FeedState,
  deps: Pick<InvalidatorDeps, "refresh" | "signal" | "log">,
): Promise<void> {
  if (state.primed && page.entries.length > 0) {
    // Dedupe: many changes in one dir collapse to a single refresh.
    const dirs = new Set(page.entries.map((e) => e.parent));
    for (const dir of dirs) {
      if (deps.signal.aborted) break;
      try {
        await deps.refresh(dir);
      } catch (err) {
        deps.log?.(`vfs/refresh failed for "${dir}"`, err);
      }
    }
  }
  state.since = page.cursor;
  if (!page.hasMore) state.primed = true; // everything after head is a real change
}

/**
 * Run until `signal` aborts. Prefers the SSE stream; on stream failure latches
 * over to the long-poll loop for the rest of this mount (the next mount retries
 * the stream). Never throws.
 */
export async function runInvalidator(deps: InvalidatorDeps): Promise<void> {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const log = deps.log ?? (() => {});
  const state: FeedState = { since: "0", primed: false };
  // ponytail: latch streaming off after one failure; re-enabled on next mount.
  let streaming = !!deps.stream;

  while (!deps.signal.aborted) {
    if (streaming && deps.stream) {
      try {
        // Resolves on clean server-side end → reconnect immediately, resuming
        // from the advanced cursor.
        await deps.stream(
          state.since,
          (page) => applyPage(page, state, deps),
          deps.signal,
        );
        continue;
      } catch (err) {
        if (deps.signal.aborted) return;
        log("change stream unavailable, falling back to poll loop", err);
        streaming = false;
      }
    }

    // --- Long-poll fallback --------------------------------------------------
    const startedAt = Date.now();
    let page: ChangePage;
    try {
      page = await deps.changes(state.since);
    } catch (err) {
      // rclone rc not up yet, transient mesh error, etc. — back off and retry.
      log("change-feed poll failed", err);
      await sleep(pollMs, { signal: deps.signal }).catch(() => {});
      continue;
    }

    await applyPage(page, state, deps);

    if (!page.hasMore && page.entries.length === 0) {
      // Long-poll already absorbs the idle wait; only back off when it returned
      // fast-empty (long-poll unavailable) so we don't busy-loop.
      const elapsed = Date.now() - startedAt;
      if (elapsed < pollMs) {
        await sleep(pollMs - elapsed, { signal: deps.signal }).catch(() => {});
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
