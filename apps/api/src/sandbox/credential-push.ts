/**
 * Keeps a control plane's sandboxes supplied with credentials only Studio can
 * mint. The control plane never calls Studio: each ensure carries fresh
 * credentials, and this push refreshes them for every sandbox and tenant pool
 * the host lists, well inside a clone token's life.
 *
 * The host's listing is untrusted input: a tenant is minted for only while
 * its user is still a member of the org, and a credential, a pool's included,
 * only while it belongs to that org.
 */

import type { Kysely } from "kysely";
import type {
  CredentialsPush,
  ListedTenantPool,
  RepoIdentity,
  SandboxListing,
} from "@decocms/sandbox/provider/sandbox-api";
import { CREDENTIALS_PUSH_MAX } from "@decocms/sandbox/provider/sandbox-api";
import { normalizeRepoUrl } from "@decocms/sandbox/provider/agent-sandbox";
import { cloneUrlFor, parseRepoUrl } from "@decocms/shared/git-providers";
import { mapBounded } from "@decocms/shared/std";
import { ORG_FS_KEY_TTL_MS } from "@/file-storage/mount/provisioning";
import {
  type LegacyTenantPool,
  legacyPoolMintRequest,
} from "@/sandbox/legacy-tenant-pools";
import type { Database as DatabaseSchema } from "@/storage/types";

/** Every pushed clone token has at least this much life left. */
export const PUSH_CLONE_BUFFER_MS = 45 * 60_000;
/** A freshly minted org-fs key is claimed an hour short of its TTL. */
export const ORG_FS_CONFIG_LIFETIME_MS = ORG_FS_KEY_TTL_MS - 60 * 60_000;
/**
 * How long a host may keep a token that never expires before it needs a
 * push again. Revocation is the only end such a token has, and pushes come
 * every 10 minutes.
 */
const NON_EXPIRING_CLAIM_MS = 24 * 60 * 60_000;

/**
 * `EnsureRepo.credentialExpiresAt` for a mint's expiry: its own, a day for a
 * token that never expires, absent when the mint had no token.
 */
export function credentialExpiresAt(
  expiresAt: Date | null | undefined,
  now = Date.now(),
): number | undefined {
  if (expiresAt === undefined) return undefined;
  return expiresAt === null ? now + NON_EXPIRING_CLAIM_MS : expiresAt.getTime();
}
/** An org-fs key the host holds for longer than this is left alone. */
const ORG_FS_REMINT_BEFORE_MS = 24 * 60 * 60_000;
const MINT_CONCURRENCY = 8;
const MAX_CLONE_MINTS = 2_000;
const MAX_ORG_FS_MINTS = 200;

type Tenant = { orgId: string; userId: string };

/** What Studio's records say about the ids a listing names. */
export interface CredentialRecords {
  /** `tenantKey(tenant)` of each member, with its org slug. */
  members: ReadonlyMap<string, string>;
  connectionOrgs: ReadonlyMap<string, string>;
  repositoryOrgs: ReadonlyMap<string, string>;
  /** `poolRepoKey(orgId, repoUrl)` of each repository record, with its id. */
  orgRepositories: ReadonlyMap<string, string>;
}

export interface CredentialPushPlan {
  clones: Array<{ tenant: Tenant; repo: RepoIdentity }>;
  poolClones: Array<
    { tenant: string; repoUrl: string } & (
      | { repositoryId: string }
      | { connectionId: string; cloneUrl: string }
    )
  >;
  orgFs: Array<Tenant & { orgSlug: string }>;
  /** Listed tenants or repos Studio's records do not authorize. */
  refused: number;
}

export function tenantKey(tenant: Tenant): string {
  return JSON.stringify([tenant.orgId, tenant.userId]);
}

/** Null for a URL the pool store would not have accepted. */
export function poolRepoKey(orgId: string, repoUrl: string): string | null {
  const url = normalizeRepoUrl(repoUrl);
  return url ? JSON.stringify([orgId, url.toLowerCase()]) : null;
}

function repoOrg(
  records: CredentialRecords,
  repo: RepoIdentity,
): string | undefined {
  return "repositoryId" in repo
    ? records.repositoryOrgs.get(repo.repositoryId)
    : records.connectionOrgs.get(repo.connectionId);
}

