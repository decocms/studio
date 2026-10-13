/**
 * The publish popover's status for a hosted v8 project, in the git shapes its
 * routes already speak (`/git/status`, `/git/diff`, `/git/discard`, see
 * `decofile/git-compat.ts`), served from the project's CDN draft instead of a
 * branch: the changed paths are the files Publish would commit to main, and
 * discarding a path drops that block from the draft. The popover works
 * unchanged on top.
 */

import { fullyDecodeFileName, spellingKey } from "@decocms/blocks/protocol";
import {
  buildPublishStatus,
  type CompatGitDiff,
  type CompatGitStatus,
} from "@/decofile/git-compat";
import { resolveBlockContents } from "@/decofile/read-decofile";
import { type RepoContentClient, requireBranchHead } from "@/git-providers";
import type { KVStorage } from "@/storage/kv";
import { bareEtag } from "./delivery-store";
import type {
  DraftBody,
  DraftStore,
  HostedDraftRef,
  LoadedDraft,
} from "./draft-store";
import { draftFileChanges } from "./publish";
import {
  type BlocksMajorStorage,
  projectMainIsV8,
  projectPackagePath,
} from "./blocks-major";
import { hostedDrafts, ownedProjectSite } from "./scope";

interface DraftRepo {
  client: RepoContentClient;
  packagePath: string | null;
  mainBranch: string;
}

export interface HostedDraftRequest {
  storage: {
    kv: KVStorage;
    orgSites: Parameters<typeof ownedProjectSite>[0];
    /** When given, main's answer is written through to the project's
     *  Blocks v8 marker (hosted/blocks-major.ts). */
    virtualMcps?: BlocksMajorStorage;
  };
  /** Who the marker write is attributed to. */
  userId?: string;
  organizationId: string;
  virtualMcpId: string;
  branch: string;
  metadata: Record<string, unknown> | null | undefined;
  /** The project repo's content client (only called for a hosted project). */
  gitClient: () => Promise<RepoContentClient>;
  /** The draft store; defaults to the configured delivery bucket's. */
  drafts?: DraftStore | null;
}

/**
 * A hosted v8 project's draft, for the sandbox-less git routes: its changes
 * live on the CDN draft, not on the branch. Null for every other project,
 * which keeps the branch-backed answers. A project that doesn't own its
 * site id, or with no delivery bucket, is never hosted and makes no
 * repository read; otherwise main's schema decides (`projectMainIsV8`:
 * `isV8Schema` with a one-minute reuse, written through to the marker), never
 * the marker alone.
 */
export async function loadHostedDraft(req: HostedDraftRequest) {
  const site = await ownedProjectSite(
    req.storage.orgSites,
    req.virtualMcpId,
    req.organizationId,
  );
  const drafts = site
    ? req.drafts !== undefined
      ? req.drafts
      : hostedDrafts(req.storage.kv)
    : null;
  if (!site || !drafts) return null;
  const ref: HostedDraftRef = {
    organizationId: req.organizationId,
    virtualMcpId: req.virtualMcpId,
    branch: req.branch,
    site,
  };
  const client = await req.gitClient();
  const repo: DraftRepo = {
    client,
    packagePath: projectPackagePath(req.metadata),
    mainBranch: await client.getDefaultBranch(),
  };
  const isV8 = await projectMainIsV8({
    projects: req.storage.virtualMcps,
    project: {
      id: req.virtualMcpId,
      organizationId: req.organizationId,
      metadata: req.metadata,
    },
    by: req.userId,
    client,
    mainBranch: repo.mainBranch,
  });
  if (!isV8) return null;
  return { drafts, ref, repo, draft: await drafts.load(ref) };
}

const EMPTY: DraftBody = { set: {}, delete: [] };

async function changesAgainstMain(repo: DraftRepo, draft: LoadedDraft | null) {
  const mainSha = await requireBranchHead(repo.client, repo.mainBranch);
  const { changes, tree } = await draftFileChanges(
    repo,
    mainSha,
    draft?.body ?? EMPTY,
  );
  const onMain = new Map(
    tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]),
  );
  return { mainSha, changes, onMain };
}

export async function hostedDraftPublishStatus(
  repo: DraftRepo,
  branch: string,
  draft: LoadedDraft | null,
): Promise<CompatGitStatus> {
  const { mainSha, changes, onMain } = await changesAgainstMain(repo, draft);
  return buildPublishStatus({
    base: repo.mainBranch,
    branch,
    // The draft's revision, as the content protocol reports it.
    headSha: `${mainSha}~${bareEtag(draft?.etag) ?? "none"}`,
    compared: {
      aheadBy: changes.length,
      behindBy: 0,
      files: changes.map((change) => ({
        filename: change.path,
        status:
          "deleted" in change
            ? "removed"
            : onMain.has(change.path)
              ? "modified"
              : "added",
      })),
    },
  });
}

export async function hostedDraftPublishDiff(
  repo: DraftRepo,
  draft: LoadedDraft | null,
): Promise<CompatGitDiff> {
  const { mainSha, changes, onMain } = await changesAgainstMain(repo, draft);
  const before = changes.flatMap((change) => {
    const sha = onMain.get(change.path);
    return sha ? [{ stem: change.path, sha }] : [];
  });
  const contents = new Map(
    (await resolveBlockContents(repo.client, before)).map((b) => [
      b.stem,
      b.content,
    ]),
  );
  return {
    diffs: Object.fromEntries(
      changes.map((change) => [
        change.path,
        {
          from: contents.get(change.path) ?? null,
          to: "content" in change ? change.content : null,
        },
      ]),
    ),
    mergeBaseSha: mainSha,
  };
}

/** Drops the blocks behind `filepaths` from the draft. */
export async function draftGitDiscard(
  drafts: DraftStore,
  ref: HostedDraftRef,
  filepaths: string[],
): Promise<void> {
  const groups = new Set(
    filepaths.map(
      (path) => fullyDecodeFileName(path.split("/").pop() ?? "").name,
    ),
  );
  await drafts.update(ref, (body) => ({
    set: Object.fromEntries(
      Object.entries(body.set).filter(
        ([name]) => !groups.has(spellingKey(name)),
      ),
    ),
    delete: body.delete.filter((name) => !groups.has(spellingKey(name))),
  }));
}
