/**
 * HTML-artifact watcher — detects live-HTML writes in the org home volume
 * (`decks/<name>.html` presentation decks, `pages/<name>.html` standalone
 * pages) during a run and emits `data-deck-updated` UI parts so the chat
 * side panel opens/refreshes the live preview.
 *
 * Detection is change-feed based rather than tool-based: every sandbox
 * write to the mounted `org/home/` path flows through the WebDAV serve
 * layer into `OrgFs.write` and the manifest change feed, so artifacts
 * created via bash (the `slides-create` CLI) are caught the same as
 * `write`-tool edits. The cursor snapshots at run start; `sweep()` is hooked
 * into `onStepFinish` (and once more at run end — rclone's vfs write-back can
 * land a few seconds after the file is closed in the sandbox).
 *
 * Parts use a stable `id` per artifact path so the AI SDK reconciles repeated
 * updates into one part per artifact. (`data-deck-updated` is the legacy wire
 * name; it covers both decks and pages.)
 */

import type { StudioContext } from "@/core/studio-context";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { matchOwnHtmlArtifact } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/html-artifact-paths";
import type { UIMessageStreamWriter } from "ai";

const HOME_VOLUME = "home";
const PAGE_SIZE = 200;

export interface HtmlArtifactWatcher {
  /** Query the change feed since the last sweep and emit artifact parts. */
  sweep(): Promise<void>;
}

export interface HtmlArtifactUpdatedData {
  volume: string;
  path: string;
  name: string;
  /** `deck` (decks/) or `page` (pages/) — drives chip icons. */
  kind: "deck" | "page";
  /** Mount-relative path the agent sees, for chat-row display. */
  mountPath: string;
}

export function createHtmlArtifactWatcher(
  ctx: StudioContext,
  writer: UIMessageStreamWriter,
): HtmlArtifactWatcher {
  const orgFs = ctx.orgFs;
  const orgSlug = ctx.organization?.slug ?? null;
  const ownerId = ctx.auth?.user?.id ?? null;
  if (!orgFs || !orgSlug || !ownerId) {
    return { sweep: async () => {} };
  }
  const mountDir = HOME_MOUNT_PATH;
  // The home volume is org-wide and shared across every chat and member; emit
  // only entries this run produced. Exact thread match for tool-written decks
  // (the deck-buffer stamps `thread_id`); same-user fallback for unstamped
  // bash/slides write-backs, which still blocks cross-member leaks.
  const scope = { threadId: ctx.metadata?.threadId ?? null, ownerId };

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
  // Last emitted content hash per artifact — the mount's vfs write-back
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
      const updated = new Map<string, HtmlArtifactUpdatedData>();
      for (let pages = 0; pages < 20; pages++) {
        const page = await orgFs.changes(HOME_VOLUME, cursor, PAGE_SIZE);
        for (const entry of page.entries) {
          const deck = matchOwnHtmlArtifact(entry, scope);
          if (!deck) continue;
          if (entry.contentHash) {
            if (emittedHash.get(deck.path) === entry.contentHash) continue;
            emittedHash.set(deck.path, entry.contentHash);
          }
          updated.set(deck.path, {
            volume: HOME_VOLUME,
            path: deck.path,
            name: deck.name,
            kind: deck.kind,
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
