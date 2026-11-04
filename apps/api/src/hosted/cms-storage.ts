/**
 * The content-protocol storage of a hosted CMS draft (contract §4.8): the
 * latest release (`latest.json` → `revisions/<id>/data.json`) with the
 * draft layered on, and no GitHub anywhere.
 *
 * - `blocks.list` (`snapshot()`): the latest revision's blocks with the draft
 *   applied (a set name replaces every spelling of it, a delete hides every
 *   spelling), each versioned with `blockVersion`. The revision is the
 *   draft's bare ETag only (`"none"` when its object is missing), and
 *   `resolvedRef` the latest revision id, so the editor's not-modified poll
 *   notices draft saves only.
 * - `blocks.apply` (an overlay storage, `writeSnapshot()`): the draft alone,
 *   read once with a strong read; each guard compares with the draft only
 *   (its version when it holds the block, `TOMBSTONE_VERSION` when it
 *   deletes it, `null` otherwise). The commit PUTs the draft with
 *   `If-Match` on that read's ETag (`If-None-Match: *` when missing),
 *   stamping `editors`. A lost race is `stale`, which the handler (one
 *   commit attempt) answers Unavailable; R2 429/5xx/network is Unavailable
 *   too. The read is kept, so a Conflict carries each refused block's value,
 *   version and editor from it (`withConflictBlocks`).
 * - `changes.*`: the draft's own names against the latest revision;
 *   `changes.discard` drops them from the draft (one conditional PUT).
 * - `schema.get`: the record bucket's `schema.json`, revalidated with a
 *   conditional GET on the cached ETag on every read.
 */

