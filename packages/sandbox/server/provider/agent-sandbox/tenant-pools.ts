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

import type { SandboxImage } from "@decocms/shared/git-providers";
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

/**
 * `owner/name` from a github.com clone URL (credentialed or anonymous),
 * lowercased. Pools are declared as GitHub `owner/name`, so a clone URL on any
 * other host yields null — a GitLab `acme/site` must never bind a pool warmed
 * for the GitHub repo of the same name.
 */
export function repoKeyFromCloneUrl(cloneUrl: string): string | null {
  try {
    const url = new URL(cloneUrl);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const [owner, rest] = url.pathname.replace(/^\/+/, "").split("/");
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
 *
 * Purpose is deliberately not a factor: a `harness-run` used to be excluded
 * because it posts `cloneOnly`, which stops the pod's dev task. The fix is to
 * drop `cloneOnly` once such a run actually binds a pool pod (see
 * `workloadConfigPayload` in runner.ts), not to send it to a cold pod.
 */
export function resolveTenantPool(
  pools: readonly TenantPool[],
  claim: { orgId: string | undefined; cloneUrl: string | undefined },
): TenantPool | null {
  const { orgId, cloneUrl } = claim;
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
 * 2026-08-07: claims for one tenant and `ephemeral-*` dispatches bound
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
 * The claim's `spec.sandboxTemplateRef`.
 *
 * Two independent suffixes, in this order: the IMAGE the repo asked for, then
 * the SIZE the claim needs. A SandboxClaim can override neither the image nor
 * the resources, so each combination has to be its own template, and the
 * sandbox-env chart renders the cross product.
 *
 * Size — a `harness-run` claim gets the roomier `-medium` template: that is
 * where prod's 4Gi OOMKills happened. A claim that matched a TENANT POOL also
 * names `-medium`, because the chart builds tenant pools from that template
 * and operator v0.4.5 binds warm pods by template hash — a claim naming a
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
  tenantPool?: TenantPool | null,
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
  /** Set when the claim matched a tenant pool — see `claimTemplateName`. */
  tenantPool?: TenantPool | null;
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
