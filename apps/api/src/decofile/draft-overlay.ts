/**
 * Draft overlays for the GitHub backend (blocks docs:
 * /next/content-delivery#exact-draft-previews). A saved commit's preview is
 * not a whole decofile: it is the cumulative set of saved-block files the
 * draft changed since it left production, as an immutable manifest
 * `{format:1, set:{name: blockHash}, delete:[name]}` plus one asset per
 * changed block. The site layers it over the production content it already
 * has, so nothing here ever builds a complete draft snapshot.
 *
 * "Changed" is file-level draft wins: a file whose blob differs from the
 * merge base with the production branch replaces production's entry whole;
 * a file the draft deleted is a tombstone; every other file inherits
 * production. Only changed bodies are read, through the blob cache.
 *
 * Assets live in Studio's object storage under a reserved namespace that the
 * delivery routes (`api/routes/draft-delivery.ts`) read without a session or
 * the database. Blocks are uploaded before the manifest, and the manifest
 * before the commit's "prepared" marker, so a reader that finds the marker
 * finds everything it names.
 */

import {
  computeBlockHash,
  computeOverlayVersion,
  DRAFT_OVERLAY_FORMAT,
  type DraftOverlay,
  entryHasPath,
  fullyDecodeFileName,
  isBlockFileName,
  resolveSpellings,
} from "@decocms/blocks/protocol";
import { mapBounded } from "@decocms/shared/std";
import type { RepoContentClient } from "@/git-providers";
import {
  type BoundObjectStorage,
  createBoundObjectStorage,
} from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "../object-storage/factory";
import { isMissingObject } from "../object-storage/key-utils";
import {
  blockEntriesInTree,
  blocksDirPath,
  resolveBlockContents,
} from "./read-decofile";

/** The delivery host the SDK accepts draft pointers for (and only it). */
const DELIVERY_HOST = "delivery.decocms.com";

/** Cumulative changed-block bytes one overlay may carry (studio-implementation limits). */
export const MAX_OVERLAY_BLOCK_BYTES = 8 * 1024 * 1024;

const DELIVERY_STORAGE_ID = "deco_delivery";
const UPLOAD_CONCURRENCY = 8;
/** How long a preview request waits for an in-flight preparation. */
const PREPARE_WAIT_MS = 15_000;
const FAILURE_TTL_MS = 60_000;
const MAX_REMEMBERED = 1_000;

export const deliveryKeys = {
  manifest: (site: string, version: string) =>
    `sites/${site}/drafts/${version}.json`,
  block: (site: string, hash: string) =>
    `sites/${site}/draft-blocks/${hash}.json`,
  /** Not served: which overlay a saved commit prepared into. */
  prepared: (site: string, revision: string) =>
    `draft-commits/${site}/${revision}.json`,
};

let storage: BoundObjectStorage | undefined;
/** The object storage drafts are prepared into and delivered from. */
export function deliveryStorage(): BoundObjectStorage {
  if (storage) return storage;
  const s3 = getObjectStorageS3Service();
  storage = s3
    ? createBoundObjectStorage(s3, DELIVERY_STORAGE_ID)
    : new DevObjectStorage(DELIVERY_STORAGE_ID);
  return storage;
}

/** `?__draft=` pointer to one prepared overlay (blocks docs: /next/hosted-drafts). */
export function draftOverlayPointer(input: {
  site: string;
  version: string;
  grant: string;
}): string {
  return `${DELIVERY_HOST}/sites/${input.site}/drafts?token=${input.grant}@${input.version}`;
}

interface BlockFile {
  file: string;
  sha: string;
  /** Blob bytes, when the provider's tree reports them. */
  size?: number;
}

interface Winner extends BlockFile {
  name: string;
}

/** Saved-block files at `treeish`, grouped by spelling (every alias of one name). */
async function blockFiles(
  client: RepoContentClient,
  treeish: string,
  packagePath: string | null,
): Promise<Map<string, BlockFile[]>> {
  const tree = await client.listDecofileEntries(treeish, packagePath);
  const groups = new Map<string, BlockFile[]>();
  const prefix = `${blocksDirPath(packagePath)}/`;
  for (const entry of blockEntriesInTree(tree, packagePath)) {
    const file = entry.path.slice(prefix.length);
    if (!isBlockFileName(file)) continue;
    const key = fullyDecodeFileName(file).name;
    const group = groups.get(key) ?? [];
    group.push({ file, sha: entry.sha, size: entry.size });
    groups.set(key, group);
  }
  return groups;
}

