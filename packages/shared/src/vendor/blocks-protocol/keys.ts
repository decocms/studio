/**
 * The one file-name rule for saved blocks (`@decocms/blocks/protocol/keys`).
 *
 * The site editor, `deco serve` and `deco content` all import this module, so
 * an entry the site editor edits is the entry the app renders:
 *
 * - **Name to file:** `encodeURIComponent(name) + ".json"`, directly in
 *   `.deco/blocks` (no subfolders).
 * - **File to name:** decode the file name, without `.json`, exactly once. If
 *   decoding fails, the raw name is the entry name.
 * - **Two spellings of one name** (files that decode to the same name after
 *   repeated decoding): one wins — the file whose entry has a `path`, then the
 *   one that took more decoding, then the lowest file name. The others are
 *   reported as diagnostics; a write overwrites the winning spelling and
 *   deletes the others in the same commit.
 * - **File content:** `JSON.stringify(entry, null, 2)` plus a newline, UTF-8.
 *
 * Ported from the v7 `blocks-cli/scripts/lib/blocks-dedupe.ts` and
 * `blocks/src/cms/loadDecofileDirectory.ts` (`parseBlockId`), with the mtime
 * tie-break dropped: a fresh clone gives every file the same mtime, and the
 * rule must give the same answer on GitHub, where there is no mtime.
 *
 * Browser-safe: no Node APIs.
 */

/** The extension every saved-block file carries. */
export const BLOCK_FILE_EXTENSION = ".json";

/**
 * The longest encoded name (without `.json`) the site editor can save, so the
 * file fits a 255-byte file-name limit.
 */
export const MAX_ENCODED_NAME_BYTES = 250;

/** Windows device names: a file whose stem is one of these can't be created on Windows. */
const WINDOWS_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Extensions of source modules: a saved block ending in one would shadow a module. */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const utf8 = new TextEncoder();

/** `encodeURIComponent(name) + ".json"`: the file a saved block named `name` is stored in. */
export function blockFileName(name: string): string {
  return `${encodeURIComponent(name)}${BLOCK_FILE_EXTENSION}`;
}

/**
 * True when `file` is a saved-block file name: it ends in `.json`, has a stem,
 * isn't in a folder and isn't a dotfile (hidden files are never entries).
 */
export function isBlockFileName(file: string): boolean {
  return (
    file.endsWith(BLOCK_FILE_EXTENSION) &&
    !file.startsWith(".") &&
    file.length > BLOCK_FILE_EXTENSION.length &&
    !file.includes("/") &&
    !file.includes("\\")
  );
}

function stem(file: string): string {
  return file.endsWith(BLOCK_FILE_EXTENSION)
    ? file.slice(0, -BLOCK_FILE_EXTENSION.length)
    : file;
}

/**
 * The entry name stored in `file`: the stem decoded exactly once. A stem that
 * isn't valid percent-encoding (a page literally named `50% off`) is the name
 * as it stands.
 */
export function blockNameFromFile(file: string): string {
  const raw = stem(file);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Decodes `file`'s stem repeatedly until it stops changing, returning the
 * fully decoded name (the spelling-group key) and how many decodes it took.
 */
export function fullyDecodeFileName(file: string): {
  name: string;
  passes: number;
} {
  let name = stem(file);
  let passes = 0;
  while (name.includes("%")) {
    let next: string;
    try {
      next = decodeURIComponent(name);
    } catch {
      break;
    }
    if (next === name) break;
    name = next;
    passes++;
  }
  return { name, passes };
}

/** The spelling-group key of a saved-block name: every file of the group decodes to it. */
export function spellingKey(name: string): string {
  return fullyDecodeFileName(blockFileName(name)).name;
}

/** `JSON.stringify(entry, null, 2)` plus a newline: the bytes a saved block is stored as. */
export function serializeBlock(entry: unknown): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

/** True when a parsed entry is a page-like entry: it has a non-empty string `path`. */
export function entryHasPath(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof (entry as { path?: unknown }).path === "string" &&
    (entry as { path: string }).path.length > 0
  );
}

/** One file that holds (a spelling of) a saved block. */
export interface SpellingCandidate {
  file: string;
  /** Whether the file's entry has a non-empty `path`. */
  hasPath: boolean;
}

/** Orders two spellings of one name: negative when `a` wins. */
export function compareSpellings(
  a: SpellingCandidate,
  b: SpellingCandidate,
): number {
  if (a.hasPath !== b.hasPath) return a.hasPath ? -1 : 1;
  const passesA = fullyDecodeFileName(a.file).passes;
  const passesB = fullyDecodeFileName(b.file).passes;
  if (passesA !== passesB) return passesB - passesA;
  if (a.file === b.file) return 0;
  return a.file < b.file ? -1 : 1;
}

