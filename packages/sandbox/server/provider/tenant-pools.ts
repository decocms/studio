/**
 * Tenant warm pools — a pool of pods that are already running the dev server
 * for one org's repo. The sandbox controller warms them; Studio reads the same
 * `STUDIO_SANDBOX_TENANT_POOLS` JSON array only to verify the controller's
 * clone-url callbacks for pool pods, which have no state row.
 *
 * `name` is explicit rather than derived from the org because the sandbox-env
 * chart renders the matching `SandboxWarmPool` object from the same string — a
 * derivation on both sides is a mismatch waiting to happen.
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
