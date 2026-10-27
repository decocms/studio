/**
 * The site editor's content-protocol storages for a hosted v8 project on
 * GitHub. The draft is one object on the delivery bucket, `{ set, delete }`:
 * whole blocks, and the names it deletes.
 *
 * Two storages over it:
 *
 * - {@link createDraftContentStorage}, what the editor reads (the form, the
 *   poll, the changes, a discard): the default branch's saved blocks read
 *   through the GitHub API, with the draft layered on top, the way the
 *   site's SDK layers a draft for a preview. A draft `set` name replaces
 *   every spelling of that name with one file, `blockFileName(name)`; a
 *   `delete` name hides every spelling. The changes (`changes.*`) are the
 *   draft's own names, against main's head. One instance serves one
 *   request and reads main once for it (head, listing, schema), so the
 *   poll's `changes.list` adds no GitHub call to its `blocks.list`.
 * - {@link createDraftWriteStorage}, what a save (`blocks.apply`) goes
 *   through: the draft alone, never GitHub, never a schema. It is an
 *   overlay storage (`writeSnapshot()`, protocol 1.2's `describe.overlay`):
 *   a save writes the whole block into the draft, over whatever the draft
 *   had for it; a delete writes the name into `delete`, a tombstone. Its
 *   guards (`ifMatch`) compare with the draft: a block's version is its
 *   version in the draft, `TOMBSTONE_VERSION` when the draft deletes it,
 *   `null` when the draft doesn't hold it (main's copy is not the draft's).
 *
 * The revision is `<main head>~<draft ETag>` (`hostedRevision`), so a save
 * or a new main commit is a new revision. A save, which never reads main,
 * answers an empty main part.
 *
 * Every draft write is conditional on the draft as read (the draft store's
 * If-Match), and the guards are checked on the draft it lands on, so two
 * saves of different blocks landing together on different API processes
 * are both kept, and two of the same block: the last writer wins unless it
 * is guarded.
 */

import {
  blockFileName,
  blockNameFromFile,
  type CommitAttempt,
  type CommitResult,
  type ContentStorage,
  type StorageBase,
  type StorageChanges,
  type StorageDescription,
  type StorageFile,
  type StorageSnapshot,
  type StoredFileBody,
  fullyDecodeFileName,
  serializeBlock,
  spellingKey,
  TOMBSTONE_VERSION,
  unsupported,
} from "@decocms/blocks/protocol";
import { hostedRevision } from "@decocms/shared/blocks-major";
import type { RepoContentClient } from "@/git-providers";
import { gitBlobSha } from "@/decofile/read-decofile";
import { createRepoContentReader } from "@/decofile/repo-content-storage";
import { bareEtag, ObjectChangedError } from "./delivery-store";
import type { DraftBody, DraftStore, HostedDraftRef } from "./draft-store";

/** The spelling group (fully decoded name) a saved-block file belongs to. */
function groupOf(file: string): string {
  return fullyDecodeFileName(file).name;
}

function draftRevision(mainSha: string, etag: string | null): string {
  return hostedRevision(mainSha, bareEtag(etag));
}

const EMPTY_DRAFT: DraftBody = { set: {}, delete: [] };

/** The draft's own block files (its `set`), with their texts. */
function draftFiles(draft: DraftBody): {
  files: StorageFile[];
  texts: Map<string, string>;
} {
  const files: StorageFile[] = [];
  const texts = new Map<string, string>();
  for (const [name, entry] of Object.entries(draft.set)) {
    const file = blockFileName(name);
    const text = serializeBlock(entry);
    texts.set(file, text);
    files.push({
      file,
      version: gitBlobSha(text),
      size: Buffer.byteLength(text),
    });
  }
  return { files, texts };
}

/**
 * The draft as a save sees it (the write storage's `writeSnapshot()`): its
 * own block files and, for each name it deletes, a tombstone listed
 * `deleted: true` at `TOMBSTONE_VERSION` (no body). A deleted block is in
 * the draft: "must not exist in the draft" fails on it.
 */