/** Pure: which credentials to mint for a listing, pools and records. */
export function planCredentialPush(input: {
  sandboxes: readonly SandboxListing[];
  pools: readonly ListedTenantPool[];
  records: CredentialRecords;
  /** `STUDIO_SANDBOX_TENANT_POOLS`, which names each pool's connection. */
  legacyPools?: readonly LegacyTenantPool[];
  now: number;
}): CredentialPushPlan {
  const { records, now } = input;
  const clones = new Map<string, CredentialPushPlan["clones"][number]>();
  const poolClones = new Map<
    string,
    CredentialPushPlan["poolClones"][number]
  >();
  const orgFs = new Map<string, CredentialPushPlan["orgFs"][number]>();
  let refused = 0;

  // A pool's tenant is an org id, and only that org's own record for the repo
  // mints. A configured pool mints from its own connection, as in-process.
  for (const pool of input.pools) {
    for (const { repoUrl, branch } of pool.repos) {
      const key = poolRepoKey(pool.tenant, repoUrl);
      const configured = legacyPoolMintRequest(input.legacyPools ?? [], {
        tenant: pool.tenant,
        repoUrl,
        branch,
      });
      if (key && configured?.connectionId) {
        poolClones.set(key, {
          tenant: pool.tenant,
          repoUrl,
          connectionId: configured.connectionId,
          cloneUrl: configured.cloneUrl,
        });
        continue;
      }
      const repositoryId = key ? records.orgRepositories.get(key) : undefined;
      if (!key || !repositoryId) {
        refused++;
        continue;
      }
      poolClones.set(key, { tenant: pool.tenant, repoUrl, repositoryId });
    }
  }

  for (const sandbox of input.sandboxes) {
    const tenant = sandbox.tenant;
    // A tenant-less sandbox is a pool's; the pools are planned above.
    if (!tenant) continue;
    const orgSlug = records.members.get(tenantKey(tenant));
    if (orgSlug === undefined) {
      refused++;
      continue;
    }
    for (const repo of sandbox.repos) {
      if (repoOrg(records, repo) !== tenant.orgId) {
        refused++;
        continue;
      }
      const identity =
        "repositoryId" in repo
          ? { repositoryId: repo.repositoryId }
          : { connectionId: repo.connectionId, repo: repo.repo.toLowerCase() };
      const t = { orgId: tenant.orgId, userId: tenant.userId };
      clones.set(JSON.stringify([t, identity]), { tenant: t, repo: identity });
    }
    const held = sandbox.orgFsConfigExpiresAt;
    if (
      sandbox.orgFs &&
      (held === null || held - now < ORG_FS_REMINT_BEFORE_MS)
    ) {
      orgFs.set(tenantKey(tenant), {
        orgId: tenant.orgId,
        userId: tenant.userId,
        orgSlug,
      });
    }
  }
  return {
    clones: [...clones.values()],
    poolClones: [...poolClones.values()],
    orgFs: [...orgFs.values()],
    refused,
  };
}

/** Studio's records for every id a listing names. */
export async function credentialRecords(
  db: Kysely<DatabaseSchema>,
  sandboxes: readonly SandboxListing[],
  pools: readonly ListedTenantPool[],
): Promise<CredentialRecords> {
  const orgIds = new Set<string>();
  const userIds = new Set<string>();
  const connectionIds = new Set<string>();
  const repositoryIds = new Set<string>();
  const poolOrgIds = new Set(pools.map((pool) => pool.tenant));
  const poolPaths = new Set<string>();
  for (const pool of pools) {
    for (const { repoUrl } of pool.repos) {
      const ref = parseRepoUrl(repoUrl);
      if (ref) poolPaths.add(ref.path.toLowerCase());
    }
  }
  for (const sandbox of sandboxes) {
    if (sandbox.tenant) {
      orgIds.add(sandbox.tenant.orgId);
      userIds.add(sandbox.tenant.userId);
    }
    for (const repo of sandbox.repos) {
      if ("repositoryId" in repo) repositoryIds.add(repo.repositoryId);
      else connectionIds.add(repo.connectionId);
    }
  }
  const [members, connections, repositories, orgRepositories] =
    await Promise.all([
      orgIds.size === 0
        ? []
        : db
            .selectFrom("member")
            .innerJoin(
              "organization",
              "organization.id",
              "member.organizationId",
            )
            .select([
              "member.organizationId as orgId",
              "member.userId as userId",
              "organization.slug as slug",
            ])
            .where("member.organizationId", "in", [...orgIds])
            .where("member.userId", "in", [...userIds])
            .execute(),
      connectionIds.size === 0
        ? []
        : db
            .selectFrom("connections")
            .select(["id", "organization_id"])
            .where("id", "in", [...connectionIds])
            .execute(),
      repositoryIds.size === 0
        ? []
        : db
            .selectFrom("repositories")
            .select(["id", "organization_id"])
            .where("id", "in", [...repositoryIds])
            .execute(),
      poolPaths.size === 0
        ? []
        : db
            .selectFrom("repositories")
            .select(["id", "organization_id", "provider", "host", "path"])
            .where("organization_id", "in", [...poolOrgIds])
            .where((eb) => eb(eb.fn("lower", ["path"]), "in", [...poolPaths]))
            .execute(),
    ]);
  const byOrgRepo = new Map<string, string>();
  for (const repository of orgRepositories) {
    const key = poolRepoKey(
      repository.organization_id,
      cloneUrlFor({
        provider: repository.provider,
        host: repository.host,
        path: repository.path,
      }),
    );
    if (key && !byOrgRepo.has(key)) byOrgRepo.set(key, repository.id);
  }
  return {
    members: new Map(members.map((m) => [tenantKey(m), m.slug])),
    connectionOrgs: new Map(connections.map((c) => [c.id, c.organization_id])),
    repositoryOrgs: new Map(repositories.map((r) => [r.id, r.organization_id])),
    orgRepositories: byOrgRepo,
  };
}

