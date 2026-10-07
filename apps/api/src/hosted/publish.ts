/**
 * Publish and Resync for a hosted v8 site, in the order the product decided:
 *
 *   1. commit the draft directly to main (fast-forward only, no PR);
 *   2. PUT sites/<site>/revisions/<commit>.json;
 *   3. re-read main's head; only if it is still that commit, PUT latest.json;
 *   4. delete the draft (once step 1 landed: its changes are in git now).
 *
 * Git is the source of truth: a failure after step 1 leaves the site
 * "pending" (running sites keep what they serve) and Resync reruns steps 2–3
 * from main's head. Rollback (Releases → Make current) rewrites latest.json
 * only, and the next Publish or Resync overrides it.
 */

import {
  appendCoAuthorTrailer,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";
import {
  blockFileName,
  blockNameFromFile,
  fullyDecodeFileName,
  serializeBlock,
  spellingKey,
} from "@decocms/blocks/protocol";
import {
  type FileChange,
  type RepoContentClient,
  RepoWriteConflict,
  requireBranchHead,
  type TreeEntry,
} from "@/git-providers";
import {
  decofileCommitMessage,
  regenerateGenArtifact,
} from "@/decofile/gen-artifact";
import {
  type BlockSource,
  blockEntriesInTree,
  blocksDirPath,
  primeBlobCache,
} from "@/decofile/read-decofile";
import {
  CACHE_LATEST,
  CACHE_REVISION,
  type DeliveryStore,
  deliveryKeys,
  getJson,
} from "./delivery-store";
import {
  type DraftBody,
  type DraftStore,
  type HostedDraftRef,
  isEmptyDraft,
} from "./draft-store";
import { buildRevision } from "./release-objects";

/** Main moved while the draft was being committed: nothing was published. */
export class MainMovedError extends Error {
  constructor() {
    super("main moved; publish again");
    this.name = "MainMovedError";
  }
}

/** Resync would override a rollback and wasn't confirmed. */
export class RolledBackError extends Error {
  constructor() {
    super("rolled-back");
    this.name = "RolledBackError";
  }
}

export interface LatestPointer {
  revision: string;
  schemaHash: string;
  publishedAt: string;
}

function parseLatest(value: unknown): LatestPointer | null {
  const v = value as Partial<LatestPointer> | null;
  return typeof v === "object" &&
    v !== null &&
    typeof v.revision === "string" &&
    typeof v.schemaHash === "string" &&
    typeof v.publishedAt === "string"
    ? {
        revision: v.revision,
        schemaHash: v.schemaHash,
        publishedAt: v.publishedAt,
      }
    : null;
}

export async function readLatest(
  store: DeliveryStore,
  site: string,
): Promise<LatestPointer | null> {
  const object = await getJson(store, deliveryKeys.latest(site));
  return object ? parseLatest(object.value) : null;
}

/** Whether `sites/<site>/revisions/<sha>.json` exists (a listing, not a read). */
async function hasRevision(
  store: DeliveryStore,
  site: string,
  sha: string,
): Promise<boolean> {
  const key = deliveryKeys.revision(site, sha);
  return (await store.listKeys(key)).includes(key);
}

export interface HostedRepo {
  client: RepoContentClient;
  packagePath: string | null;
  mainBranch: string;
  store: DeliveryStore;
  site: string;
}

export type PublishResult =
  | { result: "published"; sha: string }
  | { result: "pending"; sha: string }
  | { result: "up-to-date" };

/**
 * The file changes that apply a draft to the tree at `headSha`: a set name
 * writes its existing spelling's file (else the protocol's file name) and
 * drops its other spellings; a delete name removes every spelling.
 */
export async function draftFileChanges(
  repo: Pick<HostedRepo, "client" | "packagePath">,
  headSha: string,
  draft: DraftBody,
): Promise<{
  changes: FileChange[];
  tree: TreeEntry[];
  next: Map<string, BlockSource>;
}> {
  const prefix = `${blocksDirPath(repo.packagePath)}/`;
  const tree = await repo.client.listDecofileEntries(headSha, repo.packagePath);
  const entries = blockEntriesInTree(tree, repo.packagePath);
  const next = new Map<string, BlockSource>(
    entries.map((e) => [e.path, { stem: e.stem, sha: e.sha }]),
  );
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const group = fullyDecodeFileName(entry.path.slice(prefix.length)).name;
    groups.set(group, [...(groups.get(group) ?? []), entry.path]);
  }
  const changes: FileChange[] = [];
  const remove = (path: string) => {
    changes.push({ path, deleted: true });
    next.delete(path);
  };
  for (const [name, entry] of Object.entries(draft.set)) {
    const spellings = groups.get(spellingKey(name)) ?? [];
    // The existing spelling's file when there is one, else the protocol's.
    const path =
      spellings.find(
        (p) => blockNameFromFile(p.slice(prefix.length)) === name,
      ) ?? `${prefix}${blockFileName(name)}`;
    const content = serializeBlock(entry);
    changes.push({ path, content });
    next.set(path, {
      stem: path.slice(prefix.length, -".json".length),
      content,
    });
    await primeBlobCache(repo.client.repo, content);
    for (const other of spellings) if (other !== path) remove(other);
  }
  for (const name of draft.delete) {
    for (const path of groups.get(spellingKey(name)) ?? []) remove(path);
  }
  return { changes, tree, next };
}

