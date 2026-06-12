/**
 * Live-HTML path matching — pure logic shared by the cluster deck watcher
 * (org-fs change-feed entries) and any tool-path detection.
 *
 * Convention: HTML artifacts the user should see live in the org home
 * volume, which sandboxes see mounted at `org/<homeMountPath>/`:
 *   - `decks/<name>.html` — presentation decks (the `slides` skill)
 *   - `pages/<name>.html` — standalone pages (landing pages, one-pagers)
 * The Studio web UI previews (and for decks, edits) the same files.
 */

const DECK_ENTRY_PATTERN = /^(decks|pages)\/([a-z0-9][a-z0-9._-]*)\.html$/i;

export interface DeckRef {
  /** Volume-relative path, e.g. `decks/q3-launch.html`. */
  path: string;
  /** File stem, e.g. `q3-launch`. */
  name: string;
  /** Which artifact dir matched. */
  kind: "deck" | "page";
}

/** Match a HOME-VOLUME-relative entry path (org-fs change feed shape). */
export function matchDeckEntryPath(entryPath: string): DeckRef | null {
  const m = DECK_ENTRY_PATTERN.exec(entryPath);
  if (!m) return null;
  return {
    path: entryPath,
    name: m[2]!,
    kind: m[1]!.toLowerCase() === "decks" ? "deck" : "page",
  };
}

/**
 * Match a SANDBOX tool path (`write`/`edit`/bash cwd-relative or absolute)
 * against the mounted deck dir, e.g. `org/acme/decks/launch.html` or
 * `/app/repo/org/acme/decks/launch.html`. Returns the volume-relative ref.
 */
export function matchDeckToolPath(
  rawPath: string,
  homeMountPath: string,
): DeckRef | null {
  if (!homeMountPath) return null;
  const normalized = rawPath.replace(/^\.\//, "");
  const marker = `org/${homeMountPath}/`;
  const idx = normalized.indexOf(marker);
  if (idx !== 0 && (idx < 0 || normalized[idx - 1] !== "/")) return null;
  return matchDeckEntryPath(normalized.slice(idx + marker.length));
}