import {
  blockFileName,
  blockNameFromFile,
  type CommitAttempt,
  type CommitResult,
  type ContentStorage,
  fullyDecodeFileName,
  serializeBlock,
  spellingKey,
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
import { blockVersion } from "./block-version";
import {
  type CmsDraftBody,
  type DraftRead,
  readDraftObject,
  stampEditors,
  writeDraftObject,
} from "./cms-drafts";
import {
  readLatestPointer,
  readRevision,
  type RevisionContent,
} from "./cms-release";
import {
  bareEtag,
  type DeliveryStore,
  DeliveryUnavailableError,
  ObjectChangedError,
} from "./delivery-store";
import type { RecordStore } from "./record-store";

/** The spelling group (fully decoded name) a saved-block file belongs to. */
function groupOf(file: string): string {
  return fullyDecodeFileName(file).name;
}

const NO_REVISION = "none";

/** The schema per site, by ETag: revalidated on every read (a 304 when unchanged). */
const schemaCache = new Map<string, { etag: string; text: string }>();

/** Test-only. */
export function clearSchemaCache() {
  schemaCache.clear();
}

/** Reads the site's schema.json, revalidating the cached copy. */
export async function readSiteSchema(
  records: RecordStore | null,
  site: string,
): Promise<{ text: string; etag: string } | null> {
  if (!records) return null;
  const cached = schemaCache.get(site);
  const read = await records.getSchema(site, cached?.etag ?? null);
  if (!read) {
    schemaCache.delete(site);
    return null;
  }
  if (read.notModified) return cached ?? null;
  const etag = read.etag ?? "";
  if (etag) schemaCache.set(site, { etag, text: read.text });
  return { text: read.text, etag };
}

/** The draft's own block files and texts (its `set`). */
function draftFiles(body: CmsDraftBody) {
  const files: StorageFile[] = [];
  const texts = new Map<string, string>();
  for (const [name, block] of Object.entries(body.set)) {
    const file = blockFileName(name);
    const text = serializeBlock(block);
    texts.set(file, text);
    files.push({
      file,
      version: blockVersion(block),
      size: Buffer.byteLength(text),
    });
  }
  return { files, texts };
}

/** The draft as a save sees it: its blocks and a tombstone per deletion. */
function overlayFiles(body: CmsDraftBody) {
  const own = draftFiles(body);
  const held = new Set(Object.keys(body.set).map(spellingKey));
  const tombstones = body.delete
    .filter((name) => !held.has(spellingKey(name)))
    .map(
      (name): StorageFile => ({
        file: blockFileName(name),
        version: TOMBSTONE_VERSION,
        deleted: true,
      }),
    );
  return { files: [...own.files, ...tombstones], texts: own.texts };
}

/** The base's files with the draft layered on. */
function layeredFiles(base: StorageFile[], body: CmsDraftBody) {
  const touched = new Set(
    [...Object.keys(body.set), ...body.delete].map(spellingKey),
  );
  const own = draftFiles(body);
  return {
    files: [...base.filter((f) => !touched.has(groupOf(f.file))), ...own.files],
    texts: own.texts,
  };
}

/**
 * The draft after one save: a put sets the block, whole, under the name
 * written, dropping every other spelling and a pending delete; a delete
 * drops the name from `set` and records it in `delete`.
 */
export function applyAttempt(
  body: CmsDraftBody,
  attempt: { put: Record<string, string>; delete: string[] },
): Pick<CmsDraftBody, "set" | "delete"> {
  const set = { ...body.set };
  const deleted = new Set(body.delete);
  const dropGroup = (group: string) => {
    for (const name of Object.keys(set)) {
      if (spellingKey(name) === group) delete set[name];
    }
    for (const name of deleted) {
      if (spellingKey(name) === group) deleted.delete(name);
    }
  };
  const putGroups = new Set<string>();
  for (const [file, content] of Object.entries(attempt.put)) {
    const group = groupOf(file);
    putGroups.add(group);
    dropGroup(group);
    set[blockNameFromFile(file)] = JSON.parse(content) as unknown;
  }
  for (const file of attempt.delete) {
    const group = groupOf(file);
    if (putGroups.has(group)) continue;
    dropGroup(group);
    deleted.add(blockNameFromFile(file));
  }
  return {
    set: Object.fromEntries(Object.entries(set)),
    delete: [...deleted].sort(),
  };
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

function unavailableFrom(error: unknown): never {
  if (error instanceof DeliveryUnavailableError) {
    throw new StorageUnavailableError(error.message, 250);
  }
  throw error;
}

export interface CmsStorage extends ContentStorage {
  /** The draft reads `blocks.apply` validated against, in order. */
  readonly applyReads: DraftRead[];
}

export function createCmsStorage(options: {
  store: DeliveryStore;
  records: RecordStore | null;
  site: string;
  slug: string;
  /** Who saves through this storage (stamped into `editors`). */
  userId: string;
  now?: () => number;
}): CmsStorage {
  const { store, site, slug } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const applyReads: DraftRead[] = [];
  /** Draft reads by the revision they were reported with (`snapshot()`). */
  const layered = new Map<
    string,
    { read: DraftRead; texts: Map<string, string> }
  >();

  /** The latest revision, read once per request (a discard reads it again). */
  let latestRead: Promise<RevisionContent | null> | null = null;
  const readLatest = (fresh = false): Promise<RevisionContent | null> => {
    if (!latestRead || fresh) {
      const read = (async () => {
        const latest = await readLatestPointer(store, site);
        return latest
          ? readRevision(store, site, latest.pointer.revision)
          : null;
      })();
      latestRead = read;
      read.catch(() => {
        if (latestRead === read) latestRead = null;
      });
    }
    return latestRead.catch(unavailableFrom);
  };
  const readDraft = () =>
    readDraftObject(store, site, slug).catch(unavailableFrom);
  const revisionOf = (read: DraftRead) => bareEtag(read.etag) ?? NO_REVISION;
  const baseOf = (latest: RevisionContent | null): StorageBase => ({
    revision: latest?.id ?? NO_REVISION,
    resolvedRef: latest?.id ?? null,
  });
  const revisionAt = async (base: StorageBase) => {
    const latest = await readLatest();
    if ((latest?.id ?? NO_REVISION) === base.revision) return latest;
    return base.resolvedRef
      ? readRevision(store, site, base.resolvedRef)
      : null;
  };

  /** PUTs the draft over `read`; a lost race is `stale`. */
  const write = async (
    read: DraftRead,
    next: Pick<CmsDraftBody, "set" | "delete">,
  ): Promise<string | null | "stale"> => {
    const body: CmsDraftBody = {
      ...next,
      editors: stampEditors(read.body, next, options.userId, now()),
    };
    try {
      return await writeDraftObject(store, site, slug, body, read.etag);
    } catch (error) {
      if (error instanceof ObjectChangedError) return "stale";
      return unavailableFrom(error);
    }
  };

  const discard = async (attempt: CommitAttempt): Promise<CommitResult> => {
    const latest = await readLatest(true);
    if (
      attempt.expectedBase !== undefined &&
      (latest?.id ?? NO_REVISION) !== attempt.expectedBase
    ) {
      return { status: "stale" };
    }
    const read =
      layered.get(attempt.base.revision)?.read ?? (await readDraft());
    const baseFiles = latest?.files ?? [];
    if (
      !expectedHold(layeredFiles(baseFiles, read.body).files, attempt.expected)
    ) {
      return { status: "stale" };
    }
    const onBase = new Map(baseFiles.map((f) => [f.file, f.version]));
    const versions: Record<string, string> = {};
    for (const file of Object.keys(attempt.put)) {
      const version = onBase.get(file);
      if (version === undefined) return { status: "stale" };
      versions[file] = version;
    }
    const groups = new Set(
      [...Object.keys(attempt.put), ...attempt.delete].map(groupOf),
    );
    const etag = await write(read, {
      set: Object.fromEntries(
        Object.entries(read.body.set).filter(
          ([n]) => !groups.has(spellingKey(n)),
        ),
      ),
      delete: read.body.delete.filter((n) => !groups.has(spellingKey(n))),
    });
    if (etag === "stale") return { status: "stale" };
    return {
      status: "committed",
      revision: bareEtag(etag) ?? NO_REVISION,
      versions,
    };
  };

  return {
    applyReads,

    describe: () => ({
      kind: "git",
      root: ".",
      readOnly: false,
      assets: null,
      pollIntervalMs: 30_000,
    }),

    async snapshot(): Promise<StorageSnapshot> {
      const [latest, read] = await Promise.all([readLatest(), readDraft()]);
      const { files, texts } = layeredFiles(latest?.files ?? [], read.body);
      const revision = revisionOf(read);
      layered.set(revision, { read, texts });
      return { revision, resolvedRef: latest?.id ?? null, files };
    },

    async writeSnapshot(): Promise<StorageSnapshot> {
      const read = await readDraft();
      applyReads.push(read);
      const { files, texts } = overlayFiles(read.body);
      const revision = revisionOf(read);
      layered.set(revision, { read, texts });
      return { revision, resolvedRef: null, files };
    },

    async readFiles(snap, files) {
      const own =
        layered.get(snap.revision)?.texts ?? new Map<string, string>();
      // A save's overlay holds every file it lists: no release read.
      const latest = files.every((f) => own.has(f)) ? null : await readLatest();
      const out: Record<string, StoredFileBody> = {};
      for (const file of files) {
        const text = own.get(file) ?? latest?.texts.get(file);
        if (text === undefined) continue;
        out[file] = { text, version: blockVersion(JSON.parse(text)) };
      }
      return out;
    },

    async readSchema(): Promise<StoredSchema | null> {
      const schema = await readSiteSchema(options.records, site).catch(
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

    base: async () => baseOf(await readLatest()),

    async changes(base, snap): Promise<StorageChanges> {
      const onBase = (await revisionAt(base))?.files ?? [];
      const body = (layered.get(snap.revision)?.read ?? (await readDraft()))
        .body;
      const baseGroups = new Set(onBase.map((f) => groupOf(f.file)));
      const deletions = body.delete.filter((n) =>
        baseGroups.has(spellingKey(n)),
      );
      const touched = new Set([
        ...Object.keys(body.set).map(spellingKey),
        ...deletions.map(spellingKey),
      ]);
      const files = new Set(Object.keys(body.set).map(blockFileName));
      for (const f of onBase)
        if (touched.has(groupOf(f.file))) files.add(f.file);
      const held = new Set(Object.keys(body.set).map(spellingKey));
      const tombstones: StorageFile[] = deletions
        .filter((n) => !held.has(spellingKey(n)))
        .map((n) => ({
          file: blockFileName(n),
          version: TOMBSTONE_VERSION,
          deleted: true,
        }));
      return { files: [...files].sort(), tombstones, baseFiles: onBase };
    },

    async readBaseFiles(base, files) {
      const revision = await revisionAt(base);
      const out: Record<string, StoredFileBody> = {};
      for (const file of files) {
        const text = revision?.texts.get(file);
        if (text !== undefined) {
          out[file] = { text, version: blockVersion(JSON.parse(text)) };
        }
      }
      return out;
    },

    async commit(attempt): Promise<CommitResult> {
      if (attempt.reason === "discard") return discard(attempt);
      const read =
        layered.get(attempt.base.revision)?.read ??
        applyReads.at(-1) ??
        (await readDraft());
      if (!expectedHold(overlayFiles(read.body).files, attempt.expected)) {
        return { status: "stale" };
      }
      const next = applyAttempt(read.body, attempt);
      const versions: Record<string, string> = {};
      for (const [file, content] of Object.entries(attempt.put)) {
        versions[file] = blockVersion(JSON.parse(content));
      }
      const recorded = new Set(next.delete.map(spellingKey));
      for (const file of attempt.delete) {
        if (recorded.has(groupOf(file))) versions[file] = TOMBSTONE_VERSION;
      }
      const etag = await write(read, next);
      if (etag === "stale") return { status: "stale" };
      return {
        status: "committed",
        revision: bareEtag(etag) ?? NO_REVISION,
        versions,
      };
    },
  };
}

/** Each refused name as `read` (the save's own step-1 read) holds it. */
export function conflictBlocks(
  read: DraftRead,
  names: readonly string[],
): DraftConflictBlocks["draft"] {
  const out: DraftConflictBlocks["draft"] = {};
  const editorOf = (name: string) =>
    Object.hasOwn(read.body.editors, name)
      ? (read.body.editors[name] ?? null)
      : null;
  for (const name of names) {
    const key = spellingKey(name);
    const setName = Object.keys(read.body.set).find(
      (n) => spellingKey(n) === key,
    );
    if (setName !== undefined) {
      const block = read.body.set[setName];
      out[name] = {
        block,
        version: blockVersion(block),
        editor: editorOf(setName),
      };
    } else {
      const deleted = read.body.delete.find((n) => spellingKey(n) === key);
      out[name] =
        deleted !== undefined
          ? {
              block: null,
              version: TOMBSTONE_VERSION,
              editor: editorOf(deleted),
            }
          : null;
    }
  }
  return out;
}

/** The read a Conflict was decided on: the one whose versions are its `actual`s. */
function readOfConflict(
  reads: readonly DraftRead[],
  entries: Record<string, { actual?: unknown }>,
): DraftRead | null {
  for (const read of [...reads].reverse()) {
    const blocks = conflictBlocks(read, Object.keys(entries));
    const matches = Object.entries(entries).every(
      ([name, entry]) =>
        (blocks[name]?.version ?? null) === (entry.actual ?? null),
    );
    if (matches) return read;
  }
  return reads.at(-1) ?? null;
}

const CONFLICT = -32002;

/**
 * The handler's answer with each Conflict carrying, per refused block, what
 * the draft held in the save's own read: value, version and editor
 * (contract §4.8.1). Never a re-read. Any other answer is returned as is.
 */
export async function withConflictBlocks(
  response: Response,
  reads: readonly DraftRead[],
): Promise<Response> {
  if (reads.length === 0) return response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  const answers = Array.isArray(parsed) ? parsed : [parsed];
  let changed = false;
  for (const answer of answers) {
    const error = (answer as { error?: { code?: unknown; data?: unknown } })
      ?.error;
    if (!error || error.code !== CONFLICT) continue;
    const data = error.data as
      | { entries?: Record<string, { actual?: unknown }> }
      | undefined;
    if (!data?.entries) continue;
    const read = readOfConflict(reads, data.entries);
    if (!read) continue;
    (data as Record<string, unknown>).draft = conflictBlocks(
      read,
      Object.keys(data.entries),
    );
    changed = true;
  }
  if (!changed) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(parsed), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
