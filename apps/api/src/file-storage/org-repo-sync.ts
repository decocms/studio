/**
 * Per-org GitHub repo → volume sync (the user-configured counterpart of the
 * public skill sets, see skill-set-sync.ts).
 *
 * Configs live in `org_repo_sync` (storage/org-repo-syncs.ts): a repo-scoped
 * `mcp-github` connection + a target volume in the org's own keyspace. Each
 * sync mints a fresh installation token from the connection (tokens live ~1h,
 * so they are minted inside the sync, never persisted in config) and mirrors
 * the repo tarball into the volume — private repos included.
 *
 * Runs on a DBOS scheduled workflow (dbos-org-repo-sync.ts) and on demand via
 * the ORG_REPO_SYNC_RUN tool.
 */

import type { StudioContext } from "@/core/studio-context";
import type { OrgRepoSync } from "@/storage/types";
import { ensureRepoScopedToken } from "@/oauth/github-mint";
import { isValidVolume } from "./org-fs-path";
import { isPublicVolume } from "./public-sets";
import { syncRepoToVolume } from "./skill-set-sync";

/** Volumes with fixed roles that a repo sync must never overwrite. `public`
 *  is reserved too: it would mount at `org/public`, the public sets' dir. */
const RESERVED_VOLUMES = new Set(["home", "outputs", "uploads", "public"]);

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
    const connection = await ctx.storage.connections.findById(
      config.connectionId,
      config.organizationId,
    );
    if (!connection) {
      throw new Error("sync connection not found in this organization");
    }
    const authToken = await ensureRepoScopedToken(ctx, connection);
    const counts = await syncRepoToVolume(ctx.db, {
      orgId: config.organizationId,
      baseUrl: ctx.baseUrl,
      volume: config.volume,
      source: {
        repo: `${config.repoOwner}/${config.repoName}`,
        ref: config.ref,
        paths: config.paths,
      },
      authToken,
      skipVolumeQuota: false,
    });
    await ctx.storage.orgRepoSyncs.recordSyncResult(config.id, {
      error: null,
    });
    return { id: config.id, volume: config.volume, ...counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.storage.orgRepoSyncs
      .recordSyncResult(config.id, { error: message })
      .catch(() => {});
    return { id: config.id, volume: config.volume, error: message };
  }
}
