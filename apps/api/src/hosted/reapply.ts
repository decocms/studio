/**
 * Reapply version: roll forward to an earlier version's content.
 *
 * Releases never move latest.json back to an older commit. Reapplying a
 * version makes a NEW commit on main whose `.deco/blocks/*.json` equal that
 * version's (exact bytes, from git), then runs Publish's release path
 * ({@link releaseCommit}): companion release, latest.json, purge. Main's
 * history stays linear and every later edit sits on the restored content.
 *
 *   - Only files that differ are touched: a block changed since is written
 *     back as it was (`copyFromRef`, nothing uploaded), a block added since
 *     is deleted, an equal one is left alone. The schema, `index.ts` and
 *     anything else under `.deco/` belong to the code and stay as they are.
 *   - Main must not move while it commits (`MainMovedError`, as Publish).
 *   - The version must have a companion release (`NotPublishedError`).
 *   - A version made for another schema is reapplied all the same; the
 *     result says so (`schemaChanged`, information only) so the screen can
 *     tell the user how to go back. Reapplying the previous version undoes it.
 *   - Content already equal to main's commits nothing ("up-to-date").
 *
 * The commit message follows git's revert convention: `Reapply: <note>`,
 * never chained, plus a `Reapplied-From: <sha>` trailer that Releases reads
 * to link the new version to the one it reapplied.
 */

import type { CoAuthorIdentity } from "@decocms/sandbox/shared";
import {
  type FileChange,
  requireBranchHead,
  type TreeEntry,
} from "@/git-providers";
import { schemaGenPath } from "@decocms/shared/blocks-major";
import { type BlockSource, blockEntriesInTree } from "@/decofile/read-decofile";
import { isCommitSha } from "./delivery-store";
import {
  commitBlocksToMain,
  hasRevision,
  type HostedRepo,
  type PublishHooks,
  type PublishResult,
  releaseCommit,
} from "./publish";
import { NotV8Site, schemaHashAt } from "./release-objects";

/** The commit has no companion release: there is nothing to reapply. */
export class NotPublishedError extends Error {
  constructor() {
    super("This commit has no release");
    this.name = "NotPublishedError";
  }
}

const PREFIX = "Reapply: ";
/** Publish's fallback title when there was no note (`decofileCommitMessage`). */
const NO_NOTE = /^chore\(decofile\):/;
const REAPPLIED_FROM = "Reapplied-From";
const REAPPLIED_FROM_LINE = /^Reapplied-From:\s*([0-9a-f]{40})\s*$/im;

