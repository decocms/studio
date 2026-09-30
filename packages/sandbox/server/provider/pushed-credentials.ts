/**
 * The credentials a host outside Studio holds for its sandboxes. The host
 * never calls Studio: each `SANDBOX_ENSURE` brings the ones it was minted
 * with, and Studio pushes fresh ones with `SANDBOX_CREDENTIALS_PUSH`. Memory
 * only, so a host restart forgets them until the next push; nothing here is
 * ever written to the state store.
 */

import { normalizeRepoUrl } from "./agent-sandbox/tenant-pools";
import type { CredentialsPush, RepoIdentity } from "./sandbox-api";
import type { EnsureOptions } from "./types";

type Tenant = { orgId: string; userId: string };
type Repo = NonNullable<EnsureOptions["repo"]>;

interface Entry {
  value: string;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 20_000;
const SEED_MARGIN_MS = 2 * 60_000;

/**
 * `owner/name` from a github.com clone URL (credentialed or anonymous),
 * lowercased: a connection mints for a GitHub repo only, so a clone URL on any
 * other host yields null.
 */
function githubRepoKey(cloneUrl: string): string | null {
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

/** How the runner's mint paths name a repo, or null when none can re-mint it. */
export function repoIdentityOf(
  repo: Pick<Repo, "cloneUrl" | "connectionId" | "repositoryId">,
): RepoIdentity | null {
  // The runner's mint prefers the repository record, so the key does too.
  if (repo.repositoryId) return { repositoryId: repo.repositoryId };
  const key = repo.connectionId ? githubRepoKey(repo.cloneUrl) : null;
  return repo.connectionId && key
    ? { connectionId: repo.connectionId, repo: key }
    : null;
}

function tenantKey(tenant: Tenant | null | undefined): string {
  return tenant
    ? JSON.stringify(["tenant", tenant.orgId, tenant.userId])
    : "untenanted";
}

function poolRepoKey(tenant: string, repoUrl: string): string | null {
  const url = normalizeRepoUrl(repoUrl);
  return url ? JSON.stringify(["pool", tenant, url.toLowerCase()]) : null;
}

function repoKey(repo: RepoIdentity): string {
  return "repositoryId" in repo
    ? JSON.stringify(["repository", repo.repositoryId])
    : JSON.stringify([
        "connection",
        repo.connectionId,
        repo.repo.toLowerCase(),
      ]);
}

function hasUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

export class PushedCredentials {
  private readonly clones = new Map<string, Entry>();
  private readonly orgFs = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(opts: { now?: () => number; maxEntries?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** False when the held entry lives at least as long, or this one is already dead. */
  private put(map: Map<string, Entry>, key: string, entry: Entry): boolean {
    const now = this.now();
    if (entry.expiresAt <= now) return false;
    const held = map.get(key);
    if (held && held.expiresAt >= entry.expiresAt) return false;
    map.delete(key);
    map.set(key, entry);
    if (map.size > this.maxEntries) {
      for (const [k, e] of map) if (e.expiresAt <= now) map.delete(k);
      // Still over: the least recently written go first.
      for (const k of map.keys()) {
        if (map.size <= this.maxEntries) break;
        map.delete(k);
      }
    }
    return true;
  }

  private get(
    map: Map<string, Entry>,
    key: string,
    bufferMs: number,
  ): Entry | null {
    const entry = map.get(key);
    if (!entry) return null;
    const now = this.now();
    if (entry.expiresAt <= now) {
      map.delete(key);
      return null;
    }
    return entry.expiresAt - now < bufferMs ? null : entry;
  }

  push(batch: CredentialsPush): { stored: number; kept: number } {
    let stored = 0;
    for (const c of batch.cloneUrls) {
      const key = tenantKey(c.tenant) + repoKey(c.repo);
      if (
        this.put(this.clones, key, {
          value: c.cloneUrl,
          expiresAt: c.expiresAt,
        })
      )
        stored++;
    }
    for (const p of batch.poolCloneUrls) {
      const key = poolRepoKey(p.tenant, p.repoUrl);
      const entry = { value: p.cloneUrl, expiresAt: p.expiresAt };
      if (key && this.put(this.clones, key, entry)) stored++;
    }
    for (const o of batch.orgFsConfigs) {
      const entry = { value: o.orgFsConfigJson, expiresAt: o.expiresAt };
      if (this.put(this.orgFs, tenantKey(o.tenant), entry)) stored++;
    }
    const pushed =
      batch.cloneUrls.length +
      batch.poolCloneUrls.length +
      batch.orgFsConfigs.length;
    return { stored, kept: pushed - stored };
  }

  /**
   * The credentials an ensure arrived with, for recovery before the next
   * push: each clone URL until its own `credentialExpiresAt`, less a margin
   * so a recovery never clones with a token about to lapse.
   */
  seed(
    opts: EnsureOptions,
    validUntil: { orgFsConfig?: number } | undefined,
  ): void {
    const tenant = opts.tenant
      ? { orgId: opts.tenant.orgId, userId: opts.tenant.userId }
      : null;
    for (const repo of [opts.repo, ...(opts.extraRepos ?? [])]) {
      if (!repo?.credentialExpiresAt || !hasUserinfo(repo.cloneUrl)) continue;
      const identity = repoIdentityOf(repo);
      if (!identity) continue;
      this.put(this.clones, tenantKey(tenant) + repoKey(identity), {
        value: repo.cloneUrl,
        expiresAt: repo.credentialExpiresAt - SEED_MARGIN_MS,
      });
    }
    const orgFsUntil = validUntil?.orgFsConfig;
    if (tenant && opts.orgFsConfigJson && orgFsUntil !== undefined) {
      this.put(this.orgFs, tenantKey(tenant), {
        value: opts.orgFsConfigJson,
        expiresAt: orgFsUntil,
      });
    }
  }

  cloneUrl(
    tenant: Tenant | null | undefined,
    repo: RepoIdentity,
    bufferMs = 0,
  ): string | null {
    return (
      this.get(this.clones, tenantKey(tenant) + repoKey(repo), bufferMs)
        ?.value ?? null
    );
  }

  /** A tenant pool allocation's clone URL. */
  poolCloneUrl(tenant: string, repoUrl: string, bufferMs = 0): string | null {
    const key = poolRepoKey(tenant, repoUrl);
    return key ? (this.get(this.clones, key, bufferMs)?.value ?? null) : null;
  }

  orgFsConfig(tenant: Tenant, bufferMs = 0): string | null {
    return this.get(this.orgFs, tenantKey(tenant), bufferMs)?.value ?? null;
  }

  orgFsConfigExpiresAt(tenant: Tenant): number | null {
    return this.get(this.orgFs, tenantKey(tenant), 0)?.expiresAt ?? null;
  }
}

/**
 * `AgentSandboxProvider` options for a host: the mint hooks read the store
 * (null when it holds nothing with `bufferMs` of life left, so the runner
 * keeps what it has), and persisted state carries no credential.
 */
export function pushedCredentialOptions(store: PushedCredentials) {
  return {
    persistCredentials: false,
    mintCloneUrl: async (
      repo: Repo,
      opts?: { bufferMs?: number; tenant?: EnsureOptions["tenant"] },
    ): Promise<string | null> => {
      const identity = repoIdentityOf(repo);
      return identity
        ? store.cloneUrl(opts?.tenant, identity, opts?.bufferMs)
        : null;
    },
    mintOrgFsConfig: async (
      tenant: NonNullable<EnsureOptions["tenant"]>,
    ): Promise<string | null> => store.orgFsConfig(tenant),
    mintPoolCloneUrl: async (repo: {
      tenant: string;
      repoUrl: string;
    }): Promise<string | null> => store.poolCloneUrl(repo.tenant, repo.repoUrl),
  };
}
