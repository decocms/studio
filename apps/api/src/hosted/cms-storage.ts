/**
 * The content-protocol storage of a hosted CMS draft (contract §4.2–§4.4):
 * the live index (`latest.json`) with the draft's files overlaid, and no
 * GitHub anywhere. No view lists every body: the index carries each name's
 * version, and a body is read only when asked for, by its hash.
 *
 * - `snapshot()`: the overlaid index's names and versions, with no body
 *   read: latest.json, the draft index and every listed draft file. Its
 *   revision is the `draftToken`, its `resolvedRef` the live revision.
 * - `writeSnapshot()` (an overlay storage): only the draft index and the
 *   files of the names this request's `blocks.apply` touches or guards.
 *   Each guard compares with the draft alone (`set` → its version, `delete`
 *   → `TOMBSTONE_VERSION`, missing or `published` → `null`).
 * - `commit()`: `blocks.apply` as the design says: new names into the draft
 *   index first, then the set files (targets before referrers), then the
 *   deletes, one conditional PUT each. A PUT that fails stops the save with
 *   the names that landed ({@link PartialApplyError}); nothing is retried.
 * - `changes.*`: the draft's own names against the live index;
 *   `changes.discard` leaves a `published` marker per name and drops the
 *   names from the draft index.
 * - `index()` / `blocks()`: Studio's `cms.index` and `cms.blocks`.
 * - `schema.get`: the record bucket's `schema.json`, revalidated with a
 *   conditional GET on the cached ETag on every read.
 */

import {
  blockFileName,
  blockNameFromFile,
  type CommitAttempt,
  type CommitResult,
  type ContentStorage,
  type StorageBase,
  type StorageChanges,
  type StorageFile,
  type StorageSnapshot,
  type StoredFileBody,
  type StoredSchema,
  StorageUnavailableError,
  TOMBSTONE_VERSION,
} from "@decocms/blocks/protocol";
import type { DraftConflictBlocks } from "@decocms/shared/blocks-major";
import type { CmsVia } from "@/storage/types";
import { type BlockMeta, blockMeta } from "./block-meta";
import { blockVersion } from "./block-version";
import {
  type DraftEditor,
  type DraftFileRead,
  type DraftIndexRead,
  type DraftState,
  draftToken,
  editorOf,
  holdsName,
  mapBounded,
  readDraftFiles,
  readDraftIndex,
  readDraftState,
  updateDraftIndex,
  writeDraftFile,
} from "./cms-drafts";
import {
  type Latest,
  readBlockBody,
  readLatest,
  readRevisionIndex,
  type RevisionIndex,
} from "./cms-release";
import {
  bareEtag,
  type DeliveryStore,
  DeliveryUnavailableError,
  deliveryKeys,
  ObjectChangedError,
} from "./delivery-store";

const NO_REVISION = "none";
/** Block bodies read at once from the bucket. */
const BODY_READS = 16;
/** `cms.blocks`: names in one call. */
export const MAX_NAMES_PER_BLOCKS = 50;

/** The schema per site, by ETag: revalidated on every read (a 304 when unchanged). */
const schemaCache = new Map<string, { etag: string; text: string }>();

/** Test-only. */
export function clearSchemaCache() {
  schemaCache.clear();
}