/** `2026-10-14 13:05 UTC`, or null for an unreadable date. */
function utcMinute(date: string): string | null {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The new version's title for reapplying a version whose commit has
 * `message` and `date`: `Reapply: <its note>`. Reapplying a reapplied
 * version keeps the one prefix (it names the same content); a version
 * without a note is named by its date, in the Releases screen's words
 * (`release from <date>`; older notes say `version from <date>`).
 */
export function reapplyTitle(original: {
  message: string;
  date: string;
}): string {
  const title = original.message.split("\n")[0]?.trim() ?? "";
  if (title.startsWith(PREFIX) && title.length > PREFIX.length) return title;
  if (title && !NO_NOTE.test(title)) return `${PREFIX}${title}`;
  const when = utcMinute(original.date);
  return when ? `${PREFIX}release from ${when}` : `${PREFIX}earlier release`;
}

/**
 * The full commit message: title, then the `Reapplied-From:` trailer.
 * Attribution is not its business — `commitBlocksToMain` resolves the author
 * (and the fallback trailer) for every commit it writes.
 */
export function reapplyMessage(
  original: { message: string; date: string },
  sha: string,
): string {
  return `${reapplyTitle(original)}\n\n${REAPPLIED_FROM}: ${sha}`;
}

/** The sha a commit message says it reapplied, or null. */
export function reappliedFrom(message: string | undefined): string | null {
  return message?.match(REAPPLIED_FROM_LINE)?.[1]?.toLowerCase() ?? null;
}

/**
 * The block-file changes that make main's tree at `headSha` hold exactly the
 * block files of `targetSha`, and the resulting block set (for the
 * generated artifact).
 */
async function restoreFileChanges(
  repo: Pick<HostedRepo, "client" | "packagePath">,
  headSha: string,
  targetSha: string,
): Promise<{
  changes: FileChange[];
  tree: TreeEntry[];
  next: BlockSource[];
}> {
  const [tree, targetTree] = await Promise.all([
    repo.client.listDecofileEntries(headSha, repo.packagePath),
    repo.client.listDecofileEntries(targetSha, repo.packagePath),
  ]);
  const current = new Map(
    blockEntriesInTree(tree, repo.packagePath).map((e) => [e.path, e.sha]),
  );
  const target = blockEntriesInTree(targetTree, repo.packagePath);
  const targetPaths = new Set(target.map((e) => e.path));
  const changes: FileChange[] = [];
  for (const entry of target) {
    if (current.get(entry.path) === entry.sha) continue;
    changes.push({ path: entry.path, copyFromRef: targetSha });
  }
  for (const path of current.keys()) {
    if (!targetPaths.has(path)) changes.push({ path, deleted: true });
  }
  return {
    changes,
    tree,
    next: target.map((e) => ({ stem: e.stem, sha: e.sha })),
  };
}

async function schemaHashOrNull(repo: HostedRepo, sha: string) {
  try {
    return await schemaHashAt(repo.client, repo.packagePath, sha);
  } catch (error) {
    if (error instanceof NotV8Site) return null;
    throw error;
  }
}

/**
 * Whether the schema at `targetSha` differs from the one at `headSha`. The
 * blob ids (one small tree read per side; `listDecofileEntries` doesn't
 * list the schema) decide when they are equal or both absent; only when
 * they differ are both read and compared as canonical JSON, so a
 * formatting-only change is not a difference.
 */
async function schemaDiffers(
  repo: HostedRepo,
  headSha: string,
  targetSha: string,
): Promise<boolean> {
  const path = schemaGenPath(repo.packagePath);
  const [atHead, atTarget] = await Promise.all([
    repo.client.getEntriesAtPaths(headSha, [path]),
    repo.client.getEntriesAtPaths(targetSha, [path]),
  ]);
  if (atHead.get(path)?.sha === atTarget.get(path)?.sha) return false;
  const [head, target] = await Promise.all([
    schemaHashOrNull(repo, headSha),
    schemaHashOrNull(repo, targetSha),
  ]);
  return head !== target;
}

/** The companion-release checks shared by the read and the reapply. */
async function requireRelease(repo: HostedRepo, targetSha: string) {
  if (!isCommitSha(targetSha)) throw new NotPublishedError();
  if (!(await hasRevision(repo.store, repo.site, targetSha))) {
    throw new NotPublishedError();
  }
}

/**
 * Before reapplying: whether that version was made for another schema than
 * main's today. Two small tree reads; the schemas themselves are read only
 * when their blob ids differ.
 */
export async function reapplySchemaChanged(
  repo: HostedRepo,
  targetSha: string,
): Promise<boolean> {
  await requireRelease(repo, targetSha);
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  return schemaDiffers(repo, head, targetSha);
}

type ReapplyResult =
  | { result: "up-to-date" }
  | (Extract<PublishResult, { result: "merged" }> & {
      /** The version was made for another schema than main's (information). */
      schemaChanged: boolean;
    });

/** Reapply the version of commit `targetSha` (see the module comment). */
export async function reapplyVersion(
  repo: HostedRepo,
  targetSha: string,
  options: { coAuthor?: CoAuthorIdentity | null } = {},
  hooks: PublishHooks = {},
): Promise<ReapplyResult> {
  await requireRelease(repo, targetSha);
  const original = await repo.client.readCommit(targetSha);
  if (!original) throw new NotPublishedError();
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  const files = await restoreFileChanges(repo, head, targetSha);
  // Main already holds this content: nothing to commit, nothing to release.
  if (files.changes.length === 0) return { result: "up-to-date" };
  const schemaChanged = await schemaDiffers(repo, head, targetSha);
  if (schemaChanged) {
    console.info("hosted reapply: schema differs", {
      site: repo.site,
      target: targetSha,
      head,
    });
  }
  const sha = await commitBlocksToMain(
    repo,
    head,
    files,
    reapplyMessage(original, targetSha),
    options.coAuthor,
  );
  return {
    result: "merged",
    sha,
    release: await releaseCommit(repo, sha, hooks),
    schemaChanged,
  };
}
