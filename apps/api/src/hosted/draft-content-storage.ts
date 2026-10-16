/**
 * The site editor's content-protocol storage for a hosted v8 project on
 * GitHub: the default branch's saved blocks with the project's CDN draft
 * layered on top, the way the site's SDK layers it for a preview.
 *
 * - A draft `set` name replaces every spelling of that name with one file,
 *   `blockFileName(name)`; a `delete` name hides every spelling.
 * - The revision is `<main head>~<draft ETag>` (`~none` without a draft), so
 *   a save or a new main commit is a new revision.
 * - A commit edits the draft, never git: put X sets `set[X]` and drops X from
 *   `delete`; deleting X that exists on main moves it to `delete`; deleting a
 *   draft-only X just drops it from `set`. Putting X back to exactly main's
 *   content drops X from the draft instead of keeping a copy, which would
 *   hide a later change on main and never let the draft be empty. A save is
 *   last-writer-wins (no stale check against the draft); the schema is still
 *   checked against main's.
 * - The base (`changes.*`) is main's head: the changes are the files the
 *   draft makes differ from main, which are the draft's own names (a `set`
 *   byte-equal to main's one file isn't a change). A discard
 *   (`reason: "discard"`) drops the discarded names from the draft
 *   altogether, so main's files show through again, whatever their bytes
 *   (main may hold a file that isn't valid JSON) or spellings. It honours
 *   `expected` inside the draft lock and `expectedBase` against main's head.
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
  unsupported,
} from "@decocms/blocks/protocol";
import { canonicalBlockJson } from "@decocms/shared/decofile";
import type { RepoContentClient } from "@/git-providers";
import { gitBlobSha } from "@/decofile/read-decofile";
import { createRepoContentReader } from "@/decofile/repo-content-storage";
import { bareEtag } from "./delivery-store";
import type { DraftBody, DraftStore, HostedDraftRef } from "./draft-store";

/** The spelling group (fully decoded name) a saved-block file belongs to. */
function groupOf(file: string): string {
  return fullyDecodeFileName(file).name;
}

/**
 * Equal JSON values, whatever the key order. A block's `__meta` (who edited
 * it last) isn't content: a put of main's content with a new record is still
 * main's content.
 */
function sameJson(a: unknown, b: unknown): boolean {
  return canonicalBlockJson(a) === canonicalBlockJson(b);
}

function draftRevision(mainSha: string, etag: string | null): string {
  return `${mainSha}~${bareEtag(etag) ?? "none"}`;
}