/** Reads the site's schema.json, revalidating the cached copy. */
async function readSiteSchema(
  store: DeliveryStore,
  site: string,
): Promise<{ text: string; etag: string } | null> {
  const cached = schemaCache.get(site);
  const read = await store.get(deliveryKeys.schema(site), {
    ifNoneMatch: cached?.etag ?? null,
  });
  if (!read) {
    schemaCache.delete(site);
    return null;
  }
  if ("notModified" in read) return cached ?? null;
  const etag = read.etag ?? "";
  if (etag) schemaCache.set(site, { etag, text: read.text });
  return { text: read.text, etag };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unavailableFrom(error: unknown): never {
  if (error instanceof DeliveryUnavailableError) {
    throw new StorageUnavailableError(error.message, 250);
  }
  throw error;
}

/**
 * A `blocks.apply` that stopped part way (contract §4.3 step 7): the names
 * in `landed` were written (with these versions, `"tombstone"` for a
 * delete), the rest weren't. The client re-sends only the rest.
 */
class PartialApplyError extends StorageUnavailableError {
  constructor(
    readonly landed: Record<string, string>,
    cause: unknown,
  ) {
    super(
      `the save stopped after ${Object.keys(landed).length} block(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      250,
    );
    this.name = "PartialApplyError";
  }
}

/** One name of the overlaid index (latest ⊕ draft). */
interface OverlayEntry {
  version: string;
  meta?: BlockMeta;
  /** The draft's body, when the draft sets the name. */
  draft?: Record<string, unknown>;
}

/**
 * latest ⊕ draft (contract §3.6 step 3): a `set` replaces or adds the
 * entry, with `meta` from the draft body; a `delete` removes it; a missing
 * file or a `published` marker leaves production.
 */
function overlayIndex(
  latest: Latest | null,
  files: ReadonlyMap<string, DraftFileRead>,
): Map<string, OverlayEntry> {
  const out = new Map<string, OverlayEntry>();
  for (const [name, entry] of Object.entries(latest?.blocks ?? {})) {
    out.set(name, {
      version: entry.version,
      ...(entry.meta ? { meta: entry.meta } : {}),
    });
  }
  const sets: Array<[string, Record<string, unknown>]> = [];
  for (const [name, read] of files) {
    if (!holdsName(read)) continue;
    if (read.file.operation === "delete") out.delete(name);
    else sets.push([name, read.file.data]);
  }
  for (const [name] of sets) out.set(name, { version: "" });
  const names = new Set(out.keys());
  for (const [name, data] of sets) {
    const meta = blockMeta(data, names);
    out.set(name, {
      version: blockVersion(data),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      draft: data,
    });
  }
  return out;
}

/** A name's version in the draft alone: what a hosted guard compares. */
function draftVersion(read: DraftFileRead | undefined): string | null {
  if (!holdsName(read)) return null;
  return read.file.operation === "delete"
    ? TOMBSTONE_VERSION
    : blockVersion(read.file.data);
}

/** Every `expected` file is in `files` at that version (`null`: absent). */
function expectedHold(
  files: StorageFile[],
  expected: Record<string, string | null>,
): boolean {
  const now = new Map(files.map((f) => [f.file, f.version]));
  return Object.entries(expected).every(
    ([file, version]) => (now.get(file) ?? null) === version,
  );
}

/**
 * The set names in write order: a name another set name references (its
 * `blockMeta` refs, restricted to the set) first; ties and cycles in
 * code-unit order.
 */
export function targetsFirst(
  sets: ReadonlyMap<string, Record<string, unknown>>,
): string[] {
  const names = [...sets.keys()].sort();
  const known = new Set(names);
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string) => {
    if (state.has(name)) return;
    state.set(name, "visiting");
    for (const ref of blockMeta(sets.get(name), known).refs ?? []) {
      if (ref !== name) visit(ref);
    }
    state.set(name, "done");
    order.push(name);
  };
  for (const name of names) visit(name);
  return order;
}

/** What `cms.index` answers (contract §4.2). */
export type CmsIndexResult =
  | { notModified: true; revision: string }
  | {
      notModified: false;
      revision: string;
      resolvedRef: string | null;
      sequence: number;
      entries: Record<string, { version: string; meta?: BlockMeta }>;
      draft: Record<
        string,
        {
          operation: "set" | "delete";
          version: string;
          editor: DraftEditor | null;
        }
      >;
    };

/** What `cms.blocks` answers (contract §4.2). */
export interface CmsBlocksResult {
  blocks: Record<string, Record<string, unknown>>;
  versions: Record<string, string>;
  missing: string[];
}

/** The draft reads one `blocks.apply` was checked against. */
export interface ApplyRead {
  index: DraftIndexRead;
  files: Map<string, DraftFileRead>;
}

interface ReadState {
  latest: Latest | null;
  state: DraftState;
  overlay: Map<string, OverlayEntry>;
}

export interface CmsStorage extends ContentStorage {
  /** The draft reads `blocks.apply` was checked against, in order. */
  readonly applyReads: ApplyRead[];
  /**
   * The names the last partial `blocks.apply` landed (`-32008`'s
   * `data.landed`), once; null when there was none since the last call.
   */
  takePartial(): Record<string, string> | null;
  /** `cms.index`: the overlaid index, or `notModified` on the same token. */
  index(ifNoneMatch?: string): Promise<CmsIndexResult>;
  /** `cms.blocks`: the overlaid bodies of 1–50 names. */
  blocks(names: readonly string[]): Promise<CmsBlocksResult>;
}

export function createCmsStorage(options: {
  store: DeliveryStore;
  site: string;
  slug: string;
  /** Who saves through this storage (written into each draft file). */
  userId: string;
  via?: CmsVia;
  /**
   * The names this request's `blocks.apply` calls write or guard: the only
   * draft files `writeSnapshot()` reads. All of them when absent.
   */
  applyNames?: readonly string[];
  now?: () => number;
}): CmsStorage {
  const { store, site, slug } = options;
  const via: CmsVia = options.via ?? "studio";
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const applyReads: ApplyRead[] = [];
  let partial: Record<string, string> | null = null;
  /** Reads by the revision they were reported with. */
  const snaps = new Map<string, ReadState | ApplyRead>();

  /** latest.json, read once per request (a discard reads it again). */
  let latestRead: Promise<Latest | null> | null = null;
  const readLive = (fresh = false): Promise<Latest | null> => {
    if (!latestRead || fresh) {
      const read = readLatest(store, site).then((r) => r?.latest ?? null);
      latestRead = read;
      read.catch(() => {
        if (latestRead === read) latestRead = null;
      });
    }
    return latestRead.catch(unavailableFrom);
  };
  const readAll = async (): Promise<ReadState> => {
    const [latest, state] = await Promise.all([
      readLive(),
      readDraftState(store, site, slug).catch(unavailableFrom),
    ]);
    return { latest, state, overlay: overlayIndex(latest, state.files) };
  };
  const indexAt = async (base: StorageBase): Promise<RevisionIndex | null> => {
    const latest = await readLive();
    if ((latest?.revision ?? NO_REVISION) === base.revision) return latest;
    return base.resolvedRef
      ? readRevisionIndex(store, site, base.resolvedRef).catch(unavailableFrom)
      : null;
  };
  const bodyOf = (hash: string) =>
    readBlockBody(store, site, hash).catch(unavailableFrom);

  const snapshotOf = (read: ReadState): StorageSnapshot => {
    const revision = draftToken(read.latest?.revision ?? null, read.state);
    snaps.set(revision, read);
    return {
      revision,
      resolvedRef: read.latest?.revision ?? null,
      files: [...read.overlay].map(([name, entry]) => ({
        file: blockFileName(name),
        version: entry.version,
      })),
    };
  };

  const discard = async (attempt: CommitAttempt): Promise<CommitResult> => {
    const latest = await readLive(true);
    if (
      attempt.expectedBase !== undefined &&
      (latest?.revision ?? NO_REVISION) !== attempt.expectedBase
    ) {
      return { status: "stale" };
    }
    const snap = snaps.get(attempt.base.revision);
    const read = snap && "overlay" in snap ? snap : await readAll();
    if (!expectedHold(snapshotOf(read).files, attempt.expected)) {
      return { status: "stale" };
    }
    const names = [
      ...new Set(
        [...Object.keys(attempt.put), ...attempt.delete].map(blockNameFromFile),
      ),
    ].sort();
    const versions: Record<string, string> = {};
    for (const file of Object.keys(attempt.put)) {
      const entry = latest?.blocks[blockNameFromFile(file)];
      if (!entry) return { status: "stale" };
      versions[file] = entry.version;
    }
    let last: string | null = null;
    const dropped: string[] = [];
    for (const name of names) {
      const file = read.state.files.get(name);
      if (!holdsName(file)) continue;
      try {
        last = await writeDraftFile(
          store,
          site,
          slug,
          name,
          {
            operation: "published",
            revision: latest?.revision ?? null,
            version: latest?.blocks[name]?.version ?? null,
          },
          file.etag,
        );
        dropped.push(name);
      } catch (error) {
        if (error instanceof ObjectChangedError) return { status: "stale" };
        return unavailableFrom(error);
      }
    }
    const drop = new Set(dropped);
    await updateDraftIndex(store, site, slug, (listed) =>
      listed.filter((n) => !drop.has(n)),
    ).catch(unavailableFrom);
    return {
      status: "committed",
      revision: `s-${bareEtag(last) ?? NO_REVISION}`,
      versions,
    };
  };

  const apply = async (attempt: CommitAttempt): Promise<CommitResult> => {
    const snap = snaps.get(attempt.base.revision);
    const read: ApplyRead =
      snap && !("overlay" in snap)
        ? snap
        : (applyReads.at(-1) ?? (await takeApplyRead()));
    if (!expectedHold(applyFiles(read), attempt.expected)) {
      partial = {};
      throw new PartialApplyError({}, new Error("the draft changed"));
    }
    const sets = new Map<string, Record<string, unknown>>();
    for (const [file, content] of Object.entries(attempt.put)) {
      sets.set(blockNameFromFile(file), JSON.parse(content));
    }
    const deletes = [...new Set(attempt.delete.map(blockNameFromFile))]
      .filter((name) => !sets.has(name))
      .sort();
    const landed: Record<string, string> = {};
    const fileVersions: Record<string, string> = {};
    const listed = new Set(read.index.names);
    const added = [...sets.keys(), ...deletes].filter((n) => !listed.has(n));
    try {
      if (added.length > 0) {
        await updateDraftIndex(
          store,
          site,
          slug,
          (names) => [...names, ...added],
          read.index,
        );
      }
    } catch (error) {
      partial = { ...landed };
      if (error instanceof DeliveryUnavailableError) {
        throw new PartialApplyError(landed, error);
      }
      throw error;
    }
    let last: string | null = null;
    const write = async (
      name: string,
      file: Parameters<typeof writeDraftFile>[4],
      version: string,
    ) => {
      try {
        last = await writeDraftFile(
          store,
          site,
          slug,
          name,
          file,
          read.files.get(name)?.etag ?? null,
        );
      } catch (error) {
        partial = { ...landed };
        if (
          error instanceof ObjectChangedError ||
          error instanceof DeliveryUnavailableError
        ) {
          throw new PartialApplyError(landed, error);
        }
        throw error;
      }
      landed[name] = version;
      fileVersions[blockFileName(name)] = version;
    };
    const at = now();
    for (const name of targetsFirst(sets)) {
      const data = sets.get(name)!;
      await write(
        name,
        { operation: "set", data, user: options.userId, via, at },
        blockVersion(data),
      );
    }
    for (const name of deletes) {
      await write(
        name,
        { operation: "delete", user: options.userId, via, at },
        TOMBSTONE_VERSION,
      );
    }
    return {
      status: "committed",
      revision: `s-${bareEtag(last) ?? NO_REVISION}`,
      versions: fileVersions,
    };
  };

  /** The draft as a save sees it: only the names the save touches or guards. */
  const takeApplyRead = async (): Promise<ApplyRead> => {
    if (!options.applyNames) {
      const state = await readDraftState(store, site, slug).catch(
        unavailableFrom,
      );
      return { index: state.index, files: state.files };
    }
    const index = await readDraftIndex(store, site, slug).catch(
      unavailableFrom,
    );
    const names = [...new Set(options.applyNames)];
    const files = await readDraftFiles(store, site, slug, names).catch(
      unavailableFrom,
    );
    return { index, files };
  };

  const applyFiles = (read: ApplyRead): StorageFile[] => {
    const files: StorageFile[] = [];
    for (const [name, file] of read.files) {
      const version = draftVersion(file);
      if (version === null) continue;
      files.push({
        file: blockFileName(name),
        version,
        ...(version === TOMBSTONE_VERSION ? { deleted: true as const } : {}),
      });
    }
    return files;
  };

  return {
    applyReads,

    takePartial() {
      const taken = partial;
      partial = null;
      return taken;
    },

    describe: () => ({
      kind: "git",
      root: ".",
      readOnly: false,
      assets: null,
      pollIntervalMs: 30_000,
    }),

    async snapshot(): Promise<StorageSnapshot> {
      return snapshotOf(await readAll());
    },

    async writeSnapshot(): Promise<StorageSnapshot> {
      const read = await takeApplyRead();
      applyReads.push(read);
      const revision = `w-${applyReads.length}`;
      snaps.set(revision, read);
      return { revision, resolvedRef: null, files: applyFiles(read) };
    },

    async readFiles(snap, files) {
      const known = snaps.get(snap.revision);
      const out: Record<string, StoredFileBody> = {};
      if (!known) return out;
      if (!("overlay" in known)) {
        for (const file of files) {
          const held = known.files.get(blockNameFromFile(file));
          if (holdsName(held) && held.file.operation === "set") {
            out[file] = {
              text: JSON.stringify(held.file.data),
              version: blockVersion(held.file.data),
            };
          }
        }
        return out;
      }
      await mapBounded(files, BODY_READS, async (file) => {
        const entry = known.overlay.get(blockNameFromFile(file));
        if (!entry) return;
        const body = entry.draft ?? (await bodyOf(entry.version));
        out[file] = { text: JSON.stringify(body), version: entry.version };
      });
      return out;
    },

    async readSchema(): Promise<StoredSchema | null> {
      const schema = await readSiteSchema(options.store, site).catch(
        unavailableFrom,
      );
      return schema
        ? {
            version: bareEtag(schema.etag) ?? "",
            text: schema.text,
            resolvedRef: null,
          }
        : null;
    },

    async base() {
      const latest = await readLive();
      return {
        revision: latest?.revision ?? NO_REVISION,
        resolvedRef: latest?.revision ?? null,
      };
    },

    async changes(base, snap): Promise<StorageChanges> {
      const onBase = (await indexAt(base))?.blocks ?? {};
      const known = snaps.get(snap.revision);
      const state =
        known && "overlay" in known
          ? known.state
          : await readDraftState(store, site, slug).catch(unavailableFrom);
      const files: string[] = [];
      const tombstones: StorageFile[] = [];
      const baseFiles: StorageFile[] = [];
      for (const [name, read] of state.files) {
        if (!holdsName(read)) continue;
        const inBase = Object.hasOwn(onBase, name);
        if (read.file.operation === "delete") {
          if (!inBase) continue;
          tombstones.push({
            file: blockFileName(name),
            version: TOMBSTONE_VERSION,
            deleted: true,
          });
        }
        files.push(blockFileName(name));
        if (inBase) {
          baseFiles.push({
            file: blockFileName(name),
            version: onBase[name]!.version,
          });
        }
      }
      return { files: files.sort(), tombstones, baseFiles };
    },

    async readBaseFiles(base, files) {
      const index = await indexAt(base);
      const out: Record<string, StoredFileBody> = {};
      await mapBounded(files, BODY_READS, async (file) => {
        const entry = index?.blocks[blockNameFromFile(file)];
        if (!entry) return;
        out[file] = {
          text: JSON.stringify(await bodyOf(entry.version)),
          version: entry.version,
        };
      });
      return out;
    },

    async commit(attempt): Promise<CommitResult> {
      return attempt.reason === "discard" ? discard(attempt) : apply(attempt);
    },

    async index(ifNoneMatch) {
      const read = await readAll();
      const revision = draftToken(read.latest?.revision ?? null, read.state);
      if (ifNoneMatch !== undefined && ifNoneMatch === revision) {
        return { notModified: true, revision };
      }
      const entries: Record<string, { version: string; meta?: BlockMeta }> =
        Object.create(null);
      for (const [name, entry] of read.overlay) {
        entries[name] = {
          version: entry.version,
          ...(entry.meta ? { meta: entry.meta } : {}),
        };
      }
      const draft: Extract<CmsIndexResult, { notModified: false }>["draft"] =
        Object.create(null);
      for (const [name, file] of read.state.files) {
        if (!holdsName(file)) continue;
        draft[name] = {
          operation: file.file.operation,
          version: draftVersion(file)!,
          editor: editorOf(file.file),
        };
      }
      return {
        notModified: false,
        revision,
        resolvedRef: read.latest?.revision ?? null,
        sequence: read.latest?.sequence ?? 0,
        entries,
        draft,
      };
    },

    async blocks(names) {
      const [latest, index] = await Promise.all([
        readLive(),
        readDraftIndex(store, site, slug).catch(unavailableFrom),
      ]);
      const listed = new Set(index.names);
      const unique = [...new Set(names)];
      const files = await readDraftFiles(
        store,
        site,
        slug,
        unique.filter((n) => listed.has(n)),
      ).catch(unavailableFrom);
      const out: CmsBlocksResult = {
        blocks: Object.create(null),
        versions: Object.create(null),
        missing: [],
      };
      await mapBounded(unique, BODY_READS, async (name) => {
        const read = files.get(name);
        if (holdsName(read)) {
          if (read.file.operation === "delete") {
            out.missing.push(name);
            return;
          }
          out.blocks[name] = read.file.data;
          out.versions[name] = blockVersion(read.file.data);
          return;
        }
        const entry =
          latest && Object.hasOwn(latest.blocks, name)
            ? latest.blocks[name]
            : undefined;
        if (!entry) {
          out.missing.push(name);
          return;
        }
        const body = await bodyOf(entry.version);
        if (!isRecord(body)) {
          out.missing.push(name);
          return;
        }
        out.blocks[name] = body;
        out.versions[name] = entry.version;
      });
      out.missing.sort();
      return out;
    },
  };
}

/**
 * Each refused name as `read` (the save's own step-1 read) holds it: the
 * value, version and editor (`DraftConflictBlocks`), `null` when the draft
 * doesn't hold it.
 */
export function conflictBlocks(
  read: ApplyRead,
  names: readonly string[],
): DraftConflictBlocks["draft"] {
  const out: DraftConflictBlocks["draft"] = {};
  for (const name of names) {
    const file = read.files.get(name);
    if (!holdsName(file)) {
      out[name] = null;
      continue;
    }
    out[name] =
      file.file.operation === "set"
        ? {
            block: file.file.data,
            version: blockVersion(file.file.data),
            editor: editorOf(file.file),
          }
        : {
            block: null,
            version: TOMBSTONE_VERSION,
            editor: editorOf(file.file),
          };
  }
  return out;
}
