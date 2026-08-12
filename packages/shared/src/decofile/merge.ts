import { decodeUntilStable } from "./block-key";

/**
 * On-disk name of the merged decofile artifact and its sibling source
 * directory. `.deco/blocks.gen.json` is the runtime's merge of every
 * `.deco/blocks/*.json`; many repos gitignore it (a multi-MB single line that
 * conflicts on every content PR and is regenerated on build).
 */
export const GEN_BASENAME = "blocks.gen.json";
export const BLOCKS_DIRNAME = "blocks";

/**
 * Matches repo-relative paths of decofile block sources. Case-insensitive so a
 * case-insensitive filesystem (or a tree entry named `.JSON`) can't smuggle a
 * block past validation. Mirrors the Go daemon's `blockRe`
 * (packages/sandbox/daemon-go/internal/decofile/decofile.go).
 */
export const BLOCK_PATH_RE = /(^|\/)\.deco\/blocks\/.+\.json$/i;

export interface BlockFile {
  /** Filename stem — the basename minus its `.json` extension, NOT decoded. */
  stem: string;
  /** Raw file contents (must be a JSON value; whitespace is trimmed). */
  content: string;
}

/**
 * Merge block files into the decofile document:
 * `{ [decodeUntilStable(stem)]: <raw file contents> }`, sorted by filename for
 * a deterministic, byte-for-byte result identical to the Go daemon's merge.
 *
 * The merged text is built by splicing raw contents rather than
 * parse/stringify round-tripping — the payload is routinely multi-MB, and the
 * merge is deliberately all-or-nothing: one malformed block makes the whole
 * document unparseable rather than silently rendering a partial site.
 * Callers that need per-block validity check it at write time instead.
 */
export function mergeBlocks(files: BlockFile[]): string {
  // Sort by full filename (stem + ".json"), matching the Go implementation's
  // `sort.Strings(names)` — stem order and filename order can differ around
  // characters that sort before ".".
  const sorted = [...files].sort((a, b) => {
    const an = `${a.stem}.json`;
    const bn = `${b.stem}.json`;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  let out = "{";
  let first = true;
  for (const file of sorted) {
    const content = file.content.trim();
    // Skip empty files — `"key":` with no value would break the merged JSON.
    if (content.length === 0) continue;
    if (!first) out += ",";
    first = false;
    out += `${JSON.stringify(decodeUntilStable(file.stem))}:${content}`;
  }
  return `${out}}`;
}
