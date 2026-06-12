/**
 * Deck watcher — detects presentation-deck writes (`decks/<name>.html` in
 * the org home volume) during a run and emits `data-deck-updated` UI parts
 * so the chat side panel opens/refreshes the live deck preview.
 *
 * Detection is change-feed based rather than tool-based: every sandbox
 * write to the mounted `org/<slug>/` path flows through the WebDAV serve
 * layer into `OrgFs.write` and the manifest change feed, so decks created
 * via bash (the `slides-create` CLI) are caught the same as `write`-tool
 * edits. The cursor snapshots at run start; `sweep()` is hooked into
 * `onStepFinish` (and once more at run end — rclone's vfs write-back can
 * land a few seconds after the file is closed in the sandbox).
 *
 * Parts use a stable `id` per deck path so the AI SDK reconciles repeated
 * updates into one part per deck.
 */

import type { StudioContext } from "@/core/studio-context";
import { homeMountPath } from "@/file-storage/home-mount";
import { getSettings } from "@/settings";
import { matchDeckEntryPath } from "@decocms/harness/decopilot/built-in-tools/vm-tools/deck-paths";
import type { UIMessageStreamWriter } from "ai";

const HOME_VOLUME = "home";
const PAGE_SIZE = 200;

export interface DeckWatcher {
  /** Query the change feed since the last sweep and emit deck parts. */
  sweep(): Promise<void>;
}

export interface DeckUpdatedData {
  volume: string;
  path: string;
  name: string;
  /** Mount-relative path the agent sees, for chat-row display. */
  mountPath: string;
}

export function createDeckWatcher(
  ctx: StudioContext,
  writer: UIMessageStreamWriter,
): DeckWatcher {
  const orgFs = getSettings().orgFsClusterMounts ? ctx.orgFs : null;
  const orgSlug = ctx.organization?.slug ?? null;
  if (!orgFs || !orgSlug) {
    return { sweep: async () => {} };
  }
  const mountDir = homeMountPath(orgSlug);

  // Snapshot the cursor at run start so the first sweep only sees writes
  // made during this run. Errors degrade to a dead watcher, never a
  // failed run.
  const cursorReady: Promise<string | null> = orgFs
    .latestSeq(HOME_VOLUME)
    .catch((err) => {
      console.error("[deck-watcher] cursor snapshot failed", err);
      return null;
    });
  let cursor: string | null = null;
  let cursorInitialized = false;
  let sweeping = false;
  // Last emitted content hash per deck — the mount's vfs write-back
  // re-writes the same bytes the fast-path mirror already stored, which
  // bumps the change feed but changes nothing; skip those echoes so the
  // UI doesn't reload/re-open the preview for identical content.
  const emittedHash = new Map<string, string>();

  const sweep = async (): Promise<void> => {
    if (sweeping) return; // sweeps are serialized; skip overlap
    sweeping = true;
    try {
      if (!cursorInitialized) {
        cursor = await cursorReady;
        cursorInitialized = true;
      }
      if (cursor === null) return;
      const updated = new Map<string, DeckUpdatedData>();
      for (let pages = 0; pages < 20; pages++) {
        const page = await orgFs.changes(HOME_VOLUME, cursor, PAGE_SIZE);
        for (const entry of page.entries) {
          if (entry.kind !== "file" || entry.deletedAt) continue;
          const deck = matchDeckEntryPath(entry.path);
          if (!deck) continue;
          if (entry.contentHash) {
            if (emittedHash.get(deck.path) === entry.contentHash) continue;
            emittedHash.set(deck.path, entry.contentHash);
          }
          updated.set(deck.path, {
            volume: HOME_VOLUME,
            path: deck.path,
            name: deck.name,
            mountPath: `org/${mountDir}/${deck.path}`,
          });
        }
        cursor = page.cursor;
        if (!page.hasMore) break;
      }
      for (const data of updated.values()) {
        writer.write({
          type: "data-deck-updated",
          id: data.path,
          data,
        });
      }
    } catch (err) {
      console.error("[deck-watcher] sweep failed", err);
    } finally {
      sweeping = false;
    }
  };

  return { sweep };
}
