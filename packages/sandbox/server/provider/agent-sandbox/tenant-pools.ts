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

import type { SandboxPurpose } from "../types";

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
     * A `harness-run` claim must never take a tenant pod. It doesn't want a dev
     * server, and binding one is actively destructive: Studio posts `cloneOnly`
     * + the thread branch, the daemon classifies `branch-change`, and its clone
     * step stops the dev task — so a dispatch would consume a warm slot AND
     * de-warm the pod it took. It gets its own pool instead (see
     * `claimTemplateName`), which is exactly what an empty pod is for.
     */
    purpose?: SandboxPurpose;
  },
): TenantPool | null {
  const { orgId, cloneUrl } = claim;
  if (claim.purpose === "harness-run") return null;
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
 * The claim's `spec.sandboxTemplateRef`. A `harness-run` claim gets the roomier
 * `-medium` template the sandbox-env chart renders alongside the default one —
 * that is where prod's 4Gi OOMKills happened, and a SandboxClaim cannot
 * override resources, so the ceiling can only come from another template.
 *
 * The returned name is also the warm pool's name (the chart names pool after
 * template), so it feeds `claimWarmPoolName`: naming the pool built from this
 * template is what lets the claim bind a warm pod at all. It is not what keeps
 * the ceiling right — operator v0.4.5 matches warm pods by template hash, so a
 * mismatched pool costs a warm bind (cold pod), never a wrong-size pod.
 */
export function claimTemplateName(
  purpose: SandboxPurpose | undefined,
  templateName: string,
): string {
  return purpose === "harness-run" ? `${templateName}-medium` : templateName;
}

/** Result of the last `-medium` template lookup, cached for `ttlMs`. */
export interface MediumTemplateProbe {
  checkedAt: number;
  present: boolean;
}

/**
 * `claimTemplateName`, degraded to the default template while the `-medium` one
 * is not on the cluster.
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
  templateName: string;
  probe: MediumTemplateProbe | null;
  now: number;
  ttlMs: number;
  exists: (name: string) => Promise<boolean>;
  onAbsent?: (name: string) => void;
}): Promise<{ name: string; probe: MediumTemplateProbe | null }> {
  const wanted = claimTemplateName(args.purpose, args.templateName);
  if (wanted === args.templateName) return { name: wanted, probe: args.probe };
  const fresh =
    args.probe !== null && args.now - args.probe.checkedAt < args.ttlMs
      ? args.probe
      : { checkedAt: args.now, present: await args.exists(wanted) };
  if (fresh.present) return { name: wanted, probe: fresh };
  if (args.probe?.present !== false) args.onAbsent?.(wanted);
  return { name: args.templateName, probe: fresh };
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