export interface CredentialMinters {
  mintCloneUrl(
    repo: { cloneUrl: string; connectionId?: string; repositoryId?: string },
    opts: { bufferMs: number },
  ): Promise<string | null>;
  mintOrgFsConfig(tenant: Tenant & { orgSlug: string }): Promise<string | null>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mints a plan into push batches; a failed mint is skipped, the host keeps what it has. */
export async function mintCredentialPush(
  plan: CredentialPushPlan,
  minters: CredentialMinters,
  opts: { now: number; orgFsLifetimeMs: number },
): Promise<{ batches: CredentialsPush[]; failed: number }> {
  let failed = 0;
  if (
    plan.clones.length > MAX_CLONE_MINTS ||
    plan.poolClones.length > MAX_CLONE_MINTS ||
    plan.orgFs.length > MAX_ORG_FS_MINTS
  ) {
    console.warn(
      `[sandbox-credential-push] ${plan.clones.length} clone, ${plan.poolClones.length} pool clone and ${plan.orgFs.length} org-fs mints planned; minting the first ${MAX_CLONE_MINTS}, ${MAX_CLONE_MINTS} and ${MAX_ORG_FS_MINTS}`,
    );
  }
  const clones = await mapBounded(
    plan.clones.slice(0, MAX_CLONE_MINTS),
    MINT_CONCURRENCY,
    async (target) => {
      const repo =
        "repositoryId" in target.repo
          ? { cloneUrl: "", repositoryId: target.repo.repositoryId }
          : {
              cloneUrl: `https://github.com/${target.repo.repo}.git`,
              connectionId: target.repo.connectionId,
            };
      try {
        const cloneUrl = await minters.mintCloneUrl(repo, {
          bufferMs: PUSH_CLONE_BUFFER_MS,
        });
        return cloneUrl
          ? {
              tenant: target.tenant,
              repo: target.repo,
              cloneUrl,
              expiresAt: opts.now + PUSH_CLONE_BUFFER_MS,
            }
          : null;
      } catch (err) {
        failed++;
        console.warn(
          `[sandbox-credential-push] clone mint failed: ${errMsg(err)}`,
        );
        return null;
      }
    },
  );
  const poolClones = await mapBounded(
    plan.poolClones.slice(0, MAX_CLONE_MINTS),
    MINT_CONCURRENCY,
    async (target) => {
      try {
        const cloneUrl = await minters.mintCloneUrl(
          "repositoryId" in target
            ? { cloneUrl: "", repositoryId: target.repositoryId }
            : { cloneUrl: target.cloneUrl, connectionId: target.connectionId },
          { bufferMs: PUSH_CLONE_BUFFER_MS },
        );
        return cloneUrl
          ? {
              tenant: target.tenant,
              repoUrl: target.repoUrl,
              cloneUrl,
              expiresAt: opts.now + PUSH_CLONE_BUFFER_MS,
            }
          : null;
      } catch (err) {
        failed++;
        console.warn(
          `[sandbox-credential-push] pool clone mint failed: ${errMsg(err)}`,
        );
        return null;
      }
    },
  );
  const orgFsConfigs = await mapBounded(
    plan.orgFs.slice(0, MAX_ORG_FS_MINTS),
    MINT_CONCURRENCY,
    async (tenant) => {
      try {
        const json = await minters.mintOrgFsConfig(tenant);
        return json
          ? {
              tenant: { orgId: tenant.orgId, userId: tenant.userId },
              orgFsConfigJson: json,
              expiresAt: opts.now + opts.orgFsLifetimeMs,
            }
          : null;
      } catch (err) {
        failed++;
        console.warn(
          `[sandbox-credential-push] org-fs mint failed: ${errMsg(err)}`,
        );
        return null;
      }
    },
  );
  const cloneUrls = clones.filter((c) => c !== null);
  const poolCloneUrls = poolClones.filter((c) => c !== null);
  const configs = orgFsConfigs.filter((c) => c !== null);
  const batches: CredentialsPush[] = [];
  for (
    let i = 0;
    i < Math.max(cloneUrls.length, poolCloneUrls.length, configs.length);
    i += CREDENTIALS_PUSH_MAX
  ) {
    batches.push({
      cloneUrls: cloneUrls.slice(i, i + CREDENTIALS_PUSH_MAX),
      poolCloneUrls: poolCloneUrls.slice(i, i + CREDENTIALS_PUSH_MAX),
      orgFsConfigs: configs.slice(i, i + CREDENTIALS_PUSH_MAX),
    });
  }
  return { batches, failed };
}
