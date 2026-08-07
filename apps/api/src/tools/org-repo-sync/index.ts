/**
 * ORG_REPO_SYNC_* — per-org GitHub repo → volume sync configs.
 *
 * An org member points a repo-scoped `mcp-github` connection at a fresh org-fs
 * volume; the org-repo-sync cron (dbos-org-repo-sync.ts) then mirrors the repo
 * into that volume every ~10 minutes (private repos included — the sync mints
 * an installation token from the connection). `_RUN` syncs on demand.
 *
 * Synced volumes are mirror targets: the sync deletes anything in the volume
 * that isn't in the repo, so CREATE requires an empty volume and users should
 * treat it as read-only (a fresh sandbox mounts it readonly at `org/<volume>`;
 * mounts appear on the next sandbox start).
 */

import { z } from "zod";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import { defineTool } from "@/core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "@/core/studio-context";
import {
  MAX_REPO_SYNCS_PER_ORG,
  syncOrgRepoSafe,
  validateSyncVolumeName,
} from "@/file-storage/org-repo-sync";

const pathsSchema = z
  .array(
    z.object({
      from: z.string().describe("Repo subtree to sync ('' for the whole repo)"),
      to: z
        .string()
        .optional()
        .describe("Volume subpath to place it at (defaults to the root)"),
    }),
  )
  .min(1);

const syncConfigSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  ref: z.string(),
  paths: pathsSchema,
  volume: z.string(),
  enabled: z.boolean(),
  lastSyncedAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  createdAt: z.string(),
});

const runResultSchema = z.union([
  z.object({
    id: z.string(),
    volume: z.string(),
    written: z.number(),
    deleted: z.number(),
    unchanged: z.number(),
  }),
  z.object({ id: z.string(), volume: z.string(), error: z.string() }),
]);

function toOutput(config: {
  id: string;
  connectionId: string;
  repoOwner: string;
  repoName: string;
  ref: string;
  paths: Array<{ from: string; to?: string }>;
  volume: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}): z.infer<typeof syncConfigSchema> {
  return {
    id: config.id,
    connectionId: config.connectionId,
    repoOwner: config.repoOwner,
    repoName: config.repoName,
    ref: config.ref,
    paths: config.paths,
    volume: config.volume,
    enabled: config.enabled,
    lastSyncedAt: config.lastSyncedAt,
    lastSyncError: config.lastSyncError,
    createdAt: config.createdAt,
  };
}

export const ORG_REPO_SYNC_CREATE = defineTool({
  name: "ORG_REPO_SYNC_CREATE",
  description:
    "Keep a GitHub repository mirrored into a new org-fs volume. Takes a " +
    "repo-scoped GitHub connection and an EMPTY volume name; the repo is " +
    "synced every ~10 minutes (and on ORG_REPO_SYNC_RUN). The volume is a " +
    "mirror — files not in the repo are deleted on each sync — so never " +
    "write into it directly. Sandboxes mount it readonly at org/<volume> " +
    "starting with their next boot.",
  inputSchema: z.object({
    connectionId: z
      .string()
      .describe("A repo-scoped mcp-github connection in this organization"),
    volume: z.string().describe("Target volume name (must be empty/new)"),
    ref: z.string().optional().describe("Git ref to sync (default 'main')"),
    paths: pathsSchema
      .optional()
      .describe("Repo subtrees to sync (default: the whole repo)"),
  }),
  outputSchema: z.object({ config: syncConfigSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");

    const volumeError = validateSyncVolumeName(input.volume);
    if (volumeError) throw new Error(volumeError);

    const count = await ctx.storage.orgRepoSyncs.countByOrg(organization.id);
    if (count >= MAX_REPO_SYNCS_PER_ORG) {
      throw new Error(
        `This organization already has ${count} synced repositories (max ${MAX_REPO_SYNCS_PER_ORG})`,
      );
    }

    // Tenancy + shape: the connection must live in THIS org and carry a
    // repoScope recipe. Owner/repo come from the recipe, never from input.
    const connection = await ctx.storage.connections.findById(
      input.connectionId,
      organization.id,
    );
    const scope = connection ? getRepoScope(connection) : null;
    if (!connection || !scope) {
      throw new Error(
        "connectionId must be a repo-scoped GitHub connection in this organization",
      );
    }

    // The sync mirrors the repo: anything already in the volume would be
    // deleted on the first run. Only adopt empty volumes.
    const existing = await ctx.storage.orgFsEntries.listVolumeFiles(
      organization.id,
      input.volume,
    );
    if (existing.length > 0) {
      throw new Error(
        `Volume "${input.volume}" already has ${existing.length} files — pick a new, empty volume (the sync would delete them)`,
      );
    }

    const config = await ctx.storage.orgRepoSyncs.create({
      organizationId: organization.id,
      connectionId: connection.id,
      repoOwner: scope.owner,
      repoName: scope.repo,
      ref: input.ref ?? "main",
      paths: input.paths ?? [{ from: "" }],
      volume: input.volume,
      createdBy: userId,
    });
    return { config: toOutput(config) };
  },
});

export const ORG_REPO_SYNC_LIST = defineTool({
  name: "ORG_REPO_SYNC_LIST",
  description:
    "List this organization's synced repositories with their last sync status.",
  inputSchema: z.object({}),
  outputSchema: z.object({ configs: z.array(syncConfigSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const configs = await ctx.storage.orgRepoSyncs.listByOrg(organization.id);
    return { configs: configs.map(toOutput) };
  },
});

export const ORG_REPO_SYNC_UPDATE = defineTool({
  name: "ORG_REPO_SYNC_UPDATE",
  description:
    "Update a synced repository's ref, paths, or enabled flag. The target " +
    "volume is immutable — delete and recreate to change it.",
  inputSchema: z.object({
    id: z.string(),
    enabled: z.boolean().optional(),
    ref: z.string().optional(),
    paths: pathsSchema.optional(),
  }),
  outputSchema: z.object({ config: syncConfigSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const config = await ctx.storage.orgRepoSyncs.update(
      input.id,
      organization.id,
      { enabled: input.enabled, ref: input.ref, paths: input.paths },
    );
    if (!config) throw new Error(`Sync config not found: ${input.id}`);
    return { config: toOutput(config) };
  },
});

export const ORG_REPO_SYNC_DELETE = defineTool({
  name: "ORG_REPO_SYNC_DELETE",
  description:
    "Stop syncing a repository. The volume and its already-synced files are " +
    "left in place — delete them from the Library if unwanted.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ deleted: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const deleted = await ctx.storage.orgRepoSyncs.delete(
      input.id,
      organization.id,
    );
    return { deleted };
  },
});

export const ORG_REPO_SYNC_RUN = defineTool({
  name: "ORG_REPO_SYNC_RUN",
  description:
    "Sync a repository into its volume right now (the 'I just pushed' " +
    "button). Returns written/deleted/unchanged counts, or the error that " +
    "was recorded on the config.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ result: runResultSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const config = await ctx.storage.orgRepoSyncs.get(
      input.id,
      organization.id,
    );
    if (!config) throw new Error(`Sync config not found: ${input.id}`);
    const result = await syncOrgRepoSafe(ctx, config);
    return { result };
  },
});
