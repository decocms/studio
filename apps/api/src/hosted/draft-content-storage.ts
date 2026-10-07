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
 *   draft-only X just drops it from `set`. The last writer wins (no stale
 *   check against the draft); the schema is still checked against main's.
 */

import {
  blockFileName,
  blockNameFromFile,
  type CommitResult,
  type ContentStorage,
  type StorageDescription,
  type StorageFile,
  type StorageSnapshot,
  type StoredFileBody,
  fullyDecodeFileName,
  serializeBlock,
  spellingKey,
  unsupported,
} from "@decocms/blocks/protocol";
import type { RepoContentClient } from "@/git-providers";
import { gitBlobSha } from "@/decofile/read-decofile";
import { createRepoContentReader } from "@/decofile/repo-content-storage";
import { bareEtag } from "./delivery-store";
import type { DraftBody, DraftStore, HostedDraftRef } from "./draft-store";

/** The spelling group (fully decoded name) a saved-block file belongs to. */
function groupOf(file: string): string {
  return fullyDecodeFileName(file).name;
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
 * the spelling groups that exist on main.
 */
export function applyAttemptToDraft(
  draft: DraftBody,
  attempt: { put: Record<string, string>; delete: string[] },
  mainGroups: ReadonlySet<string>,
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
    if (mainGroups.has(group)) deleted.add(blockNameFromFile(file));
  }
  return {
    set: Object.fromEntries(Object.entries(set)),
    delete: [...deleted].sort(),
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
  /** Draft file texts of the snapshots this storage handed out. */
  const draftTexts = new Map<string, Map<string, string>>();

  const snapshot = async (): Promise<StorageSnapshot> => {
    const [base, draft] = await Promise.all([
      main.snapshot(),
      drafts.load(ref),
    ]);
    const { files, texts } = layerDraftFiles(
      base.files,
      draft?.body ?? { set: {}, delete: [] },
    );
    const revision = draftRevision(base.revision, draft?.etag ?? null);
    draftTexts.set(revision, texts);
    return { revision, resolvedRef: base.resolvedRef, files };
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
      const saved = await drafts.update(ref, (body) =>
        applyAttemptToDraft(body, attempt, mainGroups),
      );
      return {
        status: "committed",
        revision: draftRevision(base.revision, saved.etag),
        versions,
      };
    },
  };
}
