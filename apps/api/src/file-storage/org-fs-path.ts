import { sanitizeKey } from "../object-storage/key-utils";

/**
 * Pure path helpers for the org filesystem. Paths are normalized to
 * slash-separated, no leading/trailing slash, no `.`/`..` segments. "" is the
 * volume root. Kept dependency-free so they're unit-testable.
 */

const VOLUME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** Storage-key prefix that isolates fs objects from other primitive-fs keys. */
const FS_KEY_NAMESPACE = "_fs";

export function isValidVolume(volume: string): boolean {
  // The regex alone accepts "." and ".." (both are valid `[A-Za-z0-9_.-]`
  // runs). Either would make `fsObjectKey` emit `_fs/./...` / `_fs/../...`,
  // which `sanitizeKey`/`buildS3Key` then collapse — popping the `_fs`
  // segment entirely and landing the write/read directly under the org's
  // storage prefix, colliding with unrelated (non-org-fs) keys.
  return VOLUME_RE.test(volume) && volume !== "." && volume !== "..";
}

export function assertValidVolume(volume: string): void {
  if (!isValidVolume(volume)) {
    throw new Error(`Invalid org-fs volume name: ${JSON.stringify(volume)}`);
  }
}

/** Traversal-safe normalization. Reuses the storage-key sanitizer. */
export function normalizeFsPath(raw: string): string {
  return sanitizeKey(raw);
}

/** Parent directory of a normalized path ("" for top-level / root). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Last path segment ("" for root). */
export function basenameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Ancestor directories of a path, top-down, excluding the root ("") and the
 * path itself. `a/b/c.txt` → `["a", "a/b"]`.
 */
export function ancestorsOf(path: string): string[] {
  const parent = parentOf(path);
  if (parent === "") return [];
  const segments = parent.split("/");
  const out: string[] = [];
  let acc = "";
  for (const seg of segments) {
    acc = acc === "" ? seg : `${acc}/${seg}`;
    out.push(acc);
  }
  return out;
}

/** Object-storage key (within the org prefix) for a volume path. */
export function fsObjectKey(volume: string, path: string): string {
  return `${FS_KEY_NAMESPACE}/${volume}/${path}`;
}

/** Storage-key prefix for an entire volume (trailing slash). */
export function fsVolumePrefix(volume: string): string {
  return `${FS_KEY_NAMESPACE}/${volume}/`;
}
