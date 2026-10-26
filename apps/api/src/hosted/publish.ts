/**
 * Publish for a hosted v8 site:
 *
 *   1. commit the draft directly on main's head (fast-forward only, no PR),
 *      every draft block whole, over whatever main has for it (built again
 *      when main moves meanwhile);
 *   2. write the commit's companion release, the immutable
 *      sites/<site>/revisions/<commit>.json;
 *   3. make it current: write latest.json and purge its URL from Cloudflare's
 *      edge (5 s per attempt, one retry), only while the commit is still
 *      main's head, so an older Publish never replaces a newer one;
 *   4. empty the draft, once the release is current: `{ set: {}, delete: [] }`
 *      at the same slug, so the preview keeps sending the same `?__draft=`
 *      pointer (a new version), and a render of it, made after the release,
 *      layers nothing over the new release. A save made during the Publish
 *      is kept.
 *
 * Git is the source of truth for content; latest.json alone says what the CDN
 * serves ("Current"). A failed commit fails Publish and keeps the draft. A
 * failure in step 2 or 3 doesn't undo the merge: the result says which step
 * failed, nothing is restored, and the draft is kept (the preview keeps
 * showing the changes until they are live). The result then carries the
 * published save's `draftEtag`: Publish's "Try again" (`releaseMainHead`)
 * retries the release for main's head and, once it is current, empties the
 * draft with that ETag (`emptyDraftAfterRelease`), so a save made in between
 * is kept. A draft that commits nothing (its changes are on main already)
 * is emptied when latest.json names main's head; when it doesn't (a failed
 * release whose "Try again" was lost), Publish releases main's head as "Try
 * again" would, and empties the draft once that is current. An empty draft
 * (or none) does the same without a draft to empty, but only when
 * latest.json exists and names an older commit (the editor shows "Not live
 * yet" then). Steps 2–3 are
 * {@link releaseCommit}, shared with Reapply version (reapply.ts).
 * Every latest.json write stamps `publishedAt` now: the SDK prefers the CDN
 * only when it is later than its bundle's build time.
 * Every latest.json write, and each companion release when it is written,
 * carries `previewHosts`: the site's addresses Studio knows
 * (preview-hosts.ts), the only hosts the site shows drafts on.
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
  uncachedBlockShas,
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
import {
  buildRevision,
  buildRevisionFrom,
  type SavedBlockFile,
  schemaHashAt,
  schemaHashInTree,
} from "./release-objects";

/** Main moved while the draft was being committed: nothing was published. */
export class MainMovedError extends Error {
  constructor() {
    super("main moved; publish again");
    this.name = "MainMovedError";
  }
}

/**
 * Writing latest.json or purging it from the edge (after its one retry)
 * failed. Nothing is restored: the user tries again.
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
  /**
   * The hosts the site shows drafts on (preview-hosts.ts). Absent only in a
   * latest.json written before Studio wrote it.
   */
  previewHosts?: string[];
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
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
        ...(isStringList(v.previewHosts)
          ? { previewHosts: v.previewHosts }
          : {}),
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
export async function hasRevision(
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
  /**
   * The site's preview hosts (preview-hosts.ts), written into latest.json
   * and into each companion release this repo writes.
   */
  previewHosts: readonly string[];
}

/**
 * What a merged Publish did on the CDN: `current` (companion written and made
 * current), `created` (companion written, making it current failed) or
 * `none` (no companion: the next Publish includes these changes).
 */
export type ReleaseOutcome = "current" | "created" | "none";

/** "merged": the draft is on main (Publish is done); `release` says the rest. */
export type PublishResult =
  | {
      result: "merged";
      sha: string;
      release: ReleaseOutcome;
      /**
       * The published save of the draft, kept because the release isn't
       * current (`release` is not `current`): "Try again" empties it with
       * this ETag once its release is.
       */
      draftEtag?: string;
    }
  | { result: "up-to-date" };

/**
 * The file changes that apply a draft to the tree at `headSha`: a set name
 * writes its existing spelling's file (else the protocol's file name), unless
 * that file already holds exactly this content, and drops its other
 * spellings; a delete name removes every spelling.
 */
