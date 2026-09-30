/**
 * Tenant warm pools — warm pod capacity reserved for one tenant. The host
 * decides what a tenant is; the provider only compares it with the claim's
 * tenant key. Repos are optional allocations inside a pool: each gets its own
 * `SandboxWarmPool` whose pods already run that repo's dev server, and the
 * pool's remaining replicas are blank warm pods that clone on bind.
 *
 * One `SandboxWarmPool` per allocation because the operator binds any warm pod
 * of the pool a claim names, and the daemon refuses to move a cloned pod to
 * another repo (`409 immutable: cloneUrl`).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  type SandboxImage,
  SandboxImageSchema,
} from "@decocms/shared/git-providers";
import { K8S_CONSTANTS } from "./constants";
import type { EnsureOptions, SandboxPurpose } from "../types";

/** Leaves room for `-<8 hex>` in an allocation's `SandboxWarmPool` name. */
const TENANT_POOL_NAME_MAX = 54;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const REPO_URL_MAX = 2048;

/**
 * Credential-free https clone URL: lowercase host, no userinfo, no trailing
 * `.git` or `/`. Null for anything else, so a credential never reaches storage.
 */
export function normalizeRepoUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.search || url.hash) return null;
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return path ? `https://${url.host.toLowerCase()}${path}` : null;
}

/** Git hosts resolve repository paths case-insensitively. */
function repoUrlKey(raw: string): string | null {
  return normalizeRepoUrl(raw)?.toLowerCase() ?? null;
}

export const tenantPoolWorkloadSchema = z
  .object({
    runtime: z.enum(["node", "bun", "deno"]).default("node"),
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "deno"]).optional(),
    packageManagerPath: z.string().optional(),
    devPort: z.number().int().positive().optional(),
  })
  .default({ runtime: "node" });

export const tenantPoolRepoSchema = z.object({
  repoUrl: z
    .string()
    .max(REPO_URL_MAX)
    .transform((raw, ctx) => {
      const normalized = normalizeRepoUrl(raw);
      if (normalized) return normalized;
      ctx.addIssue({
        code: "custom",
        message: "repoUrl must be an https clone URL",
      });
      return z.NEVER;
    }),
  /** What idle pods sit on. Claims switch branch post-bind (deps survive). */
  branch: z.string().min(1).default("main"),
  workload: tenantPoolWorkloadSchema,
  replicas: z.number().int().min(1),
});

/** A pool's size is less than the replicas its repos take. */
export class TenantPoolCapacityError extends Error {
  constructor(
    readonly poolName: string,
    readonly size: number,
    readonly allocated: number,
  ) {
    super(
      `pool ${poolName}: repos take ${allocated} replicas, more than its size ${size}`,
    );
    this.name = "TenantPoolCapacityError";
  }
}

type RepoAllocation = Pick<TenantPoolRepo, "repoUrl" | "branch" | "replicas">;

/** The first allocation that repeats an earlier one's repo and branch. */
export function duplicateRepoAllocation<T extends RepoAllocation>(
  repos: readonly T[],
): T | null {
  const seen = new Set<string>();
  for (const repo of repos) {
    const key = `${repoUrlKey(repo.repoUrl) ?? repo.repoUrl}#${repo.branch}`;
    if (seen.has(key)) return repo;
    seen.add(key);
  }
  return null;
}

export function allocatedReplicas(
  repos: readonly Pick<RepoAllocation, "replicas">[],
): number {
  return repos.reduce((sum, repo) => sum + repo.replicas, 0);
}

export const tenantPoolFieldsSchema = z.object({
  /** DNS label; names the pool's `SandboxWarmPool` objects. */
  name: z
    .string()
    .max(TENANT_POOL_NAME_MAX)
    .regex(
      DNS_LABEL,
      "pool name must be a DNS label (lowercase alphanumeric and '-')",
    ),
  /** Opaque isolation key: only claims with this tenant key bind the pool. */
  tenant: z.string().min(1).max(512),
  size: z.number().int().min(1),
  image: SandboxImageSchema.default("default"),
});

export const tenantPoolSchema = tenantPoolFieldsSchema
  .extend({ repos: z.array(tenantPoolRepoSchema).default([]) })
  .superRefine((pool, ctx) => {
    const duplicate = duplicateRepoAllocation(pool.repos);
    if (duplicate) {
      ctx.addIssue({
        code: "custom",
        path: ["repos"],
        message: `duplicate repo allocation ${duplicate.repoUrl}#${duplicate.branch}`,
      });
    }
    const allocated = allocatedReplicas(pool.repos);
    if (allocated > pool.size) {
      ctx.addIssue({
        code: "custom",
        path: ["repos"],
        message: new TenantPoolCapacityError(pool.name, pool.size, allocated)
          .message,
      });
    }
  });