function draftOverlayFiles(draft: DraftBody): {
  files: StorageFile[];
  texts: Map<string, string>;
} {
  const own = draftFiles(draft);
  const held = new Set(Object.keys(draft.set).map(spellingKey));
  const tombstones = draft.delete
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

/** Main's files with the draft layered on; returns the draft files' texts too. */
function layerDraftFiles(
  mainFiles: StorageFile[],
  draft: DraftBody,
): { files: StorageFile[]; texts: Map<string, string> } {
  const touched = new Set(
    [...Object.keys(draft.set), ...draft.delete].map(spellingKey),
  );
  const own = draftFiles(draft);
  return {
    files: [
      ...mainFiles.filter((f) => !touched.has(groupOf(f.file))),
      ...own.files,
    ],
    texts: own.texts,
  };
}

/**
 * The draft after one save (see the module note): a put sets the block,
 * whole, under the name written, dropping every other spelling of it and a
 * pending delete; a delete drops the name from `set` and records it in
 * `delete` (a name main doesn't have is harmless there: nothing to hide,
 * nothing to publish).
 */
export function applyAttemptToDraft(
  draft: DraftBody,
  attempt: { put: Record<string, string>; delete: string[] },
): DraftBody {
  const set = { ...draft.set };
  const deleted = new Set(draft.delete);
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
    // The core deletes a written name's other spellings in the same attempt.
    if (putGroups.has(group)) continue;
    dropGroup(group);
    deleted.add(blockNameFromFile(file));
  }
  return {
    set: Object.fromEntries(Object.entries(set)),
    delete: [...deleted].sort(),
  };
}

/** The draft without any name of `groups` (spelling groups): main shows through. */
function dropGroupsFromDraft(
  draft: DraftBody,
  groups: ReadonlySet<string>,
): DraftBody {
  return {
    set: Object.fromEntries(
      Object.entries(draft.set).filter(
        ([name]) => !groups.has(spellingKey(name)),
      ),
    ),
    delete: draft.delete.filter((name) => !groups.has(spellingKey(name))),
  };
}

/** Thrown inside the draft lock when an attempt's `expected` versions moved. */
const STALE_DRAFT = Symbol("stale draft");

/**
 * Throws {@link STALE_DRAFT} unless every `expected` file is in `files` at
 * the version expected (`null`: absent).
 */
function checkExpected(
  files: StorageFile[],
  expected: Record<string, string | null>,
) {
  const entries = Object.entries(expected);
  if (entries.length === 0) return;
  const now = new Map(files.map((f) => [f.file, f.version]));
  for (const [file, version] of entries) {
    if ((now.get(file) ?? null) !== version) throw STALE_DRAFT;
  }
}

/** A draft write that lost a race: the core reads again and retries. */
function isStaleWrite(error: unknown): boolean {
  return error === STALE_DRAFT || error instanceof ObjectChangedError;
}

function describeGit(packagePath: string | null): StorageDescription {
  return {
    kind: "git",
    root: packagePath ?? ".",
    readOnly: false,
    // Uploads go to Studio's own file storage, never into the repository.
    assets: null,
  };
}

/** The versions a save answers: each written block's, as the draft holds it. */
function putVersions(put: Record<string, string>): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const [file, content] of Object.entries(put)) {
    versions[file] = gitBlobSha(serializeBlock(JSON.parse(content)));
  }
  return versions;
}

/**
 * The storage a hosted save (`blocks.apply`) runs on: the draft alone (see
 * the module note). It never reads GitHub or a schema, so a save costs one
 * read and one conditional write of the draft object.
 *
 * An overlay storage: `writeSnapshot()` is the draft, its blocks and a
 * tombstone for each name it deletes, so a deleted block is in the draft
 * for a guard, and the core names every delete's file even when the draft
 * doesn't hold it (a block only main has). A commit checks its guards on
 * the draft it lands on, and answers `TOMBSTONE_VERSION` for each deletion
 * it records: every delete, since a save can't see main.
 */
