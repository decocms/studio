/**
 * Tenant warm pools — a pool of pods that are already running the dev server
 * for one org's repo, so a member of that org opens a project and there is no
 * clone, no install, no Vite boot.
 *
 * Config comes from the `STUDIO_SANDBOX_TENANT_POOLS` deploy env (a JSON array).
 * Empty/unset = nothing changes anywhere. `name` is explicit rather than
 * derived from the org because the sandbox-env chart renders the matching
 * `SandboxWarmPool` object from the same string — a derivation on both sides
 * is a mismatch waiting to happen.
 */
import { z } from "zod";

const tenantPoolSchema = z.object({
  /**
   * SandboxWarmPool object name. Must match a pool rendered by the sandbox-env
   * chart's `tenantPools` list, and be DNS-label-safe (it names a k8s object).
   */
  name: z
    .string()
    .regex(
      /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
      "pool name must be a DNS label (lowercase alphanumeric and '-')",
    ),
  /** The ONLY org whose members may be given one of these pods. */
  orgId: z.string().min(1),
  /** `owner/name`, case-insensitive. A pool serves exactly one repo. */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be `owner/name`"),
  /**
   * GitHub connection the clone credential is minted from, fresh per bootstrap
   * and never stored. Omit only for a PUBLIC repo — without it the pods clone
   * anonymously, which fails on anything private.
   */
  connectionId: z.string().min(1).optional(),
  /** What idle pods sit on. Claims switch branch post-bind (deps survive). */
  branch: z.string().min(1).default("main"),
  workload: z
    .object({
      runtime: z.enum(["node", "bun", "deno"]).default("node"),
      packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "deno"]).optional(),
      packageManagerPath: z.string().optional(),
      devPort: z.number().int().positive().optional(),
    })
    .default({ runtime: "node" }),
});

export type TenantPool = z.infer<typeof tenantPoolSchema>;

/**
 * Throws on malformed config — a pool that silently fails to parse is a pool
 * that silently costs N pods and serves nobody.
 */
export function parseTenantPools(raw: string | undefined): TenantPool[] {
  if (!raw || raw.trim() === "") return [];
  const pools = z.array(tenantPoolSchema).parse(JSON.parse(raw));
  const names = new Set<string>();
  for (const pool of pools) {
    if (names.has(pool.name)) {
      throw new Error(
        `STUDIO_SANDBOX_TENANT_POOLS: duplicate pool name ${pool.name}`,
      );
    }
    names.add(pool.name);
  }
  return pools;
}

/** `owner/name` from a clone URL (credentialed or anonymous), lowercased. */
export function repoKeyFromCloneUrl(cloneUrl: string): string | null {
  try {
    const [owner, rest] = new URL(cloneUrl).pathname
      .replace(/^\/+/, "")
      .split("/");
    const name = rest?.replace(/\.git$/, "");
    return owner && name ? `${owner}/${name}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The isolation boundary. `orgId` is the org of the *authenticated user being
 * served*, never a request field — the operator has no notion of a tenant and
 * will happily bind any pool a claim names, so the claim (built server-side)
 * is the only thing keeping one org's warm pods away from another's.
 */
export function resolveTenantPool(
  pools: readonly TenantPool[],
  claim: {
    orgId: string | undefined;
    cloneUrl: string | undefined;
    /**
     * Checkout-only claims (the Claude Code dispatch path) must never take a
     * tenant pod. They don't want a dev server, and binding one is actively
     * destructive: Studio posts `cloneOnly` + the thread branch, the daemon
     * classifies `branch-change`, and its clone step stops the dev task — so a
     * dispatch would consume a warm slot AND de-warm the pod it took. They get
     * the generic pool instead, which is exactly what an empty pod is for.
     */
    cloneOnly?: boolean;
  },
): TenantPool | null {
  const { orgId, cloneUrl } = claim;
  if (claim.cloneOnly === true) return null;
  if (!orgId || !cloneUrl) return null;
  const repoKey = repoKeyFromCloneUrl(cloneUrl);
  if (!repoKey) return null;
  return (
    pools.find(
      (pool) => pool.orgId === orgId && pool.repo.toLowerCase() === repoKey,
    ) ?? null
  );
}

/**
 * The claim's `spec.warmpool`. A resolved tenant pool binds one of that org's
 * already-running pods; otherwise the generic pool, named explicitly, or
 * `"none"` without a sentinel because the operator rejects per-claim env
 * outside `"none"`.
 *
 * `genericPoolName` must be the SandboxWarmPool object's real name — the
 * sandbox-env chart names it after the SandboxTemplate. It used to be the
 * literal `"default"`, which matches no pool: the operator then falls back to
 * *any* warm pod rendered from the same template. Harmless while one pool
 * existed; once tenant pools shipped it handed one org's prewarmed pods (repo
 * already cloned) to another org's claim, and the daemon rejected the
 * mismatched workload with `409 immutable: cloneUrl`. Observed in prod
 * 2026-08-07: claims for montecarlo and `ephemeral-*` dispatches bound
 * `tenant-electrolux-prod-*` pods.
 */
export function claimWarmPoolName(
  pool: TenantPool | null,
  warmPoolMode: boolean,
  genericPoolName: string,
): string {
  return pool?.name ?? (warmPoolMode ? genericPoolName : "none");
}

/**
 * Pools a GitHub push event makes stale. Branch match is case-SENSITIVE (git
 * refs are); repo match is not (GitHub owners/names aren't).
 */
export function poolsMatchingPush(
  pools: readonly TenantPool[],
  repoFullName: string,
  ref: string,
): TenantPool[] {
  const branch = ref.replace(/^refs\/heads\//, "");
  return pools.filter(
    (pool) =>
      pool.repo.toLowerCase() === repoFullName.toLowerCase() &&
      pool.branch === branch,
  );
}

/** Anonymous clone URL for a pool's repo; the credential is minted per bootstrap. */
export function poolCloneUrl(pool: TenantPool): string {
  return `https://github.com/${pool.repo}.git`;
}