async function draftFileChanges(
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
 * One fast-forward commit of `changes` (block files) on main from `headSha`,
 * with `.deco/blocks.gen.json` regenerated from `next` when the repo tracks
 * it. Main having moved is {@link MainMovedError}: nothing is committed.
 * Shared by Publish (which builds it again on the new head) and Reapply
 * version.
 */
export async function commitBlocksToMain(
  repo: HostedRepo,
  headSha: string,
  files: {
    changes: FileChange[];
    tree: TreeEntry[];
    next: Iterable<BlockSource>;
  },
  message: string,
  memo: Map<string, string> = new Map(),
): Promise<string> {
  const changes = [...files.changes];
  const gen = await regenerateGenArtifact({
    client: repo.client,
    tree: files.tree,
    packagePath: repo.packagePath,
    branch: repo.mainBranch,
    nextBlocks: files.next,
    memo,
  });
  if (gen) changes.push(gen);
  try {
    // No `rewriteFrom`: the ref only moves by fast-forward from `headSha`.
    // The files' texts ride in the tree write: no blob upload per block.
    const { sha } = await repo.client.commitFiles({
      branch: repo.mainBranch,
      message,
      expectedHead: headSha,
      changes,
      inlineContent: true,
    });
    return sha;
  } catch (error) {
    // Main moved: the caller decides whether to build the commit again.
    if (error instanceof RepoWriteConflict) throw new MainMovedError();
    throw error;
  }
}

/** How often Publish rebuilds its commit on a main that moved meanwhile. */
const PUBLISH_COMMIT_ATTEMPTS = 3;

/**
 * What a commit Publish just made is made of, so its release is built
 * without reading the commit back: its schemaHash (read lazily, only when
 * the release is written) and its `.deco/blocks` files.
 */
export interface KnownRevision {
  schemaHash: () => Promise<string>;
  files: SavedBlockFile[];
  memo?: Map<string, string>;
}

/**
 * Step 1: one fast-forward commit on main's head. Returns the commit, or
 * null when the draft changes nothing on main. The whole draft block wins
 * over main's copy, whoever changed it there. When main moves while the
 * commit is built (a developer's push), it is built again on the new head,
 * a few times, so Publish isn't refused for it.
 *
 * Its GitHub cost doesn't grow with the draft: main's head and one listing
 * of its `.deco/blocks`, then one tree write (the texts inline), the commit
 * and the ref. The release is built from the same listing and texts
 * ({@link KnownRevision}), never by listing and reading the new commit.
 */
async function commitDraftToMain(
  repo: HostedRepo,
  draft: DraftBody,
  message: string,
): Promise<{ sha: string; known: KnownRevision } | null> {
  const memo = new Map<string, string>();
  for (let attempt = 1; ; attempt++) {
    const headSha = await requireBranchHead(repo.client, repo.mainBranch);
    const { changes, tree, next } = await draftFileChanges(
      repo,
      headSha,
      draft,
    );
    if (changes.length === 0) return null;
    try {
      const sha = await commitBlocksToMain(
        repo,
        headSha,
        { changes, tree, next: next.values() },
        message,
        memo,
      );
      const prefix = `${blocksDirPath(repo.packagePath)}/`;
      return {
        sha,
        known: {
          // The commit changes block files (and blocks.gen.json) only: its
          // schema is its parent's, whose `.deco` was just listed.
          schemaHash: () =>
            schemaHashInTree(repo.client, repo.packagePath, headSha),
          files: [...next].map(([path, source]) => ({
            file: path.slice(prefix.length),
            source,
          })),
          memo,
        },
      };
    } catch (error) {
      if (
        !(error instanceof MainMovedError) ||
        attempt >= PUBLISH_COMMIT_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}

/**
 * The draft's names that main changed since the live release (latest.json's
 * commit): a developer's commit touched their files. Publish keeps the
 * draft's version of each (the review says so). Two tree listings, compared
 * by blob sha; read for the review, never on a save. Empty without a live
 * release, or when main's head is the live release.
 */
export async function draftNamesChangedOnMain(
  repo: Pick<
    HostedRepo,
    "client" | "packagePath" | "mainBranch" | "store" | "site"
  >,
  draft: DraftBody,
): Promise<string[]> {
  const names = [...Object.keys(draft.set), ...draft.delete];
  if (names.length === 0) return [];
  const [head, latest] = await Promise.all([
    requireBranchHead(repo.client, repo.mainBranch),
    readLatest(repo.store, repo.site),
  ]);
  if (!latest || latest.revision === head) return [];
  const prefix = `${blocksDirPath(repo.packagePath)}/`;
  const groupsAt = async (sha: string) => {
    const tree = await repo.client.listDecofileEntries(sha, repo.packagePath);
    const groups = new Map<string, string[]>();
    for (const entry of blockEntriesInTree(tree, repo.packagePath)) {
      const group = fullyDecodeFileName(entry.path.slice(prefix.length)).name;
      groups.set(group, [
        ...(groups.get(group) ?? []),
        `${entry.path}@${entry.sha}`,
      ]);
    }
    return groups;
  };
  const [released, now] = await Promise.all([
    groupsAt(latest.revision),
    groupsAt(head),
  ]);
  const same = (a: string[] = [], b: string[] = []) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();
  return [
    ...new Set(
      names.filter((name) => {
        const group = spellingKey(name);
        return !same(released.get(group), now.get(group));
      }),
    ),
  ].sort();
}

/**
 * Step 2 for commit `sha`: its companion release, written only when missing
 * (it is immutable). Returns its schemaHash.
 */
export async function ensureRevision(
  repo: HostedRepo,
  sha: string,
  known?: KnownRevision,
): Promise<string> {
  if (await hasRevision(repo.store, repo.site, sha)) {
    return known
      ? known.schemaHash()
      : schemaHashAt(repo.client, repo.packagePath, sha);
  }
  const revision = known
    ? await buildRevisionFrom(repo.client, sha, {
        schemaHash: await known.schemaHash(),
        files: known.files,
        memo: await primeFromLiveRelease(repo, known),
      })
    : await buildRevision(repo.client, repo.packagePath, sha);
  await repo.store.putJson(
    deliveryKeys.revision(repo.site, sha),
    { ...revision, previewHosts: [...repo.previewHosts] },
    CACHE_REVISION,
  );
  return revision.schemaHash;
}

/**
 * The texts a release built from `known` needs, as far as the blob cache and
 * the live release hold them, so its unchanged blocks aren't read from
 * GitHub one by one (a replica whose cache is cold). The live release
 * (latest.json's revision object, two bucket reads) holds every block it
 * released; each one whose serialized text has a blob sha the commit lists
 * is that file's text. Read only when the cache misses some; best effort.
 */
async function primeFromLiveRelease(
  repo: HostedRepo,
  known: KnownRevision,
): Promise<Map<string, string>> {
  const memo = known.memo ?? new Map<string, string>();
  const missing = await uncachedBlockShas(
    repo.client,
    known.files.map((f) => f.source),
    memo,
  );
  if (missing.length === 0) return memo;
  try {
    const latest = await readLatest(repo.store, repo.site);
    if (!latest) return memo;
    const released = await getJson(
      repo.store,
      deliveryKeys.revision(repo.site, latest.revision),
    );
    const blocks = (released?.value as { blocks?: unknown } | null)?.blocks;
    if (!blocks || typeof blocks !== "object") return memo;
    const wanted = new Set(missing);
    for (const entry of Object.values(blocks)) {
      const text = serializeBlock(entry);
      const blobSha = gitBlobSha(text);
      if (wanted.has(blobSha)) memo.set(blobSha, text);
    }
  } catch (error) {
    console.warn("hosted publish: the live release couldn't prime the build", {
      site: repo.site,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return memo;
}

/**
 * Writes latest.json, with the repo's `previewHosts`, then purges its URL from
 * the edge (5 s per attempt, exactly one retry). Either failing throws
 * {@link LatestUpdateError}: no restore of the previous pointer, no other
 * recovery (a failed write skips the purge). Returns what was written.
 */
export async function writeLatest(
  repo: Pick<HostedRepo, "store" | "purge" | "site" | "previewHosts">,
  pointer: Omit<LatestPointer, "previewHosts">,
): Promise<LatestPointer> {
  const key = deliveryKeys.latest(repo.site);
  const written: LatestPointer = {
    revision: pointer.revision,
    schemaHash: pointer.schemaHash,
    publishedAt: pointer.publishedAt,
    previewHosts: [...repo.previewHosts],
  };
  try {
    await repo.store.putJson(key, written, CACHE_LATEST);
    await repo.purge.purge(key);
  } catch (error) {
    throw new LatestUpdateError(error);
  }
  return written;
}

/**
 * Step 3 for commit `sha`, whose companion has `schemaHash`: make it current,
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
  // fixed with Publish's "Try again" (main's head).
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
  // No draft, or an empty one, has nothing of its own: Publish only makes
  // main's head live when latest.json names an older release (the editor's
  // "Not live yet"), and leaves the draft as it is.
  if (!draft || isEmptyDraft(draft.body)) {
    const behind = await unreleasedMainHead(repo, { requireLatest: true });
    if (!behind) return { result: "up-to-date" };
    const release = await releaseCommit(repo, behind, hooks);
    return { result: "merged", sha: behind, release };
  }
  // Only the save that was published is emptied: a save made during the
  // publish keeps the draft (its ETag changed). Same slug, so the preview's
  // pointer keeps its address. A failure here leaves content equal to main,
  // which renders the same over the new release: Publish still succeeds.
  const emptyDraft = () => emptyPublishedDraft(repo, drafts, ref, draft.etag);
  // The release first, then the draft: any render of the emptied draft
  // happens after latest.json names the new release. A release that isn't
  // current keeps the draft for "Try again".
  const releaseThenEmpty = async (
    sha: string,
    known?: KnownRevision,
  ): Promise<PublishResult> => {
    const release = await releaseCommit(repo, sha, hooks, known);
    if (release !== "current") {
      return draft.etag
        ? { result: "merged", sha, release, draftEtag: draft.etag }
        : { result: "merged", sha, release };
    }
    await emptyDraft();
    return { result: "merged", sha, release };
  };
  const committed = await commitDraftToMain(
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
  // Nothing committed.
  if (committed === null) {
    // The draft's changes are all on main already. Live (latest.json names
    // main's head): the draft is emptied, latest.json left alone. Not live (a
    // Publish whose release failed, its "Try again" gone with the tab, or
    // run by another editor): Publish releases main's head now, as "Try
    // again" does, and empties the draft once that release is current.
    const unreleased = await unreleasedMainHead(repo);
    if (unreleased === undefined) return { result: "up-to-date" };
    if (unreleased === null) {
      await emptyDraft();
      return { result: "up-to-date" };
    }
    return releaseThenEmpty(unreleased);
  }
  return releaseThenEmpty(committed.sha, committed.known);
}

/**
 * Main's head when latest.json doesn't name it (not released yet), `null`
 * when it does, `undefined` when either can't be read (nothing is decided).
 * With `requireLatest`, a site without latest.json (never published from
 * Studio: its own build is what visitors see) is `null` too.
 */
async function unreleasedMainHead(
  repo: HostedRepo,
  options: { requireLatest?: boolean } = {},
): Promise<string | null | undefined> {
  try {
    const [head, latest] = await Promise.all([
      requireBranchHead(repo.client, repo.mainBranch),
      readLatest(repo.store, repo.site),
    ]);
    if (!latest && options.requireLatest) return null;
    return latest?.revision === head ? null : head;
  } catch {
    return undefined;
  }
}

/**
 * Empties the draft only while it is still the save `etag` names (a save
 * made since is kept). Never throws: a failure leaves content equal to main,
 * which renders the same over the new release.
 */
export async function emptyPublishedDraft(
  repo: Pick<HostedRepo, "site">,
  drafts: DraftStore,
  ref: HostedDraftRef,
  etag: string | null,
): Promise<void> {
  try {
    await drafts.empty(ref, etag);
  } catch (error) {
    console.error("hosted publish: emptying the draft failed", {
      site: repo.site,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Steps 2–3 for a commit just made on main: write its companion release,
 * then make it current while it is still main's head. Never throws: the
 * outcome says which step failed (logged), and nothing is undone.
 */
export async function releaseCommit(
  repo: HostedRepo,
  sha: string,
  hooks: PublishHooks = {},
  known?: KnownRevision,
): Promise<ReleaseOutcome> {
  let schemaHash: string;
  try {
    schemaHash = await ensureRevision(repo, sha, known);
  } catch (error) {
    logCdnFailure(repo, sha, "release write", error);
    return "none";
  }
  try {
    const current = await makeCommitCurrent(repo, sha, schemaHash, hooks);
    return current ? "current" : "created";
  } catch (error) {
    logCdnFailure(repo, sha, "latest.json update", error);
    return "created";
  }
}
