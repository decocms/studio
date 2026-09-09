/**
 * Reaching a repository the OLD way: through an `mcp-github` connection, for
 * orgs whose repositories have no `repositories` row yet.
 *
 * This is the only module left that knows a connection can stand for a
 * repository — both for resolving a credential and for listing what an agent
 * may clone. It is deliberately quarantined here rather than spread across the
 * task board and the repo picker: every caller above now speaks `RepoRef`, so
 * when the last org is migrated this file is the whole deletion.
 */

import {
  getRepoScope,
  isOrgSharedConnection,
} from "@decocms/shared/github-repo-scope";
import {
  repoRefFromOwnerName,
  splitOwnerName,
  type RepoRef,
} from "@decocms/shared/git-providers";
import type { StudioContext } from "@/core/studio-context";
import { isGithubConnection } from "@/oauth/github-mint";
import type { ConnectionEntity } from "@/tools/connection/schema";
import type { RepositoryRecord } from "@/storage/repositories";
import type { GitProviderStoragePorts } from "../credentials";

/**
 * Pick the connection that can reach `repo`, pure so the fallback ladder is
 * unit-testable — the rule that a repo-scoped connection for a DIFFERENT
 * repository is never a substitute is the whole point of this function and is
 * invisible from any integration test that does not happen to have two scoped
 * connections lying around.
 *
 * Prefer, in order: a repo-scoped connection matching THIS repository
 * (guaranteed access), then the broad org-level connection (no `repoScope`,
 * user OAuth over every repository).
 *
 * There is deliberately NO "any active one" last resort when a repository is
 * named. A connection scoped to a DIFFERENT repository cannot reach it — its
 * installation token is repo-scoped — so returning it buys nothing and costs
 * everything: the caller cannot tell "GitHub said no" from "we asked the wrong
 * GitHub", the live state comes back all-null, and the card silently parks in
 * review forever. This is not hypothetical: deleting the org's connection for
 * the repository its change requests were opened against stranded 40+ approved
 * cards, because the resolver kept handing back a connection for an unrelated
 * repository. Returning null instead makes the miss loud and points at the
 * real fix: connect the repository.
 */
export function pickGithubConnection<
  T extends { metadata?: Record<string, unknown> | null },
>(active: T[], repo?: { owner: string; name: string }): T | null {
  const broad = active.find((c) => getRepoScope(c) === null) ?? null;
  if (!repo) return broad ?? active[0] ?? null;
  const matching = active.find((c) => {
    const scope = getRepoScope(c);
    return scope?.owner === repo.owner && scope?.repo === repo.name;
  });
  return matching ?? broad;
}

/**
 * The legacy connection to reach `repo` through: the one recorded on the row
 * when there is one, else the org's best `mcp-github` connection for it.
 *
 * GitLab never had a legacy path — its repositories only ever existed as
 * `repositories` rows — so a non-GitHub ref answers null immediately rather
 * than borrowing a GitHub installation that cannot see it.
 */
export async function resolveLegacyGithubConnection(
  ctx: StudioContext,
  organizationId: string,
  repo: RepoRef,
  connectionId: string | null,
): Promise<ConnectionEntity | null> {
  if (repo.provider !== "github") return null;
  if (connectionId) {
    /**
     * Org-scope the lookup: this connection's GitHub installation is used to
     * MERGE change requests, so never resolve one from another org (defense in
     * depth against a foreign or colliding connection id reaching a write).
     *
     * And check the slug: a recorded id is caller-supplied data, and the token
     * it resolves goes into an `Authorization` header to github.com. Anything
     * that is not an `mcp-github` connection cannot legitimately be there, and
     * sending an unrelated integration's decrypted token to GitHub is the one
     * mistake this path must not make.
     */
    const conn = await ctx.storage.connections.findById(
      connectionId,
      organizationId,
    );
    if (conn && conn.status === "active" && isGithubConnection(conn)) {
      return conn;
    }
  }
  const { items } = await ctx.storage.connections.list(organizationId, {
    slug: "mcp-github",
  });
  return pickGithubConnection(
    items.filter((c) => c.status === "active"),
    splitOwnerName(repo),
  );
}

/**
 * One repository reachable only through a legacy connection, in the neutral
 * shape {@link listLegacyRepoChoices}' caller merges. `ref` rather than an
 * owner/name pair so the merge never has to rebuild a `github.com` URL.
 */
export interface LegacyRepoChoice {
  connectionId: string;
  ref: RepoRef;
  installationId: number;
}

/** The connection shape the legacy selection needs. */
interface RepoConnection {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

/**
 * The org-shared connections first, everything else after, order otherwise
 * preserved.
 *
 * Importing ONE repo routinely leaves two loadable connections behind — the
 * org-shared one and a per-agent one — and the merge keeps whichever it sees
 * first. The per-agent child is disposable (torn down with its agent), so an
 * org-shared sibling is the credential a run should be given; this is what
 * makes that the one that survives the dedup instead of whatever order storage
 * happened to return. Pure, and exported for its test.
 */
export function orgSharedFirst<T extends RepoConnection>(
  connections: T[],
): T[] {
  return [
    ...connections.filter(isOrgSharedConnection),
    ...connections.filter((c) => !isOrgSharedConnection(c)),
  ];
}

/** The repo-scoped connections an org can still clone through. */
function legacyRepoChoices<T extends RepoConnection>(
  connections: T[],
): LegacyRepoChoice[] {
  const out: LegacyRepoChoice[] = [];
  for (const connection of orgSharedFirst(connections)) {
    if (connection.status !== "active") continue;
    const scope = getRepoScope(connection);
    if (!scope) continue;
    out.push({
      connectionId: connection.id,
      ref: repoRefFromOwnerName(scope.owner, scope.repo),
      installationId: scope.installationId,
    });
  }
  return out;
}

/** {@link legacyRepoChoices} over the org's `mcp-github` connections. */
export async function listLegacyRepoChoices(
  ctx: StudioContext,
  organizationId: string,
): Promise<LegacyRepoChoice[]> {
  const { items } = await ctx.storage.connections.list(organizationId, {
    slug: "mcp-github",
  });
  return legacyRepoChoices(items);
}

/**
 * The repository row a legacy `metadata.githubRepo` binding refers to, if the
 * org has one — by explicit `repositoryId` when the binding carries it, else
 * by identity. Null keeps the caller on the legacy path.
 *
 * The identity fallback assumes `github.com`, which is why it lives here: a
 * binding written before repositories existed could only ever have been a
 * github.com repo.
 */
export async function findRepositoryForLegacyBinding(
  storage: Pick<GitProviderStoragePorts, "repositories">,
  organizationId: string,
  binding: { owner: string; name: string; repositoryId?: string | null },
): Promise<RepositoryRecord | null> {
  if (binding.repositoryId) {
    const byId = await storage.repositories.get(
      binding.repositoryId,
      organizationId,
    );
    if (byId) return byId;
  }
  return storage.repositories.findByRef(
    organizationId,
    repoRefFromOwnerName(binding.owner, binding.name),
  );
}
