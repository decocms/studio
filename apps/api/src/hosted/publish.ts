/**
 * Publish and Resync for a hosted v8 site, in the order the product decided:
 *
 *   1. commit the draft directly to main (fast-forward only, no PR);
 *   2. delete the draft: Publish is done once the commit is on main;
 *   3. PUT sites/<site>/revisions/<commit>.json;
 *   4. re-read main's head; only if it is still that commit, PUT latest.json
 *      and purge its URL from Cloudflare's edge (5 s per attempt, one retry).
 *
 * Git is the source of truth. A failed commit fails Publish and keeps the
 * draft. A failure in steps 3–4 (main moved, a failed pointer write or purge)
 * doesn't fail it: the result is "merged" with `cdn: "failed"`, nothing is
 * restored or rolled back, and Releases shows the newest release as Failed
 * until a Resync (steps 3–4 from main's head) makes it live. Rollback
 * (Releases → Make current) rewrites latest.json only, and the next Publish
 * or Resync overrides it.
 * Every latest.json write stamps `publishedAt` now: the SDK prefers the CDN
 * only when it is later than its bundle's build time.
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
import type { DeliveryPurge } from "./delivery-purge";
import {
  type DraftBody,
  type DraftStore,
  type HostedDraftRef,
  isEmptyDraft,
} from "./draft-store";
import { buildRevision, schemaHashAt } from "./release-objects";

/** Main moved while the draft was being committed: nothing was published. */
export class MainMovedError extends Error {
  constructor() {
    super("main moved; publish again");
    this.name = "MainMovedError";
  }
}

/**
 * Writing latest.json or purging it from the edge (after its one retry)
 * failed. Nothing is restored: the user resyncs from Releases.
 */
export class LatestUpdateError extends Error {
  constructor(cause: unknown) {
    super(
      `Couldn't update the live version on the CDN (${
        cause instanceof Error ? cause.message : String(cause)
      }). Running sites may not serve it yet. Try again.`,
    );
    this.name = "LatestUpdateError";
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
  /** Purges latest.json from the edge after each write of it. */
  purge: DeliveryPurge;
  site: string;
}

/** Whether the CDN step made a commit live on running sites. */
export type CdnStatus = "live" | "failed";

/** "merged": the draft is on main (Publish is done); `cdn` says if it's live. */
export type PublishResult =
  | { result: "merged"; sha: string; cdn: CdnStatus }
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
 * Step 3 for commit `sha`: its revision object, written only when missing
 * (revisions are immutable). Returns the revision's schemaHash.
 */
async function ensureRevision(repo: HostedRepo, sha: string): Promise<string> {
  if (await hasRevision(repo.store, repo.site, sha)) {
    return schemaHashAt(repo.client, repo.packagePath, sha);
  }
  const revision = await buildRevision(repo.client, repo.packagePath, sha);
  await repo.store.putJson(
    deliveryKeys.revision(repo.site, sha),
    revision,
    CACHE_REVISION,
  );
  return revision.schemaHash;
}

/**
 * Writes latest.json, then purges its URL from the edge (5 s per attempt,
 * exactly one retry). Either failing throws {@link LatestUpdateError}: no
 * restore of the previous pointer, no other recovery (a failed write skips
 * the purge).
 */
export async function writeLatest(
  repo: Pick<HostedRepo, "store" | "purge" | "site">,
  pointer: LatestPointer,
): Promise<void> {
  const key = deliveryKeys.latest(repo.site);
  try {
    await repo.store.putJson(key, pointer, CACHE_LATEST);
    await repo.purge.purge(key);
  } catch (error) {
    throw new LatestUpdateError(error);
  }
}

/**
 * Steps 3–4 for commit `sha`: the revision object, then the pointer and its
 * purge, but only while `sha` is still main's head. Returns whether the
 * pointer was written.
 */
export async function releaseCommit(
  repo: HostedRepo,
  sha: string,
  hooks: { beforePointerWrite?: () => Promise<void> } = {},
): Promise<boolean> {
  const schemaHash = await ensureRevision(repo, sha);
  await hooks.beforePointerWrite?.();
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  if (head !== sha) return false;
  // OPEN: O-10 — a plain PUT; a race lost after the head check shows as
  // Failed in Releases and Resync fixes it.
  const pointer: LatestPointer = {
    revision: sha,
    schemaHash,
    publishedAt: new Date().toISOString(),
  };
  await writeLatest(repo, pointer);
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
  // Publish is done once the commit is on main: the draft goes now, whatever
  // the CDN step does. Only the save that was published goes: a save made
  // during the publish keeps the draft (its ETag changed).
  await drafts.remove(ref, draft.etag).catch((error) =>
    console.error("hosted publish: draft delete failed", {
      site: repo.site,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  try {
    const live = await releaseCommit(repo, sha, hooks);
    return { result: "merged", sha, cdn: live ? "live" : "failed" };
  } catch (error) {
    // Merged, but the CDN step failed: Releases offers Resync.
    console.error("hosted publish: CDN update failed", {
      site: repo.site,
      sha,
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: "merged", sha, cdn: "failed" };
  }
}
