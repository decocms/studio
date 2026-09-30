/**
 * `STUDIO_SANDBOX_TENANT_POOLS`, the in-process provider's tenant warm pools:
 * a JSON array whose entries the sandbox-env chart renders as one
 * `SandboxWarmPool` named exactly the entry name. Each entry becomes one
 * library pool with one allocation that keeps that name, and its clone
 * credential is minted from the entry's GitHub connection.
 */
import { z } from "zod";
import {
  normalizeRepoUrl,
  type TenantPool,
  tenantPoolRepoSchema,
} from "@decocms/sandbox/provider/agent-sandbox";

const legacyTenantPoolSchema = z.object({
  name: z
    .string()
    .max(63)
    .regex(
      /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
      "pool name must be a DNS label (lowercase alphanumeric and '-')",
    ),
  orgId: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be `owner/name`"),
  /** Omit only for a public repo: without it the pods clone anonymously. */
  connectionId: z.string().min(1).optional(),
  branch: z.string().min(1).default("main"),
  workload: tenantPoolRepoSchema.shape.workload,
});

export type LegacyTenantPool = z.infer<typeof legacyTenantPoolSchema>;

/** Throws on malformed config: a pool that fails to parse costs pods and serves nobody. */
export function parseLegacyTenantPools(
  raw: string | undefined,
): LegacyTenantPool[] {
  if (!raw || raw.trim() === "") return [];
  const entries = z.array(legacyTenantPoolSchema).parse(JSON.parse(raw));
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new Error(`tenant pools: duplicate pool name ${entry.name}`);
    }
    names.add(entry.name);
  }
  return entries;
}

function legacyRepoUrl(entry: LegacyTenantPool): string {
  const url = normalizeRepoUrl(`https://github.com/${entry.repo}`);
  if (!url) throw new Error(`tenant pools: bad repo ${entry.repo}`);
  return url;
}

/** Size 1 with one replica allocated: the chart owns the real count, and no blank pool exists. */
export function legacyTenantPools(
  entries: readonly LegacyTenantPool[],
): TenantPool[] {
  return entries.map((entry) => ({
    name: entry.name,
    tenant: entry.orgId,
    size: 1,
    image: "default",
    repos: [
      {
        repoUrl: legacyRepoUrl(entry),
        branch: entry.branch,
        workload: entry.workload,
        replicas: 1,
        warmPoolName: entry.name,
      },
    ],
  }));
}

/** What to mint an allocation's clone URL from; no `connectionId` means clone anonymously. */
export function legacyPoolMintRequest(
  entries: readonly LegacyTenantPool[],
  repo: { tenant: string; repoUrl: string; branch: string },
): { cloneUrl: string; connectionId?: string } | null {
  const wanted = normalizeRepoUrl(repo.repoUrl)?.toLowerCase();
  const entry = entries.find(
    (candidate) =>
      candidate.orgId === repo.tenant &&
      candidate.branch === repo.branch &&
      legacyRepoUrl(candidate).toLowerCase() === wanted,
  );
  if (!entry) return null;
  const cloneUrl = `https://github.com/${entry.repo}.git`;
  return entry.connectionId
    ? { cloneUrl, connectionId: entry.connectionId }
    : { cloneUrl };
}

export function legacyPoolCloneUrlMinter(
  entries: readonly LegacyTenantPool[],
  mintCloneUrl: (repo: {
    cloneUrl: string;
    connectionId?: string;
  }) => Promise<string | null>,
) {
  return async (repo: {
    tenant: string;
    repoUrl: string;
    branch: string;
  }): Promise<string | null> => {
    const request = legacyPoolMintRequest(entries, repo);
    if (!request) return null;
    return request.connectionId ? mintCloneUrl(request) : request.cloneUrl;
  };
}