function sameGroup(a: BlockFile[] = [], b: BlockFile[] = []): boolean {
  if (a.length !== b.length) return false;
  const shas = new Map(a.map((f) => [f.file, f.sha]));
  return b.every((f) => shas.get(f.file) === f.sha);
}

/** The entry a spelling group resolves to, by the shared key rule. */
async function winnerOf(
  client: RepoContentClient,
  group: BlockFile[] | undefined,
  memo: Map<string, string>,
): Promise<Winner | null> {
  if (!group?.length) return null;
  // Only an aliased name needs bodies: the winner prefers a page-like entry.
  const bodies =
    group.length === 1
      ? [null]
      : await resolveBlockContents(
          client,
          group.map((f) => ({ stem: f.file, sha: f.sha })),
          memo,
        );
  const candidates = group.map((f, i) => ({
    ...f,
    hasPath: bodies[i] ? entryHasPath(JSON.parse(bodies[i].content)) : false,
  }));
  const [resolved] = resolveSpellings(candidates).values();
  if (!resolved) return null;
  return {
    name: resolved.name,
    file: resolved.winner.file,
    sha: resolved.winner.sha,
    size: resolved.winner.size,
  };
}

/**
 * The cumulative overlay of `revision` against the production branch, and
 * the changed blocks' bodies by block hash.
 */
export async function buildDraftOverlay(
  client: RepoContentClient,
  packagePath: string | null,
  revision: string,
): Promise<{ overlay: DraftOverlay; blocks: Map<string, string> }> {
  const production = await client.getDefaultBranch();
  const { mergeBaseSha } = await client.compareDetailed(production, revision);
  const [draft, base] = await Promise.all([
    blockFiles(client, revision, packagePath),
    blockFiles(client, mergeBaseSha, packagePath),
  ]);

  const memo = new Map<string, string>();
  const replaced: Winner[] = [];
  const deleted = new Set<string>();
  for (const key of new Set([...draft.keys(), ...base.keys()])) {
    if (sameGroup(draft.get(key), base.get(key))) continue;
    const [now, before] = await Promise.all([
      winnerOf(client, draft.get(key), memo),
      winnerOf(client, base.get(key), memo),
    ]);
    if (now && before && now.file === before.file && now.sha === before.sha) {
      continue;
    }
    if (before && before.name !== now?.name) deleted.add(before.name);
    if (now) replaced.push(now);
  }

  const tooLarge = () =>
    new Error(
      `draft changes exceed ${MAX_OVERLAY_BLOCK_BYTES} bytes; publish or discard some of them to preview`,
    );
  // Refuse from tree metadata before reading; the read below re-checks real bytes.
  if (
    replaced.reduce((sum, w) => sum + (w.size ?? 0), 0) >
    MAX_OVERLAY_BLOCK_BYTES
  ) {
    throw tooLarge();
  }
  const bodies = await resolveBlockContents(
    client,
    replaced.map((w) => ({ stem: w.file, sha: w.sha })),
    memo,
  );
  let bytes = 0;
  const blocks = new Map<string, string>();
  const set: Array<[string, string]> = [];
  for (const [i, winner] of replaced.entries()) {
    const text = bodies[i]!.content;
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_OVERLAY_BLOCK_BYTES) throw tooLarge();
    const value: unknown = JSON.parse(text);
    const hash = await computeBlockHash(value);
    blocks.set(hash, JSON.stringify(value));
    set.push([winner.name, hash]);
    deleted.delete(winner.name);
  }
  return {
    overlay: {
      format: DRAFT_OVERLAY_FORMAT,
      // fromEntries: an entry named "__proto__" stays an entry.
      set: Object.fromEntries(set),
      delete: [...deleted].sort(),
    },
    blocks,
  };
}

