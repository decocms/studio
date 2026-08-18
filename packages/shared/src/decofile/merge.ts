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

/** A block omitted from the merged document because it was not valid JSON. */
export interface SkippedBlock {
  /** The decoded key the block would have been emitted under. */
  key: string;
  /** Filename stem — NOT decoded (identifies the source file). */
  stem: string;
  /** The JSON parse error that disqualified the block. */
  error: string;
}

export interface MergeResult {
  /** The merged decofile document — always valid JSON text. */
  decofile: string;
  /** Blocks dropped because their content did not parse as JSON. */
  skipped: SkippedBlock[];
}

/**
 * Merge block files into `{ [decodeUntilStable(stem)]: <raw contents> }`, sorted
 * by filename — byte-for-byte identical to the Go daemon's merge for valid input.
 * A block that is not valid JSON is dropped (reported in `skipped`) instead of
 * spliced raw, which would make the whole document unparseable.
 */
export function mergeBlocks(files: BlockFile[]): MergeResult {
  // Sort by full filename (stem + ".json"), matching the Go daemon; computed once per file, not per comparison.
  const sorted = files
    .map((file) => ({ file, name: `${file.stem}.json` }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const skipped: SkippedBlock[] = [];
  let out = "{";
  let first = true;
  for (const { file } of sorted) {
    const content = file.content.trim();
    // Skip empty files — `"key":` with no value would break the merged JSON.
    if (content.length === 0) continue;
    // Parse only to validate; the raw text (not a re-stringify) is spliced.
    try {
      JSON.parse(content);
    } catch (err) {
      skipped.push({
        key: decodeUntilStable(file.stem),
        stem: file.stem,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!first) out += ",";
    first = false;
    out += `${JSON.stringify(decodeUntilStable(file.stem))}:${content}`;
  }
  return { decofile: `${out}}`, skipped };
}
