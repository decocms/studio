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
import { repositoryArchive } from "@/git-providers";
import { isValidVolume } from "./org-fs-path";
import { isPublicVolume } from "./public-sets";
import { syncRepoToVolume } from "./skill-set-sync";

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
 * Run one sync config to completion, recording the outcome on the row. Never
 * throws — a failed mint or fetch lands in `last_sync_error` so one broken
 * repo never blocks the others (and the DBOS step never wedges).
 */
export async function syncOrgRepoSafe(
  ctx: StudioContext,
  config: OrgRepoSync,
): Promise<OrgRepoSyncRunResult> {
  try {
    const repository = config.repositoryId
      ? await ctx.storage.repositories.get(
          config.repositoryId,
          config.organizationId,
        )
      : null;
    if (!repository)
      throw new Error(
        "Sync repository no longer exists; select a repository again",
      );
    const counts = await syncRepoToVolume(ctx.db, {
      orgId: config.organizationId,
      baseUrl: ctx.baseUrl,
      volume: config.volume,
      source: {
        repo: repository.path,
        ref: config.ref,
        paths: config.paths,
      },
      tarball: () => repositoryArchive(ctx, repository, config.ref),
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
