/**
 * Deck buffer (cluster glue) — fast-path mirror for `write`/`edit` tool
 * calls on `org/<slug>/decks/<name>.html`. The sandbox mount's vfs
 * write-back takes seconds to reach org-fs; mirroring the tool's full
 * content server-side at step end makes the deck preview (and the
 * change-feed deck watcher, which emits the `data-deck-updated` part)
 * see the bytes immediately. The mount's own later write-back uploads
 * identical content, so the two paths converge.
 *
 * Coalesces per path like the html-page buffer: a burst of writes/edits
 * to the same deck collapses to one org-fs write per step.
 */

import type { StudioContext } from "@/core/studio-context";
import { homeMountPath } from "@/file-storage/home-mount";
import { getSettings } from "@/settings";
import { matchDeckToolPath } from "@decocms/harness/decopilot/built-in-tools/vm-tools/deck-paths";
import type { DeckBuffer } from "@decocms/harness/decopilot/built-in-tools/vm-tools/types";

const HOME_VOLUME = "home";

const NOOP: DeckBuffer = { enqueue: () => {}, flush: async () => {} };

export function createDeckBuffer(ctx: StudioContext): DeckBuffer {
  const orgFs = getSettings().orgFsClusterMounts ? ctx.orgFs : null;
  const orgSlug = ctx.organization?.slug ?? null;
  const actor = ctx.auth?.user?.id ?? null;
  if (!orgFs || !orgSlug || !actor) return NOOP;
  const mountDir = homeMountPath(orgSlug);

  const pending = new Map<string, string>();

  return {
    enqueue(rawPath, content) {
      const deck = matchDeckToolPath(rawPath, mountDir);
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
            });
          } catch (err) {
            console.error("[deck-buffer] org-fs write failed", { path }, err);
          }
        }),
      );
    },
  };
}
