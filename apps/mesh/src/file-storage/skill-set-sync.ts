/**
 * Syncs public skill sets (file-storage/public-sets.ts) from their GitHub
 * repos into the shared org-fs volumes.
 *
 * Source: the repo's codeload tarball at a pinned ref — no git binary, no
 * clone dir. Each configured `paths[{from,to}]` maps a repo subtree into the
 * volume. Diff: the manifest already stores SHA-256 per file, so a re-sync
 * costs one tarball download + hash comparison; only changed/new files are
 * written and only vanished ones deleted. Running sandboxes pick changes up
 * in ~1s via the change feed (the mount invalidator).
 *
 * Runs on a DBOS scheduled workflow (dbos-public-sets-sync.ts) so exactly one
 * pod owns each tick, and on demand via the ORG_FS_PUBLIC_SETS_SYNC tool.
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Kysely } from "kysely";
import type { Database } from "../storage/types";
import { OrgFsEntryStorage } from "../storage/org-fs";
import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "../object-storage/factory";
import { detectContentType } from "../object-storage/key-utils";
import { OrgFs } from "./org-fs";
import { normalizeFsPath } from "./org-fs-path";
import {
  getPublicSets,
  ORG_FS_PUBLIC_ORG_ID,
  type PublicSkillSetSource,
  publicVolumeForSet,
} from "./public-sets";

const SYNC_ACTOR = "system:skill-set-sync";
/** Tarballs of skill repos are small; refuse anything suspicious. */
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;
/** Decompression ceiling (gzip bombs expand far beyond the download size). */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

// --- minimal tar reader ------------------------------------------------------
// GitHub tarballs are ustar with pax extension headers. We only need regular
// files; pax/global headers and GNU longnames are consumed and applied where
// they matter (long paths), everything else is skipped.

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const raw = readString(block, offset, length).trim();
  return raw === "" ? 0 : Number.parseInt(raw, 8);
}

/** Parse a tar archive into path → bytes (regular files only). */
export function parseTar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let pos = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  while (pos + 512 <= tar.length) {
    const block = tar.subarray(pos, pos + 512);
    pos += 512;
    // two zero blocks = end of archive; a zero name means an empty block
    if (block.every((b) => b === 0)) break;
    let name = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = readOctal(block, 124, 12);
    const typeflag = String.fromCharCode(block[156] ?? 0);
    const data = tar.subarray(pos, pos + size);
    pos += Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      // GNU longname: data carries the next entry's path (NUL-padded)
      const text = new TextDecoder().decode(data);
      const nul = text.indexOf("\0");
      pendingLongName = nul === -1 ? text : text.slice(0, nul);
      continue;
    }
    if (typeflag === "x") {
      // pax header: may carry `path=` for the next entry
      const text = new TextDecoder().decode(data);
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
      pendingPaxPath = m?.[1] ?? null;
      continue;
    }
    if (typeflag === "g") continue; // global pax header (ref metadata)

    const effectiveName = pendingPaxPath ?? pendingLongName ?? name;
    pendingLongName = null;
    pendingPaxPath = null;
    // regular file ("0" or NUL)
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      files.set(effectiveName, new Uint8Array(data));
    }
  }
  return files;
}

// --- sync --------------------------------------------------------------------