export function createDraftWriteStorage(options: {
  packagePath: string | null;
  drafts: DraftStore;
  ref: HostedDraftRef;
}): ContentStorage {
  const { drafts, ref } = options;
  /** Each listing's block texts, by revision, for `readFiles`. */
  const texts = new Map<string, Map<string, string>>();
  const notMain = (): never => {
    throw unsupported("a save reads the draft only");
  };

  /** The draft's overlay; `snapshot()` (no main part) leaves the tombstones out. */
  const listDraft = async (withTombstones: boolean) => {
    const draft = await drafts.load(ref);
    const own = draftOverlayFiles(draft?.body ?? EMPTY_DRAFT);
    const revision = draftRevision("", draft?.etag ?? null);
    texts.set(revision, own.texts);
    return {
      revision,
      resolvedRef: null,
      files: withTombstones ? own.files : own.files.filter((f) => !f.deleted),
    } satisfies StorageSnapshot;
  };

  return {
    describe: () => describeGit(options.packagePath),

    snapshot: () => listDraft(false),
    writeSnapshot: () => listDraft(true),

    readFiles: async (snap, files) => {
      const own = texts.get(snap.revision) ?? new Map<string, string>();
      const out: Record<string, StoredFileBody> = {};
      for (const file of files) {
        const text = own.get(file);
        if (text !== undefined) out[file] = { text, version: gitBlobSha(text) };
      }
      return out;
    },

    // No schema: nothing about a save depends on one.
    readSchema: async () => null,

    commit: async (attempt): Promise<CommitResult> => {
      if (attempt.reason === "discard") notMain();
      const versions = putVersions(attempt.put);
      try {
        const saved = await drafts.update(ref, (body) => {
          checkExpected(draftOverlayFiles(body).files, attempt.expected);
          const next = applyAttemptToDraft(body, attempt);
          const recorded = new Set(next.delete.map(spellingKey));
          for (const file of attempt.delete) {
            if (recorded.has(groupOf(file))) versions[file] = TOMBSTONE_VERSION;
          }
          return next;
        });
        return {
          status: "committed",
          revision: draftRevision("", saved.etag),
          versions,
        };
      } catch (error) {
        if (isStaleWrite(error)) return { status: "stale" };
        throw error;
      }
    },

    base: async () => notMain(),
    changes: async () => notMain(),
    readBaseFiles: async () => notMain(),
  };
}

