/**
 * Live-HTML path matching — pure logic shared by the cluster HTML-artifact
 * watcher (org-fs change-feed entries) and any tool-path detection.
 *
 * Convention: HTML artifacts the user should see live in the org home
 * volume, which sandboxes see mounted at the fixed `org/home/`:
 *   - `decks/<name>.html` — presentation decks (the `slides` skill)
 *   - `pages/<name>.html` — standalone pages (landing pages, one-pagers)
 * The Studio web UI previews (and for decks, edits) the same files.
 */

const DECK_ENTRY_PATTERN = /^(decks|pages)\/([a-z0-9][a-z0-9._-]*)\.html$/i;

export interface HtmlArtifactRef {
  /** Volume-relative path, e.g. `decks/q3-launch.html`. */
  path: string;
  /** File stem, e.g. `q3-launch`. */
  name: string;
  /** Which artifact dir matched. */
  kind: "deck" | "page";
}

/** Match a HOME-VOLUME-relative entry path (org-fs change feed shape). */
export function matchHtmlArtifactEntry(
  entryPath: string,
): HtmlArtifactRef | null {
  const m = DECK_ENTRY_PATTERN.exec(entryPath);
  if (!m) return null;
  return {
    path: entryPath,
    name: m[2]!,
    kind: m[1]!.toLowerCase() === "decks" ? "deck" : "page",
  };
}

/** Minimal shape of an org-fs change-feed entry the watcher inspects. */
export interface HtmlArtifactChangeEntry {
  kind: "file" | "dir";
  deletedAt: string | null;
  /** Actor of the change (org-fs `updated_by`). */
  updatedBy: string;
  /** Chat/run that wrote it (org-fs `thread_id`); null when not thread-tied. */
  threadId: string | null;
  /** Volume-relative path. */
  path: string;
}

export interface HtmlArtifactEmitScope {
  /** The current run's thread id — entries it stamped always belong here. */
  threadId: string | null;
  /**
   * The run owner's user id — fallback scope for entries with no thread stamp.
   * Bash/slides decks reach org-fs via the mount write-back, decoupled from the
   * dispatch, so they can't be thread-attributed without changing the storage
   * path; scope them to the same user to at least block cross-member leaks.
   */
  ownerId: string;
}

/**
 * Decide whether a home-volume change-feed entry belongs to this run, and which
 * deck/page it is. The home volume is org-wide and shared across every chat and
 * member, so an entry another chat or user produced must not surface in this
 * run's live preview. Prefer exact thread provenance; fall back to same-user
 * when the entry carries no thread stamp. Returns null for foreign, deleted,
 * non-file, or non-deck entries.
 */
export function matchOwnHtmlArtifact(
  entry: HtmlArtifactChangeEntry,
  scope: HtmlArtifactEmitScope,
): HtmlArtifactRef | null {
  if (entry.kind !== "file" || entry.deletedAt) return null;
  const ownedByThread =
    scope.threadId != null && entry.threadId === scope.threadId;
  const ownedByUserFallback =
    entry.threadId == null && entry.updatedBy === scope.ownerId;
  if (!ownedByThread && !ownedByUserFallback) return null;
  return matchHtmlArtifactEntry(entry.path);
}

/**
 * Match a SANDBOX tool path (`write`/`edit`/bash cwd-relative or absolute)
 * against the mounted deck dir, e.g. `org/home/decks/launch.html` or
 * `/app/repo/org/home/decks/launch.html`. `homeMountPath` is the fixed `home`
 * (kept as a param so the matcher stays pure/testable). Returns the
 * volume-relative ref.
 */
export function matchHtmlArtifactToolPath(
  rawPath: string,
  homeMountPath: string,
): HtmlArtifactRef | null {
  if (!homeMountPath) return null;
  const normalized = rawPath.replace(/^\.\//, "");
  const marker = `org/${homeMountPath}/`;
  const idx = normalized.indexOf(marker);
  if (idx !== 0 && (idx < 0 || normalized[idx - 1] !== "/")) return null;
  return matchHtmlArtifactEntry(normalized.slice(idx + marker.length));
}