/** Block assets this process already wrote, per store; content-addressed, so a hit is final. */
const uploaded = new WeakMap<BoundObjectStorage, Set<string>>();

async function putBlockOnce(
  store: BoundObjectStorage,
  key: string,
  body: string,
): Promise<void> {
  const written = uploaded.get(store) ?? new Set<string>();
  uploaded.set(store, written);
  if (written.has(key)) return;
  await store.put(key, body, { contentType: "application/json" });
  if (written.size >= MAX_REMEMBERED * 10) written.clear();
  written.add(key);
}

export interface DraftOverlayScope {
  client: RepoContentClient;
  packagePath: string | null;
  site: string;
  /** The exact saved commit. */
  revision: string;
}

/** Builds and uploads a commit's overlay: blocks, then manifest, then marker. */
export async function prepareDraftOverlay(
  scope: DraftOverlayScope,
  store: BoundObjectStorage = deliveryStorage(),
): Promise<string> {
  const { overlay, blocks } = await buildDraftOverlay(
    scope.client,
    scope.packagePath,
    scope.revision,
  );
  const version = await computeOverlayVersion(overlay);
  await mapBounded([...blocks], UPLOAD_CONCURRENCY, ([hash, body]) =>
    putBlockOnce(store, deliveryKeys.block(scope.site, hash), body),
  );
  await store.put(
    deliveryKeys.manifest(scope.site, version),
    JSON.stringify(overlay),
    { contentType: "application/json" },
  );
  await store.put(
    deliveryKeys.prepared(scope.site, scope.revision),
    JSON.stringify({ version }),
    { contentType: "application/json" },
  );
  return version;
}

const inflight = new Map<string, Promise<string>>();
const failures = new Map<string, { error: string; at: number }>();

function jobKey(scope: DraftOverlayScope): string {
  return `${scope.site}\n${scope.revision}`;
}

/** Starts (or joins) this commit's preparation on this replica. */
export function prepareDraftOverlayOnce(
  scope: DraftOverlayScope,
  store: BoundObjectStorage = deliveryStorage(),
): Promise<string> {
  const key = jobKey(scope);
  const running = inflight.get(key);
  if (running) return running;
  const job = prepareDraftOverlay(scope, store)
    .then(
      (version) => {
        failures.delete(key);
        return version;
      },
      (error: unknown) => {
        if (failures.size >= MAX_REMEMBERED) failures.clear();
        failures.set(key, {
          error: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        });
        throw error;
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  // Callers that only start it don't await it.
  job.catch(() => {});
  return job;
}

async function preparedVersion(
  store: BoundObjectStorage,
  scope: DraftOverlayScope,
): Promise<string | null> {
  try {
    const bytes = await store.getBytes(
      deliveryKeys.prepared(scope.site, scope.revision),
    );
    const { version } = JSON.parse(new TextDecoder().decode(bytes)) as {
      version?: unknown;
    };
    return typeof version === "string" ? version : null;
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

export type DraftOverlayStatus =
  | { status: "ready"; version: string }
  | { status: "preparing" }
  | { status: "failed"; error: string };

/**
 * Whether a saved commit's overlay is ready, starting its preparation when
 * it isn't and waiting briefly for it. A recent failure is reported, not
 * retried, until it ages out.
 */
export async function draftOverlayStatus(
  scope: DraftOverlayScope,
  options: { store?: BoundObjectStorage; waitMs?: number } = {},
): Promise<DraftOverlayStatus> {
  const store = options.store ?? deliveryStorage();
  const version = await preparedVersion(store, scope);
  if (version) return { status: "ready", version };
  const key = jobKey(scope);
  const failure = failures.get(key);
  if (failure && !inflight.has(key)) {
    if (Date.now() - failure.at < FAILURE_TTL_MS) {
      return { status: "failed", error: failure.error };
    }
    failures.delete(key);
  }
  const job = prepareDraftOverlayOnce(scope, store);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<DraftOverlayStatus>([
      job.then(
        (ready) => ({ status: "ready", version: ready }),
        (error: unknown) => ({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "preparing" }),
          options.waitMs ?? PREPARE_WAIT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