export type TenantPoolInput = z.input<typeof tenantPoolSchema>;
export type TenantPoolFieldsInput = z.input<typeof tenantPoolFieldsSchema>;
export type TenantPoolRepoInput = z.input<typeof tenantPoolRepoSchema>;
export type TenantPoolRepo = z.output<typeof tenantPoolRepoSchema> & {
  /** Overrides the derived `SandboxWarmPool` name, for pools a chart already renders. */
  warmPoolName?: string;
};
export type TenantPool = Omit<z.output<typeof tenantPoolSchema>, "repos"> & {
  repos: TenantPoolRepo[];
};

/** `<pool>-<8 hex of repoUrl#branch>`, unless the allocation names its own. */
export function allocationWarmPoolName(
  poolName: string,
  repo: Pick<TenantPoolRepo, "repoUrl" | "branch" | "warmPoolName">,
): string {
  if (repo.warmPoolName) return repo.warmPoolName;
  const digest = createHash("sha256")
    .update(`${repo.repoUrl}#${repo.branch}`)
    .digest("hex")
    .slice(0, 8);
  return `${poolName}-${digest}`;
}

function blankReplicas(pool: TenantPool): number {
  return Math.max(0, pool.size - allocatedReplicas(pool.repos));
}

export interface TenantPoolAllocation {
  pool: TenantPool;
  repo: TenantPoolRepo;
  warmPoolName: string;
}

export function tenantPoolAllocations(
  pools: readonly TenantPool[],
): TenantPoolAllocation[] {
  return pools.flatMap((pool) =>
    pool.repos.map((repo) => ({
      pool,
      repo,
      warmPoolName: allocationWarmPoolName(pool.name, repo),
    })),
  );
}

/** The template a pool's pods are built from; claims that bind them name the same one. */
function tenantPoolTemplateName(
  templateName: string,
  image: SandboxImage,
): string {
  return claimTemplateName(undefined, templateName, true, image);
}

const TENANT_POOL_LABEL = "studio.decocms.com/tenant-pool";

export interface SandboxWarmPoolObject {
  apiVersion: string;
  kind: "SandboxWarmPool";
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    replicas: number;
    updateStrategy: { type: "OnReplenish" };
    sandboxTemplateRef: { name: string };
  };
}

/**
 * The `SandboxWarmPool` objects a pool needs: one per repo allocation, then
 * the blank remainder, rendered even at 0 replicas so a shrink is applied.
 */
export function renderTenantPoolWarmPools(
  pool: TenantPool,
  { templateName }: { templateName: string },
): SandboxWarmPoolObject[] {
  const template = tenantPoolTemplateName(templateName, pool.image);
  const warmPool = (name: string, replicas: number): SandboxWarmPoolObject => ({
    apiVersion: `${K8S_CONSTANTS.CLAIM_API_GROUP}/${K8S_CONSTANTS.CLAIM_API_VERSION}`,
    kind: "SandboxWarmPool",
    metadata: { name, labels: { [TENANT_POOL_LABEL]: pool.name } },
    spec: {
      replicas,
      updateStrategy: { type: "OnReplenish" },
      sandboxTemplateRef: { name: template },
    },
  });
  return [
    ...pool.repos.map((repo) =>
      warmPool(allocationWarmPoolName(pool.name, repo), repo.replicas),
    ),
    warmPool(pool.name, blankReplicas(pool)),
  ];
}

/** The key a claim's tenant is matched on; the one place that reads it from ensure. */
export function claimTenantKey(opts: EnsureOptions): string | undefined {
  return opts.tenant?.orgId;
}

export interface TenantPoolBinding {
  pool: TenantPool;
  /** Null for a blank pod, which clones on bind. */
  repo: TenantPoolRepo | null;
  warmPoolName: string;
}

/**
 * The isolation boundary. The tenant key comes from the principal being
 * served, never a request field: the operator binds any pool a claim names.
 *
 * Order: an allocation for the claim's repo (exact branch first), then the
 * tenant's blank pods, else null for the generic pool. Only pools built for
 * the claim's image qualify, and a pool with no blank replicas is skipped.
 */