/** Main's files with the draft layered on; returns the draft files' texts too. */
function layerDraftFiles(
  mainFiles: StorageFile[],
  draft: DraftBody,
): { files: StorageFile[]; texts: Map<string, string> } {
  const touched = new Set(
    [...Object.keys(draft.set), ...draft.delete].map(spellingKey),
  );
  const files = mainFiles.filter((f) => !touched.has(groupOf(f.file)));
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
 * The draft after one commit attempt (see the module note). `mainGroups` are
 * the spelling groups that exist on main; `sameAsMain`, the put groups whose
 * content is exactly main's.
 */
export function applyAttemptToDraft(
  draft: DraftBody,
  attempt: { put: Record<string, string>; delete: string[] },
  mainGroups: ReadonlySet<string>,
  sameAsMain: ReadonlySet<string> = new Set(),
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
    if (sameAsMain.has(group)) continue;
    set[blockNameFromFile(file)] = JSON.parse(content) as unknown;
  }
  for (const file of attempt.delete) {
    const group = groupOf(file);
    // The core deletes a written name's other spellings in the same attempt.
    if (putGroups.has(group)) continue;
    dropGroup(group);
    if (mainGroups.has(group)) deleted.add(blockNameFromFile(file));
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

/** The files of `snapshot` that differ from `base`, by version (git blob sha). */
function filesChangedFrom(
  base: StorageSnapshot,
  snapshot: StorageSnapshot,
): string[] {
  const inBase = new Map(base.files.map((f) => [f.file, f.version]));
  const inSnapshot = new Set(snapshot.files.map((f) => f.file));
  const files = snapshot.files
    .filter((f) => inBase.get(f.file) !== f.version)
    .map((f) => f.file);
  for (const file of inBase.keys()) {
    if (!inSnapshot.has(file)) files.push(file);
  }
  return files.sort();
}

/** Thrown inside the draft lock when a discard's `expected` versions moved. */
const STALE_DRAFT = Symbol("stale draft");

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
  /** Draft file texts of the snapshots this storage handed out. */
  const draftTexts = new Map<string, Map<string, string>>();
  /** Main's listings by commit sha (immutable), from this storage's reads. */
  const mainListings = new Map<string, StorageSnapshot>();
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
    const [base, draft] = await Promise.all([
      main.snapshot(),
      drafts.load(ref),
    ]);
    mainListings.set(base.revision, base);
    const { files, texts } = layerDraftFiles(
      base.files,
      draft?.body ?? { set: {}, delete: [] },
    );
    const revision = draftRevision(base.revision, draft?.etag ?? null);
    draftTexts.set(revision, texts);
    return { revision, resolvedRef: base.resolvedRef, files };
  };

  /**
   * The put groups whose content equals main's one file for that name: byte
   * for byte by blob sha (as the Publish compares them), else as JSON values
   * (main's file may be formatted or ordered otherwise).
   */
  const groupsSameAsMain = async (
    base: StorageSnapshot,
    put: Record<string, string>,
  ): Promise<Map<string, StorageFile>> => {
    const same = new Map<string, StorageFile>();
    const toRead: Array<{ group: string; main: StorageFile; value: unknown }> =
      [];
    for (const [file, content] of Object.entries(put)) {
      const group = groupOf(file);
      const onMain = base.files.filter((f) => groupOf(f.file) === group);
      if (onMain.length !== 1) continue;
      const value: unknown = JSON.parse(content);
      const mainFile = onMain[0]!;
      if (mainFile.version === gitBlobSha(serializeBlock(value))) {
        same.set(group, mainFile);
      } else toRead.push({ group, main: mainFile, value });
    }
    if (toRead.length === 0) return same;
    const bodies = await main.readFiles(
      base,
      toRead.map((r) => r.main.file),
    );
    for (const { group, main: mainFile, value } of toRead) {
      const body = bodies[mainFile.file]?.text;
      if (body === undefined) continue;
      try {
        if (sameJson(JSON.parse(body), value)) same.set(group, mainFile);
      } catch {
        // Main's file isn't JSON: never equal to a block.
      }
    }
    return same;
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
    const expected = Object.entries(attempt.expected);
    try {
      const saved = await drafts.update(ref, (body) => {
        if (expected.length > 0) {
          const now = new Map(
            layerDraftFiles(base.files, body).files.map((f) => [
              f.file,
              f.version,
            ]),
          );
          for (const [file, version] of expected) {
            if ((now.get(file) ?? null) !== version) throw STALE_DRAFT;
          }
        }
        return dropGroupsFromDraft(body, groups);
      });
      return {
        status: "committed",
        revision: draftRevision(base.revision, saved.etag),
        versions,
      };
    } catch (error) {
      if (error === STALE_DRAFT) return { status: "stale" };
      throw error;
    }
  };

  return {
    describe(): StorageDescription {
      const description = {
        kind: "git" as const,
        root: options.packagePath ?? ".",
        readOnly: false,
        // Uploads go to Studio's own file storage, never into the repository.
        assets: null,
      };
      return description;
    },

    snapshot,

    readFiles: async (snap, files) => {
      const texts = draftTexts.get(snap.revision) ?? new Map<string, string>();
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

    readSchema: () => main.readSchema(),
    readSecretsPublicKey: () => main.readSecretsPublicKey(),

    base: async (): Promise<StorageBase> => {
      const head = await main.head();
      return { revision: head.sha, resolvedRef: head.ref };
    },

    changes: async (base, snap): Promise<StorageChanges> => {
      const onMain = await mainAt(base);
      return {
        files: filesChangedFrom(onMain, snap),
        baseFiles: onMain.files,
      };
    },

    readBaseFiles: async (base, files) =>
      main.readFiles(await mainAt(base), files),

    commit: async (attempt): Promise<CommitResult> => {
      // Never write a v7 site through the protocol, even by a direct call.
      const schema = await main.readSchema();
      if (!schema) throw unsupported("not a Blocks v8 site");
      if (
        attempt.expectedSchemaVersion !== undefined &&
        schema.version !== attempt.expectedSchemaVersion
      ) {
        return { status: "stale" };
      }
      const base = await main.snapshot();
      mainListings.set(base.revision, base);
      if (
        attempt.expectedBase !== undefined &&
        base.revision !== attempt.expectedBase
      ) {
        return { status: "stale" };
      }
      if (attempt.reason === "discard") return discard(base, attempt);
      const mainGroups = new Set(base.files.map((f) => groupOf(f.file)));
      const versions: Record<string, string> = {};
      for (const [file, content] of Object.entries(attempt.put)) {
        versions[file] = gitBlobSha(serializeBlock(JSON.parse(content)));
      }
      if (Object.keys(attempt.put).length + attempt.delete.length === 0) {
        const current = await drafts.load(ref);
        return {
          status: "committed",
          revision: draftRevision(base.revision, current?.etag ?? null),
          versions,
        };
      }
      const sameAsMain = await groupsSameAsMain(base, attempt.put);
      // What the layered read now serves for those names is main's file.
      for (const file of Object.keys(attempt.put)) {
        const mainFile = sameAsMain.get(groupOf(file));
        if (mainFile?.file === file) versions[file] = mainFile.version;
      }
      const saved = await drafts.update(ref, (body) =>
        applyAttemptToDraft(
          body,
          attempt,
          mainGroups,
          new Set(sameAsMain.keys()),
        ),
      );
      return {
        status: "committed",
        revision: draftRevision(base.revision, saved.etag),
        versions,
      };
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
    readSecretsPublicKey: async () => null,
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
