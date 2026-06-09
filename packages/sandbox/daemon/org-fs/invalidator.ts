/**
 * Near-realtime mount freshness for an org-fs volume.
 *
 * WebDAV has no ChangeNotify, so rclone can't learn about *external* writes on
 * its own — its only lever is the dir-cache TTL (a blunt time bound). This
 * closes that gap: poll the mesh change feed (`/api/:org/fs/:volume/changes`,
 * a single indexed query — NOT a directory re-listing) and, for every changed
 * path, tell rclone via its rc API to `vfs/forget` that path's parent dir. The
 * next access re-lists only that dir, picking up adds/deletes and (via the
 * refreshed modtime) modified content.
 *
 * Result: external changes surface in ~1 poll interval instead of a dir-cache
 * TTL. The poll is the interim trigger; a NATS nudge can later wake this loop
 * instantly (the codebase's NatsNotify + polling-safety-net pattern), removing
 * the steady-state poll without changing the forget logic.
 *
 * Deps are injected so the loop is unit-testable without a real mesh or rclone.
 */

import { sleep } from "@decocms/std";

export interface InvalidatorDeps {
  /** Poll the change feed from `since` ("0" = beginning). */
  changes: (since: string) => Promise<{
    entries: { parent: string }[];
    cursor: string;
    hasMore: boolean;
  }>;
  /** Invalidate one directory's cached listing (rclone `vfs/forget dir=`). */
  forget: (dir: string) => Promise<void>;
  /** Aborts the loop (mount teardown). */
  signal: AbortSignal;
  /** Idle poll interval; default 1s. */
  pollMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

const DEFAULT_POLL_MS = 1000;

/**
 * Run until `signal` aborts. First drains the feed to its head WITHOUT
 * forgetting (the mount's initial listing already reflects that state), then
 * forgets the parent dir of every subsequent change. Never throws.
 */
export async function runInvalidator(deps: InvalidatorDeps): Promise<void> {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const log = deps.log ?? (() => {});
  let since = "0";
  let primed = false;

  while (!deps.signal.aborted) {
    let page: Awaited<ReturnType<InvalidatorDeps["changes"]>>;
    try {
      page = await deps.changes(since);
    } catch (err) {
      // rclone rc not up yet, transient mesh error, etc. — back off and retry.
      log("change-feed poll failed", err);
      await sleep(pollMs, { signal: deps.signal }).catch(() => {});
      continue;
    }

    if (primed && page.entries.length > 0) {
      // Dedupe: many changes in one dir collapse to a single forget.
      const dirs = new Set(page.entries.map((e) => e.parent));
      for (const dir of dirs) {
        if (deps.signal.aborted) break;
        try {
          await deps.forget(dir);
        } catch (err) {
          log(`vfs/forget failed for "${dir}"`, err);
        }
      }
    }

    since = page.cursor;
    if (!page.hasMore) {
      primed = true; // caught up to head; everything after this is a real change
      await sleep(pollMs, { signal: deps.signal }).catch(() => {});
    }
    // hasMore → loop immediately to drain the backlog.
  }
}

/**
 * The real `forget`: POST rclone's rc `vfs/forget`. Loopback + `--rc-no-auth`
 * (same trust boundary as the loopback WebDAV server). An empty `dir` (a
 * root-level change) forgets the whole VFS, which re-lists the root on next
 * access — rare and cheap enough.
 */
export function makeRcForget(rcUrl: string) {
  return async (dir: string): Promise<void> => {
    const res = await fetch(`${rcUrl}/vfs/forget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dir ? { dir } : {}),
    });
    if (!res.ok) {
      throw new Error(`vfs/forget ${res.status}: ${await res.text()}`);
    }
  };
}