export function createDraftContentStorage(options: {
  client: RepoContentClient;
  packagePath: string | null;
  /** The default branch: what the draft is layered on and published to. */
  mainBranch: string;
  drafts: DraftStore;
  ref: HostedDraftRef;
}): ContentStorage {
  const { drafts, ref } = options;
  const main = createRepoContentReader({
    client: options.client,
    packagePath: options.packagePath,
    branch: options.mainBranch,
  });
  /** The drafts (and their files' texts) of the snapshots handed out. */
  const layered = new Map<
    string,
    { body: DraftBody; texts: Map<string, string> }
  >();
  /** Main's listings by commit sha (immutable), from this storage's reads. */
  const mainListings = new Map<string, StorageSnapshot>();
  /**
   * Main as this storage first read it: one storage serves one request (the
   * editor's poll batches `blocks.list`, `schema.get` and `changes.list`),
   * and every call of it reads main's head, listing and schema from this
   * one read, so `changes.list` costs no GitHub call of its own. A commit
   * (a discard) reads main again and replaces it.
   */
  let mainRead: Promise<StorageSnapshot> | null = null;
  const readMain = (fresh = false): Promise<StorageSnapshot> => {
    if (!mainRead || fresh) {
      const read = main.snapshot();
      mainRead = read;
      // A failed read isn't kept: the next call reads again.
      read.catch(() => {
        if (mainRead === read) mainRead = null;
      });
    }
    return mainRead;
  };
  const mainAt = async (base: StorageBase): Promise<StorageSnapshot> => {
    const known = mainListings.get(base.revision);
    if (known) return known;
    const listing = await main.snapshotAt(
      base.revision,
      base.resolvedRef ?? options.mainBranch,
    );
    mainListings.set(base.revision, listing);
    return listing;
  };

  const snapshot = async (): Promise<StorageSnapshot> => {
    const [base, draft] = await Promise.all([readMain(), drafts.load(ref)]);
    mainListings.set(base.revision, base);
    const body = draft?.body ?? EMPTY_DRAFT;
    const { files, texts } = layerDraftFiles(base.files, body);
    const revision = draftRevision(base.revision, draft?.etag ?? null);
    layered.set(revision, { body, texts });
    return { revision, resolvedRef: base.resolvedRef, files };
  };

  /**
   * Drops the discarded names from the draft: what the layered read serves
   * for them is main's files again, byte for byte (the core only restores
   * files main has now, `expectedBase` saw to that).
   */
  const discard = async (
    base: StorageSnapshot,
    attempt: CommitAttempt,
  ): Promise<CommitResult> => {
    const onMain = new Map(base.files.map((f) => [f.file, f.version]));
    const versions: Record<string, string> = {};
    for (const file of Object.keys(attempt.put)) {
      const version = onMain.get(file);
      if (version === undefined) return { status: "stale" };
      versions[file] = version;
    }
    const groups = new Set(
      [...Object.keys(attempt.put), ...attempt.delete].map(groupOf),
    );
    try {
      const saved = await drafts.update(ref, (body) => {
        checkExpected(
          layerDraftFiles(base.files, body).files,
          attempt.expected,
        );
        return dropGroupsFromDraft(body, groups);
      });
      return {
        status: "committed",
        revision: draftRevision(base.revision, saved.etag),
        versions,
      };
    } catch (error) {
      if (isStaleWrite(error)) return { status: "stale" };
      throw error;
    }
  };

  return {
    describe: () => describeGit(options.packagePath),

    snapshot,

    readFiles: async (snap, files) => {
      const texts =
        layered.get(snap.revision)?.texts ?? new Map<string, string>();
      const out: Record<string, StoredFileBody> = {};
      const fromMain: string[] = [];
      for (const file of files) {
        const text = texts.get(file);
        if (text === undefined) fromMain.push(file);
        else out[file] = { text, version: gitBlobSha(text) };
      }
      if (fromMain.length > 0) {
        Object.assign(out, await main.readFiles(snap, fromMain));
      }
      return out;
    },

    readSchema: async () => {
      const head = await readMain();
      return main.readSchemaAt({
        sha: head.revision,
        ref: head.resolvedRef ?? options.mainBranch,
      });
    },

    base: async (): Promise<StorageBase> => {
      const head = await readMain();
      return { revision: head.revision, resolvedRef: head.resolvedRef };
    },

    /**
     * The draft's own names, each one a change even when it holds main's
     * content (the list is the draft, decision of the hosted editor), and
     * main's files of the names it touches. A delete of a name main doesn't
     * have hides nothing: not a change.
     */
    changes: async (base, snap): Promise<StorageChanges> => {
      const onMain = await mainAt(base);
      const body =
        layered.get(snap.revision)?.body ??
        (await drafts.load(ref))?.body ??
        EMPTY_DRAFT;
      const mainGroups = new Set(onMain.files.map((f) => groupOf(f.file)));
      const touched = new Set([
        ...Object.keys(body.set).map(spellingKey),
        ...body.delete.map(spellingKey).filter((g) => mainGroups.has(g)),
      ]);
      const files = new Set(Object.keys(body.set).map(blockFileName));
      for (const f of onMain.files) {
        if (touched.has(groupOf(f.file))) files.add(f.file);
      }
      return { files: [...files].sort(), baseFiles: onMain.files };
    },

    readBaseFiles: async (base, files) =>
      main.readFiles(await mainAt(base), files),

    /**
     * A discard (`changes.discard`), or a save batched with reads (an editor
     * sends its saves alone, through {@link createDraftWriteStorage}): the
     * same draft write, its guards checked on main with the draft on top.
     */
    commit: async (attempt): Promise<CommitResult> => {
      const base = await readMain(true);
      mainListings.set(base.revision, base);
      if (
        attempt.expectedBase !== undefined &&
        base.revision !== attempt.expectedBase
      ) {
        return { status: "stale" };
      }
      if (attempt.reason === "discard") return discard(base, attempt);
      const versions = putVersions(attempt.put);
      try {
        const saved = await drafts.update(ref, (body) => {
          checkExpected(
            layerDraftFiles(base.files, body).files,
            attempt.expected,
          );
          return applyAttemptToDraft(body, attempt);
        });
        return {
          status: "committed",
          revision: draftRevision(base.revision, saved.etag),
          versions,
        };
      } catch (error) {
        if (isStaleWrite(error)) return { status: "stale" };
        throw error;
      }
    },
  };
}

/**
 * The storage for a project whose main isn't a Blocks v8 site (a v7 site):
 * read only, no schema, no saved blocks. It answers `describe` and
 * `schema.get` (`schema: null`) so the editor reads main's answer from the
 * same content-protocol route a v8 editor uses, deciding with `isV8Schema`,
 * with no read beyond the server's own cached `projectMainIsV8`. Never
 * writes: a v7 site is edited the v7 way.
 */
export function createV7MainStorage(options: {
  packagePath?: string | null;
  mainBranch: string;
}): ContentStorage {
  return {
    describe: () => ({
      kind: "git",
      root: options.packagePath ?? ".",
      readOnly: true,
      assets: null,
    }),
    snapshot: async () => ({
      revision: "not-v8",
      resolvedRef: options.mainBranch,
      files: [],
    }),
    readFiles: async () => ({}),
    readSchema: async () => null,
    commit: async () => {
      throw unsupported("not a Blocks v8 site");
    },
    // No saved blocks, so nothing differs from main.
    base: async () => ({
      revision: "not-v8",
      resolvedRef: options.mainBranch,
    }),
    changes: async () => ({ files: [], baseFiles: [] }),
    readBaseFiles: async () => ({}),
  };
}