/** The winner of one spelling group and the files it shadows. */
export interface ResolvedSpelling<
  T extends SpellingCandidate = SpellingCandidate,
> {
  /** The entry name: the winning file's stem decoded exactly once. */
  name: string;
  winner: T;
  /** The other spellings, best first. */
  shadowed: T[];
}

/**
 * Groups candidate files by spelling key and picks one winner per group.
 * Returns the groups keyed by entry name, in file-name order of the winners.
 */
export function resolveSpellings<T extends SpellingCandidate>(
  candidates: readonly T[],
): Map<string, ResolvedSpelling<T>> {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = fullyDecodeFileName(candidate.file).name;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const winners: ResolvedSpelling<T>[] = [];
  for (const group of groups.values()) {
    const [winner, ...shadowed] = [...group].sort(compareSpellings);
    if (!winner) continue;
    winners.push({ name: blockNameFromFile(winner.file), winner, shadowed });
  }
  winners.sort((a, b) =>
    a.winner.file < b.winner.file ? -1 : a.winner.file > b.winner.file ? 1 : 0,
  );
  return new Map(winners.map((w) => [w.name, w]));
}

/** Why a name can't be saved. */
export type NameViolationReason =
  | "empty"
  | "invalid-character"
  | "dot-dot"
  | "leading-dot"
  | "too-long"
  | "case-collision"
  | "device-name"
  | "reserved"
  | "source-extension";

export interface NameViolation {
  reason: NameViolationReason;
  message: string;
}

export interface NameCheckOptions {
  /**
   * The names of the entries that already exist. A name that isn't one of
   * them is new, and a new name that differs from an existing one only in
   * letter case is refused.
   */
  existingNames?: Iterable<string>;
}

/**
 * Checks whether the site editor may save an entry under `name`. Returns
 * every rule the name breaks (empty when it can be saved).
 */
export function checkBlockName(
  name: string,
  options: NameCheckOptions = {},
): NameViolation[] {
  const violations: NameViolation[] = [];
  if (name.length === 0) {
    return [{ reason: "empty", message: "the name is empty" }];
  }
  if (name.includes("\\") || name.includes("\0")) {
    violations.push({
      reason: "invalid-character",
      message: "the name contains a backslash or a NUL character",
    });
  }
  if (name.includes("..")) {
    violations.push({ reason: "dot-dot", message: 'the name contains ".."' });
  }
  if (name.startsWith(".")) {
    violations.push({
      reason: "leading-dot",
      message: 'the name starts with ".", which would make its file hidden',
    });
  }
  if (name === "__proto__") {
    violations.push({
      reason: "reserved",
      message: 'the name "__proto__" is reserved',
    });
  }
  const encoded = encodeURIComponent(name);
  if (utf8.encode(encoded).byteLength > MAX_ENCODED_NAME_BYTES) {
    violations.push({
      reason: "too-long",
      message: `the encoded name is over ${MAX_ENCODED_NAME_BYTES} bytes`,
    });
  }
  const deviceStem = encoded.split(".")[0]!.toUpperCase();
  if (WINDOWS_DEVICE_NAMES.has(deviceStem)) {
    violations.push({
      reason: "device-name",
      message: `"${deviceStem}" is a Windows device name`,
    });
  }
  const lower = name.toLowerCase();
  const extension = SOURCE_EXTENSIONS.find((ext) => lower.endsWith(ext));
  if (extension) {
    violations.push({
      reason: "source-extension",
      message: `the name ends in "${extension}", which would shadow a source module`,
    });
  }
  if (options.existingNames) {
    let isNew = true;
    let collidesWith: string | undefined;
    for (const existing of options.existingNames) {
      if (existing === name) {
        isNew = false;
        break;
      }
      if (collidesWith === undefined && existing.toLowerCase() === lower)
        collidesWith = existing;
    }
    if (isNew && collidesWith !== undefined) {
      violations.push({
        reason: "case-collision",
        message: `the name differs from the existing entry "${collidesWith}" only in letter case`,
      });
    }
  }
  return violations;
}

/** Checks a name a write deletes: anything non-empty can be deleted. */
export function checkDeletedName(name: string): NameViolation[] {
  return name.length === 0
    ? [{ reason: "empty", message: "the name is empty" }]
    : [];
}
