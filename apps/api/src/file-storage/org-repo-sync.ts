/**
 * Per-org repo → volume sync (the user-configured counterpart of the public
 * skill sets, see skill-set-sync.ts).
 *
 * Configs live in `org_repo_sync` (storage/org-repo-syncs.ts): a credential
 * source + a target volume in the org's own keyspace. The source is either a
 * first-class `repositories` row — whose provider account mints the token and
 * serves the archive through `GitProviderClient` (GitHub and GitLab alike) —
 * or, for configs created before that model, the legacy repo-scoped
 * `mcp-github` connection. Either way the token is minted inside the sync
 * (they live ~1h) and never persisted in config, so private repos work.
 *
 * Runs on a DBOS scheduled workflow (dbos-org-repo-sync.ts) and on demand via
 * the ORG_REPO_SYNC_RUN tool.
 */

import type { StudioContext } from "@/core/studio-context";
import type { OrgRepoSync } from "@/storage/types";
import {
  clientForAccount,
  repositoryUsesStudioCredentials,
} from "@/git-providers/credentials";
import { repoRefOf } from "@/storage/repositories";
import { ensureGithubCloneToken } from "@/shared/github-clone-info";
import { getValidDownstreamAccessToken } from "@/oauth/token-refresh";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import { isValidVolume } from "./org-fs-path";
import { isPublicVolume } from "./public-sets";
import { syncRepoToVolume, type TarballSource } from "./skill-set-sync";

/** Volumes with fixed roles that a repo sync must never overwrite. `public`
 *  is reserved too: it would mount at `org/public`, the public sets' dir.
 *  `output`/`upload` are the daemon's per-run symlinks (links.go) — a real
 *  dir at those paths breaks share-files-back for every run in the org. */
const RESERVED_VOLUMES = new Set([
  "home",
  "outputs",
  "uploads",
  "public",
  "output",
  "upload",
]);

/** Max sync configs per org — bounds the cron's per-tick tarball downloads. */
export const MAX_REPO_SYNCS_PER_ORG = 10;

/**
 * Validate a user-supplied target volume name. Returns an error message or
 * null when valid. Pure — unit-tested.
 */
export function validateSyncVolumeName(volume: string): string | null {
  if (!isValidVolume(volume)) {
    return `Invalid volume name ${JSON.stringify(volume)} — use 1-128 chars of letters, digits, "_", "-" or "."`;
  }
  if (RESERVED_VOLUMES.has(volume)) {
    return `Volume "${volume}" is reserved`;
  }
  if (isPublicVolume(volume)) {
    return `Volume names starting with "public-" are reserved for shared skill sets`;
  }
  if (volume.startsWith(".")) {
    return `Volume names starting with "." are reserved`;
  }
  // Skill ids (`repo/<volume>/<skill>`) require SAFE_SEGMENT (leading
  // alphanumeric, see skill-resolve.ts) — reject names it couldn't resolve.
  if (!/^[A-Za-z0-9]/.test(volume)) {
    return `Volume names must start with a letter or digit`;
  }
  return null;
}

export type OrgRepoSyncRunResult =
  | {
      id: string;
      volume: string;
      written: number;
      deleted: number;
      unchanged: number;
    }
  | { id: string; volume: string; error: string };

/**
 * The provider archive for a repository-backed config, or null when the
 * config still has to go through its legacy `mcp-github` connection (no
 * `repositoryId`, the row is gone, or Studio cannot serve its account — a
 * backfilled GitHub App account on a deployment without the App keys).
 */
async function providerTarballSource(
  ctx: StudioContext,
  config: OrgRepoSync,
): Promise<TarballSource | null> {
  if (!config.repositoryId) return null;
  const repository = await ctx.storage.repositories.get(
    config.repositoryId,
    config.organizationId,
  );
  if (!repository?.accountId) return null;
  if (!(await repositoryUsesStudioCredentials(ctx.storage, repository))) {
    return null;
  }
  const account = await ctx.storage.gitProviderAccounts.getUnscoped(
    repository.accountId,
  );
  if (!account) return null;
  const client = clientForAccount({ db: ctx.db, vault: ctx.vault }, account);
  const ref = repoRefOf(repository);
  return () => client.archiveTarball(ref, config.ref);
}

/**
 * The legacy path: the downstream token of a repo-scoped `mcp-github`
 * connection.
 *
 * Same recipe as TASK_ADD_REPO — re-mint when the connection carries a mint
 * recipe (a no-op for source-less refreshable children), then read the
 * cached/refreshable downstream token. Using `ensureRepoScopedToken` alone
 * would reject source-less children before even checking the cache.
 */
async function legacyConnectionToken(
  ctx: StudioContext,
  config: OrgRepoSync,
): Promise<string> {
  if (!config.connectionId) {
    throw new Error(
      "This sync has no usable credentials — reconnect the git provider account backing its repository.",
    );
  }
  const connection = await ctx.storage.connections.findById(
    config.connectionId,
    config.organizationId,
  );
  if (!connection) {
    throw new Error("sync connection not found in this organization");
  }
  await ensureGithubCloneToken({
    ctx,
    connectionId: connection.id,
    organizationId: config.organizationId,
    onLegacyMintError: (error) =>
      console.warn("[org-repo-sync] repo-scoped mint failed", {
        configId: config.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  const tokenResult = await getValidDownstreamAccessToken({
    connectionId: connection.id,
    tokenStorage: new DownstreamTokenStorage(ctx.db, ctx.vault),
  });
  if (!tokenResult.accessToken) {
    throw new Error(
      "No GitHub token for the sync connection — reconnect the mcp-github integration.",
    );
  }
  return tokenResult.accessToken;
}

/**
 * Run one sync config to completion, recording the outcome on the row. Never
 * throws — a failed mint or fetch lands in `last_sync_error` so one broken
 * repo never blocks the others (and the DBOS step never wedges).
 */
export async function syncOrgRepoSafe(
  ctx: StudioContext,
  config: OrgRepoSync,
): Promise<OrgRepoSyncRunResult> {
  try {
    const tarball = await providerTarballSource(ctx, config);
    const counts = await syncRepoToVolume(ctx.db, {
      orgId: config.organizationId,
      baseUrl: ctx.baseUrl,
      volume: config.volume,
      source: {
        repo: `${config.repoOwner}/${config.repoName}`,
        ref: config.ref,
        paths: config.paths,
      },
      ...(tarball
        ? { tarball }
        : { authToken: await legacyConnectionToken(ctx, config) }),
      skipVolumeQuota: false,
    });
    // Best-effort: the sync already succeeded, so a failed status write must not fall into the catch below and report a spurious failure.
    await ctx.storage.orgRepoSyncs
      .recordSyncResult(config.id, { error: null })
      .catch(() => {});
    return { id: config.id, volume: config.volume, ...counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.storage.orgRepoSyncs
      .recordSyncResult(config.id, { error: message })
      .catch(() => {});
    return { id: config.id, volume: config.volume, error: message };
  }
}
