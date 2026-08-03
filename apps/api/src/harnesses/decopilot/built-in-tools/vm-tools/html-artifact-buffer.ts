/**
 * HTML-artifact buffer (cluster glue) — fast-path mirror for `write`/`edit`
 * tool calls on `org/home/{decks,pages}/<name>.html`. The sandbox mount's
 * vfs write-back takes seconds to reach org-fs; mirroring the tool's full
 * content server-side at step end makes the live preview (and the change-feed
 * watcher, which emits the `data-deck-updated` part) see the bytes
 * immediately. The mount's own later write-back re-uploads identical bytes —
 * that echo still bumps the change feed (OrgFs.write doesn't compare
 * contentHash), so the watcher dedupes emissions by content hash and the UI
 * keys its cache marker on the hash too.
 *
 * Coalesces per path: a burst of writes/edits to the same artifact collapses
 * to one org-fs write per step.
 */

import type { StudioContext } from "@/core/studio-context";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { matchHtmlArtifactToolPath } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/html-artifact-paths";
import type { HtmlArtifactBuffer } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/types";

const HOME_VOLUME = "home";

const NOOP: HtmlArtifactBuffer = { enqueue: () => {}, flush: async () => {} };

export function createHtmlArtifactBuffer(
  ctx: StudioContext,
): HtmlArtifactBuffer {
  const orgFs = ctx.orgFs;
  const orgSlug = ctx.organization?.slug ?? null;
  const actor = ctx.auth?.user?.id ?? null;
  if (!orgFs || !orgSlug || !actor) return NOOP;
  const mountDir = HOME_MOUNT_PATH;
  // Stamp the writing chat so the watcher can scope its preview to this
  // run instead of every org-wide change (the home volume is shared).
  const threadId = ctx.metadata?.threadId ?? null;

  const pending = new Map<string, string>();

  return {
    enqueue(rawPath, content) {
      const deck = matchHtmlArtifactToolPath(rawPath, mountDir);
      if (!deck) return;
      pending.set(deck.path, content);
    },
    async flush() {
      if (pending.size === 0) return;
      const entries = [...pending.entries()];
      pending.clear();
      await Promise.allSettled(
        entries.map(async ([path, content]) => {
          try {
            await orgFs.write(HOME_VOLUME, path, content, {
              actor,
              contentType: "text/html; charset=utf-8",
              threadId,
            });
          } catch (err) {
            console.error("[deck-buffer] org-fs write failed", { path }, err);
          }
        }),
      );
    },
  };
}
