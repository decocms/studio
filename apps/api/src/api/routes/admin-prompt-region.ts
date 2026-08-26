/**
 * The agent prompts stay HARDCODED in TypeScript — the admin prompt editor
 * never moves them into the database. What it edits is the source region
 * between a pair of marker comments, read from and written back to
 * `decocms/studio` over the GitHub API.
 *
 * A marked region is the only thing that makes that safe: without it the editor
 * would have to round-trip a 600-line source file through a textarea, and any
 * stray keystroke outside the prompt would ship as a code change.
 *
 * Pure (no I/O) so the splice — the part that can silently corrupt a source
 * file — is unit-tested. See `admin-prompts.ts` for the registry and the
 * commit/PR flow.
 */

const START = (id: string) => `// prompt-region:start ${id}`;
const END = (id: string) => `// prompt-region:end ${id}`;

/** Marker line bounds of `id` within `source`, or null when either is absent. */
function regionBounds(
  source: string,
  id: string,
): { from: number; to: number } | null {
  const start = source.indexOf(START(id));
  if (start === -1) return null;
  const from = source.indexOf("\n", start);
  if (from === -1) return null;
  const to = source.indexOf(END(id), from);
  if (to === -1) return null;
  // Back up to the newline ending the region's last content line, so the
  // marker's own indentation is never part of the body.
  const lineStart = source.lastIndexOf("\n", to);
  return { from: from + 1, to: lineStart + 1 };
}

/** The source text between `id`'s markers, or null when the region is gone. */
export function extractPromptRegion(source: string, id: string): string | null {
  const bounds = regionBounds(source, id);
  return bounds ? source.slice(bounds.from, bounds.to) : null;
}

/**
 * `source` with `id`'s region replaced by `body`. Throws when the region is
 * absent: a missing marker means the registry and the repo have drifted, and
 * appending the edit somewhere would be worse than refusing it.
 */
export function replacePromptRegion(
  source: string,
  id: string,
  body: string,
): string {
  const bounds = regionBounds(source, id);
  if (!bounds) {
    throw new Error(`prompt region "${id}" not found in source`);
  }
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  return source.slice(0, bounds.from) + normalized + source.slice(bounds.to);
}
