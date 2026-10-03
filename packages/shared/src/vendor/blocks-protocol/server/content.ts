/**
 * Turns a storage snapshot (files and versions) into the entry map, applying
 * the one file-name rule: decode once, resolve spellings, report the rest.
 * Shared by `blocks.list` (which needs every body) and `blocks.apply` (which
 * needs bodies only to break ties between spellings).
 */
import { limitExceeded, unavailable } from "../errors";
import {
  entryHasPath,
  fullyDecodeFileName,
  isBlockFileName,
  resolveSpellings,
} from "../keys";
import type { ContentStorage, StorageFile, StorageSnapshot } from "../storage";
import type { Diagnostic, Limits } from "../types";
import { type BodyCache, type ParsedBody, parseBody } from "./body-cache";

export interface LoadedEntry {
  file: string;
  version: string;
  /** The parsed entry; absent when the body wasn't needed. */
  value?: Record<string, unknown>;
}

export interface LoadedContent {
  snapshot: StorageSnapshot;
  /** Every entry, by name, in file-name order of the winning files. */
  entries: Map<string, LoadedEntry>;
  /** Every saved-block file, valid or not, by spelling key. */
  groups: Map<string, StorageFile[]>;
  /** Files skipped or shadowed. */
  diagnostics: Diagnostic[];
  /** Uncompressed bytes of the bodies read. */
  bytes: number;
  /**
   * True when a body read didn't match the snapshot (the file changed or
   * vanished in between): the content isn't one consistent snapshot, so the
   * caller takes a new one.
   */
  moved: boolean;
}

interface Options {
  /** Read every body (`blocks.list`), not only the ones that break ties. */
  readAll: boolean;
  limits: Limits;
  cache: BodyCache;
}

async function loadContent(
  storage: ContentStorage,
  snapshot: StorageSnapshot,
  { readAll, limits, cache }: Options,
): Promise<LoadedContent> {
  const files = snapshot.files.filter((f) => isBlockFileName(f.file));
  const groups = new Map<string, StorageFile[]>();
  for (const file of files) {
    const key = fullyDecodeFileName(file.file).name;
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }

  const diagnostics: Diagnostic[] = [];
  let moved = false;
  const parsed = new Map<string, ParsedBody>();
  const toRead: StorageFile[] = [];
  let knownBytes = 0;
  for (const group of groups.values()) {
    if (!readAll && group.length < 2) continue;
    for (const file of group) {
      // An existing file over maxBlockBytes is unreadable, like invalid JSON: it's
      // left out of the map and reported as a `too-large` diagnostic, so one
      // oversized hand edit can't take the whole editor down. The map plus its
      // diagnostics still accounts for every file in the snapshot; only the
      // aggregate (maxListBytes) answers LimitExceeded.
      if (file.size !== undefined && file.size > limits.maxBlockBytes) {
        parsed.set(file.file, {
          ok: false,
          kind: "too-large",
          bytes: file.size,
          message: `the file is over ${limits.maxBlockBytes} bytes`,
        });
        continue;
      }
      knownBytes += file.size ?? 0;
      const hit = cache.get(file.file, file.version);
      if (hit) parsed.set(file.file, hit);
      else toRead.push(file);
    }
  }
  if (readAll && knownBytes > limits.maxListBytes) {
    throw limitExceeded(`the block list is over ${limits.maxListBytes} bytes`, {
      limit: "maxListBytes",
    });
  }
  if (toRead.length > 0) {
    const bodies = await storage.readFiles(
      snapshot,
      toRead.map((f) => f.file),
    );
    for (const file of toRead) {
      const read = bodies[file.file];
      if (read === undefined) {
        moved = true; // vanished since the snapshot
        continue;
      }
      const body = parseBody(read.text, limits.maxBlockBytes);
      // Cache under the version of the bytes actually read, never the snapshot's.
      cache.set(file.file, read.version, body);
      if (read.version !== file.version) {
        moved = true;
        continue;
      }
      parsed.set(file.file, body);
    }
  }

  let bytes = 0;
  const candidates: Array<
    StorageFile & { hasPath: boolean; value?: Record<string, unknown> }
  > = [];
  for (const file of files) {
    const body = parsed.get(file.file);
    if (body === undefined) {
      // Not read: a single spelling whose body wasn't needed, or a file that vanished.
      if (!readAll) candidates.push({ ...file, hasPath: false });
      continue;
    }
    if (!body.ok) {
      diagnostics.push({
        file: file.file,
        kind: body.kind,
        message: body.message,
      });
      continue;
    }
    bytes += body.bytes;
    candidates.push({
      ...file,
      hasPath: entryHasPath(body.value),
      value: body.value,
    });
  }
  if (readAll && bytes > limits.maxListBytes) {
    throw limitExceeded(`the block list is over ${limits.maxListBytes} bytes`, {
      limit: "maxListBytes",
    });
  }

  const entries = new Map<string, LoadedEntry>();
  for (const { name, winner, shadowed } of resolveSpellings(
    candidates,
  ).values()) {
    entries.set(name, {
      file: winner.file,
      version: winner.version,
      value: winner.value,
    });
    for (const loser of shadowed) {
      diagnostics.push({
        file: loser.file,
        kind: "shadowed",
        name,
        winner: winner.file,
        message: `another spelling of "${name}" wins: ${winner.file}`,
      });
    }
  }
  diagnostics.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { snapshot, entries, groups, diagnostics, bytes, moved };
}

/** How many snapshots a read takes before giving up on files that keep changing. */
const MAX_SNAPSHOT_READS = 3;

/**
 * Takes a snapshot and loads its content, taking a new snapshot when a file
 * changed while its body was being read, so the bodies always match the
 * versions and revision they're reported with. `shortCircuit` can end the
 * read right after the snapshot (a conditional read that's "not modified").
 */
export async function loadCurrentContent(
  storage: ContentStorage,
  ref: string | undefined,
  options: Options,
  shortCircuit?: (snapshot: StorageSnapshot) => boolean,
): Promise<{ snapshot: StorageSnapshot; content: LoadedContent | null }> {
  for (let read = 1; read <= MAX_SNAPSHOT_READS; read++) {
    const snapshot = await storage.snapshot({ ref });
    if (shortCircuit?.(snapshot)) return { snapshot, content: null };
    const content = await loadContent(storage, snapshot, options);
    if (!content.moved) return { snapshot, content };
  }
  throw unavailable(
    "saved blocks kept changing while being read; retry shortly",
    250,
  );
}