/** Fetch `owner/repo@ref` and return files keyed by repo-relative path. */
async function fetchRepoFiles(
  repo: string,
  ref: string,
): Promise<Map<string, Uint8Array>> {
  const url = `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  // Bound the whole download — a stalled codeload socket would otherwise hang
  // this sync cycle (and the boot loop's first iteration) indefinitely.
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(
      `tarball fetch failed for ${repo}@${ref}: HTTP ${res.status}`,
    );
  }
  // Refuse before buffering when the server declares the size; the
  // post-download check stays as the backstop for chunked responses.
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_TARBALL_BYTES) {
    throw new Error(
      `tarball for ${repo}@${ref} declares ${declared} bytes (cap ${MAX_TARBALL_BYTES})`,
    );
  }
  const gz = new Uint8Array(await res.arrayBuffer());
  if (gz.length > MAX_TARBALL_BYTES) {
    throw new Error(
      `tarball for ${repo}@${ref} exceeds ${MAX_TARBALL_BYTES} bytes`,
    );
  }
  // maxOutputLength bounds decompression (a gzip bomb throws instead of OOM).
  const raw = parseTar(
    new Uint8Array(gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES })),
  );
  // strip the tarball's single top-level `<repo>-<ref>/` dir
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of raw) {
    const slash = path.indexOf("/");
    if (slash === -1) continue;
    const rel = path.slice(slash + 1);
    if (rel) files.set(rel, bytes);
  }
  return files;
}

/**
 * Apply the set's `paths` mapping: repo files → desired volume tree. Keys are
 * normalized exactly like `OrgFs.write` stores them — otherwise a filename
 * that changes under normalization never matches its manifest entry and gets
 * rewritten+deleted every cycle.
 */
export function planVolumeTree(
  repoFiles: Map<string, Uint8Array>,
  paths: PublicSkillSetSource["paths"],
): Map<string, Uint8Array> {
  const desired = new Map<string, Uint8Array>();
  for (const { from, to } of paths) {
    const prefix = from === "" ? "" : `${from.replace(/\/+$/, "")}/`;
    for (const [path, bytes] of repoFiles) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const normalized = normalizeFsPath(to ? `${to}/${rest}` : rest);
      if (normalized) desired.set(normalized, bytes);
    }
  }
  return desired;
}

/**
 * Dirs with no remaining desired file beneath them, shallowest-first with
 * covered descendants dropped — each survivor is one recursive delete.
 */
export function staleDirs(
  desiredFiles: Iterable<string>,
  currentDirs: Iterable<string>,
): string[] {
  const needed = new Set<string>();
  for (const file of desiredFiles) {
    const segs = file.split("/");
    for (let i = 1; i < segs.length; i++) {
      needed.add(segs.slice(0, i).join("/"));
    }
  }
  const stale = [...currentDirs]
    .filter((d) => !needed.has(d))
    .sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const d of stale) {
    if (!roots.some((r) => d.startsWith(`${r}/`))) roots.push(d);
  }
  return roots;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface SyncResult {
  set: string;
  written: number;
  deleted: number;
  unchanged: number;
}

/** Sync one set into its shared volume. Throws on fetch/storage failure. */
async function syncPublicSet(
  db: Kysely<Database>,
  source: PublicSkillSetSource,
  opts: { baseUrl: string },
): Promise<SyncResult> {
  const s3Service = getObjectStorageS3Service();
  const storage = s3Service
    ? createBoundObjectStorage(s3Service, ORG_FS_PUBLIC_ORG_ID)
    : new DevObjectStorage(ORG_FS_PUBLIC_ORG_ID, opts.baseUrl);
  const manifest = new OrgFsEntryStorage(db);
  const fs = new OrgFs(storage, manifest, ORG_FS_PUBLIC_ORG_ID);
  const volume = publicVolumeForSet(source.set);

  const desired = planVolumeTree(
    await fetchRepoFiles(source.repo, source.ref),
    source.paths,
  );
  const current = new Map(
    (await manifest.listVolumeFiles(ORG_FS_PUBLIC_ORG_ID, volume)).map((e) => [
      e.path,
      e.contentHash,
    ]),
  );

  // An upstream dir rename or config typo yields an empty desired tree from a
  // perfectly successful fetch — refuse to wipe a live set over it.
  if (desired.size === 0 && current.size > 0) {
    throw new Error(
      `set "${source.set}" resolved 0 files from ${source.repo}@${source.ref} ` +
        `(check paths config) — refusing to delete the ${current.size} existing files`,
    );
  }

  // Deletes (and the dir prune) run BEFORE writes: when a path changes kind
  // upstream (dir → file or file → dir) the stale entry must be cleared first
  // or the conflicting write fails — and re-fails every cycle, wedging the
  // sync. Cost: a renamed path is briefly absent mid-sync instead of briefly
  // duplicated.
  let deleted = 0;
  for (const path of current.keys()) {
    if (desired.has(path)) continue;
    await fs.delete(volume, path, { actor: SYNC_ACTOR });
    deleted++;
  }
  // Prune dirs with no desired file beneath them (file tombstones don't touch
  // the parent dir entries; each stale root deletes its whole subtree).
  const dirs = await manifest.listVolumeDirs(ORG_FS_PUBLIC_ORG_ID, volume);
  for (const dir of staleDirs(
    desired.keys(),
    dirs.map((d) => d.path),
  )) {
    await fs.delete(volume, dir, { actor: SYNC_ACTOR });
  }
  let written = 0;
  let unchanged = 0;
  for (const [path, bytes] of desired) {
    if (current.get(path) === sha256Hex(bytes)) {
      unchanged++;
      continue;
    }
    await fs.write(volume, path, bytes, {
      actor: SYNC_ACTOR,
      contentType: detectContentType(path),
      // System-owned shared content is exempt from per-volume quotas.
      skipVolumeQuota: true,
    });
    written++;
  }
  return { set: source.set, written, deleted, unchanged };
}

/** `syncPublicSet` with failure folded into the result (never throws). */
export async function syncPublicSetSafe(
  db: Kysely<Database>,
  source: PublicSkillSetSource,
  opts: { baseUrl: string },
): Promise<SyncResult | { set: string; error: string }> {
  try {
    return await syncPublicSet(db, source, opts);
  } catch (err) {
    return {
      set: source.set,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Sync every configured set; failures are per-set (one bad repo never
 *  blocks the others). Returns per-set results or error messages. */
export async function syncAllPublicSets(
  db: Kysely<Database>,
  opts: { baseUrl: string },
): Promise<Array<SyncResult | { set: string; error: string }>> {
  const results: Array<SyncResult | { set: string; error: string }> = [];
  for (const source of getPublicSets()) {
    results.push(await syncPublicSetSafe(db, source, opts));
  }
  return results;
}