/** Step 1: one fast-forward commit on main. Returns the commit sha. */
async function commitDraftToMain(
  repo: HostedRepo,
  draft: DraftBody,
  message: string,
): Promise<string> {
  const headSha = await requireBranchHead(repo.client, repo.mainBranch);
  const { changes, tree, next } = await draftFileChanges(repo, headSha, draft);
  if (changes.length === 0) return headSha;
  const gen = await regenerateGenArtifact({
    client: repo.client,
    tree,
    packagePath: repo.packagePath,
    branch: repo.mainBranch,
    nextBlocks: next.values(),
    memo: new Map(),
  });
  if (gen) changes.push(gen);
  try {
    // No `rewriteFrom`: the ref only moves by fast-forward from `headSha`.
    const { sha } = await repo.client.commitFiles({
      branch: repo.mainBranch,
      message,
      expectedHead: headSha,
      changes,
    });
    return sha;
  } catch (error) {
    // OPEN: O-9 — a non-fast-forward stops with "main moved", no retry.
    if (error instanceof RepoWriteConflict) throw new MainMovedError();
    throw error;
  }
}

/**
 * Steps 2–3 for commit `sha`: the revision object, then the pointer, but only
 * while `sha` is still main's head. Returns whether the pointer was written.
 */
async function releaseCommit(
  repo: HostedRepo,
  sha: string,
  hooks: { beforePointerWrite?: () => Promise<void> } = {},
): Promise<boolean> {
  const revision = await buildRevision(repo.client, repo.packagePath, sha);
  await repo.store.putJson(
    deliveryKeys.revision(repo.site, sha),
    revision,
    CACHE_REVISION,
  );
  await hooks.beforePointerWrite?.();
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  if (head !== sha) return false;
  // OPEN: O-10 — a plain PUT; a race lost after the head check shows as
  // "Rolled back"/pending in Releases and Resync fixes it.
  const pointer: LatestPointer = {
    revision: sha,
    schemaHash: revision.schemaHash,
    publishedAt: new Date().toISOString(),
  };
  await repo.store.putJson(
    deliveryKeys.latest(repo.site),
    pointer,
    CACHE_LATEST,
  );
  return true;
}

/** Publish: steps 1–4 for the draft of `ref`. */
export async function publishDraft(
  repo: HostedRepo,
  drafts: DraftStore,
  ref: HostedDraftRef,
  note: { message: string; coAuthor?: CoAuthorIdentity | null },
  hooks: { beforePointerWrite?: () => Promise<void> } = {},
): Promise<PublishResult> {
  const draft = await drafts.load(ref);
  // OPEN: O-26 — nothing to publish answers the popover's existing no-changes state.
  if (!draft || isEmptyDraft(draft.body)) return { result: "up-to-date" };
  const message = note.message.trim()
    ? appendCoAuthorTrailer(note.message.trim(), note.coAuthor)
    : decofileCommitMessage(
        Object.keys(draft.body.set),
        draft.body.delete,
        note.coAuthor,
      );
  const sha = await commitDraftToMain(repo, draft.body, message);
  try {
    const live = await releaseCommit(repo, sha, hooks);
    return { result: live ? "published" : "pending", sha };
  } catch (error) {
    console.error("hosted publish: delivery write failed; pending", {
      site: repo.site,
      sha,
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: "pending", sha };
  } finally {
    // OPEN: O-11 — the draft goes once git has it, even when delivery failed.
    await drafts.remove(ref).catch((error) =>
      console.error("hosted publish: draft delete failed", {
        site: repo.site,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Resync: steps 2–3 from main's head. While the site is rolled back
 * (latest.json names another published revision), it needs `confirm`.
 */
export async function resync(
  repo: HostedRepo,
  options: { confirm: boolean },
): Promise<PublishResult> {
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  if (!options.confirm) {
    const latest = await readLatest(repo.store, repo.site);
    if (
      latest &&
      latest.revision !== head &&
      (await hasRevision(repo.store, repo.site, latest.revision).catch(
        () => false,
      ))
    ) {
      throw new RolledBackError();
    }
  }
  const live = await releaseCommit(repo, head);
  return { result: live ? "published" : "pending", sha: head };
}
