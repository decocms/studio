/**
 * Decofile block files (`.deco/blocks/*.json`) are machine-managed pure JSON —
 * never JSONC — and a single malformed one breaks the entire site render (the
 * runtime can't parse it). The section editor's save path builds a whole object
 * and `JSON.stringify`s it, so it can never emit invalid JSON. But the daemon's
 * text write/edit endpoints (`/write`, `/edit`) mutate file *bytes* directly —
 * an imprecise `edit` (e.g. unwrapping a multivariate variant while leaving its
 * `"rule": {…}` sibling dangling inside an array, plus an unbalanced brace)
 * produces syntactically invalid JSON. The publish/shutdown-sync path then
 * commits those exact bytes verbatim, so the corruption lands on the branch.
 *
 * These helpers gate BOTH ends: the write/edit handlers reject a mutation that
 * would leave a block invalid (keeps the working tree clean), and publish()
 * refuses to commit an invalid block (last-resort net for any mutation that
 * bypassed those handlers).
 *
 * Scoped to `.deco/blocks/*.json` on purpose: those are small, pure JSON, and
 * the exact corruption surface. It deliberately does NOT touch JSONC configs
 * (`tsconfig.json` allows comments) or the multi-MB `.deco/*.gen.json` artifacts
 * (parsing those synchronously would risk the daemon's event loop).
 *
 * The frontend has its own `.deco/blocks` vocabulary
 * (`apps/mesh/.../sections-editor/deco-block-key.ts`); the daemon can't import
 * across that process boundary, so this small predicate is intentionally
 * independent, not accidental duplication.
 */

// Case-insensitive: on case-insensitive filesystems (macOS/Windows) an
// `.deco/blocks/x.JSON` must not slip past the "last-resort net".
const DECOFILE_BLOCK_RE = /(^|\/)\.deco\/blocks\/.+\.json$/i;

/** True when `relPath` points at a decofile block JSON file. */
export function isDecofileBlockPath(relPath: string): boolean {
  return DECOFILE_BLOCK_RE.test(relPath.replace(/\\/g, "/"));
}

/**
 * Returns an error string when `content` for a decofile block path is not valid
 * JSON; null when the path is out of scope or the JSON is well-formed.
 */
export function invalidDecofileBlockJson(
  relPath: string,
  content: string,
): string | null {
  const normalized = relPath.replace(/\\/g, "/");
  if (!isDecofileBlockPath(normalized)) return null;
  try {
    JSON.parse(content);
    return null;
  } catch (e) {
    return `invalid JSON in decofile block "${normalized}": ${(e as Error).message}`;
  }
}