export function resolveTenantPoolBinding(
  pools: readonly TenantPool[],
  claim: {
    tenant: string | undefined;
    image: SandboxImage;
    cloneUrl: string | undefined;
    branch: string | undefined;
  },
): TenantPoolBinding | null {
  if (!claim.tenant) return null;
  const eligible = pools.filter(
    (pool) => pool.tenant === claim.tenant && pool.image === claim.image,
  );
  const key = claim.cloneUrl ? repoUrlKey(claim.cloneUrl) : null;
  if (key) {
    const matches = tenantPoolAllocations(eligible).filter(
      (allocation) => repoUrlKey(allocation.repo.repoUrl) === key,
    );
    const hit =
      matches.find((allocation) => allocation.repo.branch === claim.branch) ??
      matches[0];
    if (hit) return hit;
  }
  const blank = eligible.find((pool) => blankReplicas(pool) > 0);
  return blank ? { pool: blank, repo: null, warmPoolName: blank.name } : null;
}

/**
 * The claim's `spec.warmpool`. A tenant binding names its `SandboxWarmPool`;
 * otherwise the generic pool, named explicitly, or `"none"` without a
 * sentinel because the operator rejects per-claim env outside `"none"`.
 *
 * `genericPoolName` must be the SandboxWarmPool object's real name — the
 * sandbox-env chart names it after the SandboxTemplate. It used to be the
 * literal `"default"`, which matches no pool: the operator then falls back to
 * *any* warm pod rendered from the same template. Harmless while one pool
 * existed; once tenant pools shipped it handed one org's prewarmed pods (repo
 * already cloned) to another org's claim, and the daemon rejected the
 * mismatched workload with `409 immutable: cloneUrl`. Observed in prod
 * 2026-08-07: claims for one tenant and `ephemeral-*` dispatches bound
 * `tenant-electrolux-prod-*` pods.
 */
export function claimWarmPoolName(
  binding: TenantPoolBinding | null,
  warmPoolMode: boolean,
  genericPoolName: string,
): string {
  return binding?.warmPoolName ?? (warmPoolMode ? genericPoolName : "none");
}

/**
 * The claim's `spec.sandboxTemplateRef`.
 *
 * Two independent suffixes, in this order: the IMAGE the repo asked for, then
 * the SIZE the claim needs. A SandboxClaim can override neither the image nor
 * the resources, so each combination has to be its own template, and the
 * sandbox-env chart renders the cross product.
 *
 * Size — a `harness-run` claim gets the roomier `-medium` template: that is
 * where prod's 4Gi OOMKills happened. A claim bound to a TENANT POOL also
 * names `-medium`, because tenant pools are built from that template and
 * operator v0.4.5 binds warm pods by template hash — a claim naming a
 * template the pool wasn't built from gets a cold pod and no error.
 *
 * Image — `android` selects the image carrying an Android emulator, so an
 * agent can run a mobile app and look at it. Default asks for no suffix.
 *
 * The returned name is also the warm pool's name for the GENERIC pools (the
 * chart names those after their template), so it feeds `claimWarmPoolName`.
 */
export function claimTemplateName(
  purpose: SandboxPurpose | undefined,
  templateName: string,
  tenantPool = false,
  sandboxImage?: SandboxImage,
): string {
  const image =
    sandboxImage && sandboxImage !== "default" ? `-${sandboxImage}` : "";
  const size = purpose === "harness-run" || tenantPool ? "-medium" : "";
  return `${templateName}${image}${size}`;
}

/** Result of one derived-template lookup, cached for `ttlMs`. */
export interface TemplateProbe {
  checkedAt: number;
  present: boolean;
}

/** Probes by template name — one entry per derived name actually asked for. */
export type TemplateProbes = Record<string, TemplateProbe>;

/**
 * `claimTemplateName`, degraded while the derived one is not on the cluster:
 * first without the image suffix, then to the base template.
 *
 * Studio and the sandbox-env chart deploy independently (the chart is pinned by
 * targetRevision), so there is a window where Studio names a template the
 * cluster doesn't have. The operator accepts that claim and parks it at
 * `Ready=False TemplateNotFound` — every dispatch would burn its full readiness
 * timeout and fail. Probing instead costs one cached GET and degrades to the
 * ceiling we had before this feature.
 *
 * Both outcomes are cached for `ttlMs`, so the upgrade heals within one TTL and
 * a chart rollback is survived just as quietly.
 */
