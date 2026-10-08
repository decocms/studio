/**
 * Publish for a hosted v8 site:
 *
 *   1. commit the draft directly to main (fast-forward only, no PR);
 *   2. delete the draft: the merge is done;
 *   3. write the commit's companion release, the immutable
 *      sites/<site>/revisions/<commit>.json;
 *   4. make it current: write latest.json and purge its URL from Cloudflare's
 *      edge (5 s per attempt, one retry), only while the commit is still
 *      main's head, so an older Publish never replaces a newer one.
 *
 * Git is the source of truth for content; latest.json alone says what the CDN
 * serves ("Current"). A failed commit fails Publish and keeps the draft. A
 * failure in step 3 or 4 doesn't undo the merge: the result says which step
 * failed, nothing is restored, and Releases → Make current retries step 4. A
 * draft that commits nothing leaves latest.json alone.
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
  gitBlobSha,
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
 * failed. Nothing is restored: the user tries Make current again.
 */
export class LatestUpdateError extends Error {
  constructor(cause: unknown) {
    super(
      `Making it current on the CDN failed (${
        cause instanceof Error ? cause.message : String(cause)
      }). Try again.`,
    );
    this.name = "LatestUpdateError";
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

/**
 * What a merged Publish did on the CDN: `current` (companion written and made
 * current), `created` (companion written, making it current failed) or
 * `none` (no companion: the next Publish includes these changes).
 */
export type ReleaseOutcome = "current" | "created" | "none";

/** "merged": the draft is on main (Publish is done); `release` says the rest. */
export type PublishResult =
  | { result: "merged"; sha: string; release: ReleaseOutcome }
  | { result: "up-to-date" };

/**
 * The file changes that apply a draft to the tree at `headSha`: a set name
 * writes its existing spelling's file (else the protocol's file name), unless
 * that file already holds exactly this content, and drops its other
 * spellings; a delete name removes every spelling.
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
  const blobShaAt = new Map(entries.map((e) => [e.path, e.sha]));
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
    for (const other of spellings) if (other !== path) remove(other);
    // Already on main byte for byte: nothing to commit for this name.
    if (blobShaAt.get(path) === gitBlobSha(content)) continue;
    changes.push({ path, content });
    next.set(path, {
      stem: path.slice(prefix.length, -".json".length),
      content,
    });
    await primeBlobCache(repo.client.repo, content);
  }
  for (const name of draft.delete) {
    for (const path of groups.get(spellingKey(name)) ?? []) remove(path);
  }
  return { changes, tree, next };
}

/**
 * Step 1: one fast-forward commit on main. Returns the commit sha, or null
 * when the draft changes nothing on main.
 */
async function commitDraftToMain(
  repo: HostedRepo,
  draft: DraftBody,
  message: string,
): Promise<string | null> {
  const headSha = await requireBranchHead(repo.client, repo.mainBranch);
  const { changes, tree, next } = await draftFileChanges(repo, headSha, draft);
  if (changes.length === 0) return null;
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
 * Step 3 for commit `sha`: its companion release, written only when missing
 * (it is immutable). Returns its schemaHash.
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
 * Step 4 for commit `sha`, whose companion has `schemaHash`: make it current,
 * only while `sha` is still main's head. Returns whether latest.json was
 * written; a failed write or purge throws {@link LatestUpdateError}.
 */
async function makeCommitCurrent(
  repo: HostedRepo,
  sha: string,
  schemaHash: string,
  hooks: PublishHooks,
): Promise<boolean> {
  await hooks.beforePointerWrite?.();
  // OPEN: O-10 — a plain PUT after the head check; a race lost in between is
  // fixed with Make current.
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  if (head !== sha) return false;
  await writeLatest(repo, {
    revision: sha,
    schemaHash,
    publishedAt: new Date().toISOString(),
  });
  return true;
}

export interface PublishHooks {
  beforePointerWrite?: () => Promise<void>;
}

function logCdnFailure(
  repo: HostedRepo,
  sha: string,
  step: string,
  error: unknown,
) {
  console.error(`hosted publish: ${step} failed`, {
    site: repo.site,
    sha,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Publish: steps 1–4 for the draft of `ref`. */
export async function publishDraft(
  repo: HostedRepo,
  drafts: DraftStore,
  ref: HostedDraftRef,
  note: { message: string; coAuthor?: CoAuthorIdentity | null },
  hooks: PublishHooks = {},
): Promise<PublishResult> {
  const draft = await drafts.load(ref);
  // OPEN: O-26 — nothing to publish answers the popover's existing no-changes state.
  if (!draft) return { result: "up-to-date" };
  const removeDraft = () =>
    // Only the save that was published goes: a save made during the publish
    // keeps the draft (its ETag changed).
    drafts
      .remove(ref, draft.etag)
      .catch((error) =>
        console.error("hosted publish: draft delete failed", {
          site: repo.site,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  const sha = isEmptyDraft(draft.body)
    ? null
    : await commitDraftToMain(
        repo,
        draft.body,
        note.message.trim()
          ? appendCoAuthorTrailer(note.message.trim(), note.coAuthor)
          : decofileCommitMessage(
              Object.keys(draft.body.set),
              draft.body.delete,
              note.coAuthor,
            ),
      );
  // The draft goes once it is merged, or when it commits nothing.
  await removeDraft();
  // Nothing committed: latest.json is left alone.
  if (sha === null) return { result: "up-to-date" };
  let schemaHash: string;
  try {
    schemaHash = await ensureRevision(repo, sha);
  } catch (error) {
    logCdnFailure(repo, sha, "release write", error);
    return { result: "merged", sha, release: "none" };
  }
  try {
    const current = await makeCommitCurrent(repo, sha, schemaHash, hooks);
    return { result: "merged", sha, release: current ? "current" : "created" };
  } catch (error) {
    logCdnFailure(repo, sha, "make current", error);
    return { result: "merged", sha, release: "created" };
  }
}