export async function resolveClaimTemplateName(args: {
  purpose: SandboxPurpose | undefined;
  /** Set when the claim is bound to a tenant pool — see `claimTemplateName`. */
  tenantPool?: boolean;
  /** Set when the repository pinned a non-default image. */
  sandboxImage?: SandboxImage;
  templateName: string;
  probes: TemplateProbes;
  now: number;
  ttlMs: number;
  exists: (name: string) => Promise<boolean>;
  onAbsent?: (name: string) => void;
}): Promise<{ name: string; probes: TemplateProbes }> {
  const wanted = claimTemplateName(
    args.purpose,
    args.templateName,
    args.tenantPool,
    args.sandboxImage,
  );
  if (wanted === args.templateName) {
    return { name: wanted, probes: args.probes };
  }
  // Keyed by name: the image and size suffixes compose, so one deployment asks
  // for several derived names and a single slot would thrash between them.
  const cached = args.probes[wanted] ?? null;
  const fresh =
    cached !== null && args.now - cached.checkedAt < args.ttlMs
      ? cached
      : { checkedAt: args.now, present: await args.exists(wanted) };
  const probes = { ...args.probes, [wanted]: fresh };
  if (fresh.present) return { name: wanted, probes };
  if (cached?.present !== false) args.onAbsent?.(wanted);
  // Drop the image before the size: a missing variant must not also cost a
  // harness run its `-medium` memory ceiling.
  if (args.sandboxImage && args.sandboxImage !== "default") {
    return resolveClaimTemplateName({
      ...args,
      sandboxImage: undefined,
      probes,
    });
  }
  return { name: args.templateName, probes };
}

/**
 * Allocations a push to `repoUrl`@`ref` makes stale. Branch match is
 * case-SENSITIVE (git refs are); the repo match is not.
 */
export function allocationsMatchingPush(
  pools: readonly TenantPool[],
  repoUrl: string,
  ref: string,
): TenantPoolAllocation[] {
  const key = repoUrlKey(repoUrl);
  if (!key) return [];
  const branch = ref.replace(/^refs\/heads\//, "");
  return tenantPoolAllocations(pools).filter(
    ({ repo }) => repoUrlKey(repo.repoUrl) === key && repo.branch === branch,
  );
}

/** When this replica last touched an unbound allocation pod; see `TenantPoolState`. */
export interface PoolPodState {
  /** The allocation's `SandboxWarmPool` name. */
  pool: string;
  lastConfigAt: number;
  lastFailureAt: number;
  failures: number;
}

/**
 * The pools a host serves, re-read on every call so pools it adds or removes
 * take effect on the next read, plus this replica's bookkeeping per allocation
 * `SandboxWarmPool`. In-memory and per-replica on purpose: every entry is a
 * hint, and losing it costs one redundant (idempotent) config post per pod.
 */
export class TenantPoolState {
  /** Allocation warm pools a push says are stale; drained by the next tick. */
  private readonly dirty = new Set<string>();
  /** Keyed by pod UID. */
  private readonly pods = new Map<string, PoolPodState>();
  /** The allocations the last `retain` saw, to tell which ones went away. */
  private known = new Map<string, TenantPoolAllocation>();

  constructor(private readonly source: () => readonly TenantPool[]) {}

  pools(): readonly TenantPool[] {
    return this.source();
  }

  resolve(
    claim: Parameters<typeof resolveTenantPoolBinding>[1],
  ): TenantPoolBinding | null {
    return resolveTenantPoolBinding(this.pools(), claim);
  }

  /** Warm pool names of the allocations a push to `repoUrl`@`ref` makes stale. */
  markDirty(repoUrl: string, ref: string): string[] {
    const names = allocationsMatchingPush(this.pools(), repoUrl, ref).map(
      (allocation) => allocation.warmPoolName,
    );
    for (const name of names) this.dirty.add(name);
    return names;
  }

  takeDirty(warmPoolName: string): boolean {
    return this.dirty.delete(warmPoolName);
  }

  pod(uid: string): PoolPodState | undefined {
    return this.pods.get(uid);
  }

  setPod(uid: string, state: PoolPodState): void {
    this.pods.set(uid, state);
  }

  /** Forgets an allocation's pods that are no longer in its listing. */
  retainPods(warmPoolName: string, liveUids: ReadonlySet<string>): void {
    for (const [uid, state] of this.pods) {
      if (state.pool === warmPoolName && !liveUids.has(uid)) {
        this.pods.delete(uid);
      }
    }
  }

  /** Drops the state of every allocation not in `allocations`, and returns those. */
  retain(allocations: readonly TenantPoolAllocation[]): TenantPoolAllocation[] {
    const current = new Map(
      allocations.map((allocation) => [allocation.warmPoolName, allocation]),
    );
    const gone = [...this.known.values()].filter(
      (allocation) => !current.has(allocation.warmPoolName),
    );
    for (const name of this.dirty) {
      if (!current.has(name)) this.dirty.delete(name);
    }
    for (const [uid, state] of this.pods) {
      if (!current.has(state.pool)) this.pods.delete(uid);
    }
    this.known = current;
    return gone;
  }
}
