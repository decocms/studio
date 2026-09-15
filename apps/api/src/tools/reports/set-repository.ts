import {
  getCommerceDiscoveryAgentId,
  WellKnownOrgMCPId,
} from "@decocms/shared/sdk";
import { splitOwnerName } from "@decocms/shared/git-providers";
import {
  legacyGithubRepo,
  type ReportsRepositoryRef,
  ReportsRepositoryRefSchema,
  toWire,
} from "@decocms/shared/reports/repository-ref";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import { notifyMcpConfiguration } from "../connection/on-configuration";

/**
 * Point the org's Commerce Discovery diagnostic at one of its repositories.
 *
 * This is one server-side write because the browser was doing six: read the
 * connection, merge its state, write it back, read the agent, provision a
 * repo-scoped GitHub connection, write the agent's metadata — with a rollback
 * path for each. A tab closed anywhere in the middle left the org half-linked,
 * and every one of those steps was GitHub-only by construction.
 *
 * What it writes, and why each one:
 * - the CD connection's `configuration_state.repository` — the wire contract
 *   Reports reads, and what `ON_MCP_CONFIGURATION` hands it on the way out;
 * - `github_repo` in that same state, but ONLY for a github.com repository —
 *   the legacy string a Reports still on the old reader needs. A GitLab path
 *   with subgroups in that field would be a string the old reader parses into
 *   the wrong repository, so it is cleared rather than approximated;
 * - the Report Agent's `metadata.githubRepo`, which `agentHasClonableSource`
 *   reads to show the Preview/Code tabs and `SANDBOX_START` reads to clone.
 *   Naming the repository id there is what makes the clone authenticate
 *   through the repository's own git provider account — so, unlike the form
 *   this replaces, nothing has to mint a repo-scoped GitHub connection first,
 *   and a GitLab or Bitbucket store works the same way.
 *
 * `repositoryId: null` clears all three: the diagnostic goes back to running
 * without a code-delivery audit, which is a normal state, not an error.
 */

const InputSchema = z.object({
  repositoryId: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "Studio repository id to diagnose, or null to unlink the current one.",
    ),
});

const OutputSchema = z.object({
  repository: ReportsRepositoryRefSchema.nullable(),
});

/** The agent binding for a repository, as `SANDBOX_START` and the CMS read it. */
export function agentRepoBinding(ref: ReportsRepositoryRef) {
  const { owner, name } = splitOwnerName({ path: ref.path });
  return {
    owner,
    name,
    url: ref.webUrl ?? `https://${ref.host}/${ref.path}`,
    repositoryId: ref.repositoryId,
  };
}

/**
 * The agent's connection list with the previous binding's repo-scoped
 * connection dropped.
 *
 * A repository-backed binding carries no `connectionId`, so the GitHub
 * connection a previous save aggregated for credentials becomes dead weight on
 * the agent. The row itself is deliberately left alone: it may be the org's
 * shared "Add repo" connection rather than one this flow minted, and deleting
 * that is not recoverable, whereas an unaggregated connection is visible in
 * Settings and removable by a human.
 */
export function withoutStaleRepoConnection<T extends { connection_id: string }>(
  connections: T[],
  staleConnectionId: string | null,
): T[] {
  if (!staleConnectionId) return connections;
  return connections.filter((c) => c.connection_id !== staleConnectionId);
}

/**
 * The CD connection's state with the repository set, or cleared.
 *
 * Both spellings are rewritten from scratch rather than merged over: a
 * `github_repo` left behind from a previous github.com pick would keep naming
 * a repository nobody chose once the org moves to GitLab. Every other key the
 * MCP put there survives untouched. Pure, so the two-spelling rule is asserted
 * without a connection.
 */
export function nextConfigurationState(
  current: Record<string, unknown>,
  repository: ReportsRepositoryRef | null,
): Record<string, unknown> {
  const { repository: _r, github_repo: _g, ...rest } = current;
  const legacy = repository ? legacyGithubRepo(repository) : null;
  return {
    ...rest,
    ...(repository ? { repository: toWire(repository) } : {}),
    ...(legacy ? { github_repo: legacy } : {}),
  };
}

async function updateCommerceDiscoveryState(
  ctx: StudioContext,
  organizationId: string,
  repository: ReportsRepositoryRef | null,
): Promise<void> {
  const connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(organizationId);
  const connection = await ctx.storage.connections.findById(
    connectionId,
    organizationId,
  );
  if (!connection) {
    throw new Error(
      "Commerce Discovery is not set up for this organization yet",
    );
  }

  const state = nextConfigurationState(
    (connection.configuration_state ?? {}) as Record<string, unknown>,
    repository,
  );

  await ctx.storage.connections.update(connectionId, {
    configuration_state: state,
  });

  /**
   * Best-effort: the write already landed, so an unreachable downstream is a
   * slower sync rather than a lost pick. Never `firstRun` — this connection was
   * configured at setup.
   */
  try {
    await notifyMcpConfiguration(
      ctx,
      { ...connection, configuration_state: state },
      {
        state,
        scopes: connection.configuration_scopes ?? [],
        firstRun: false,
      },
    );
  } catch (error) {
    console.error(
      "[commerce-discovery] ON_MCP_CONFIGURATION after repository change failed",
      error,
    );
  }
}

async function updateReportAgentBinding(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
  repository: ReportsRepositoryRef | null,
): Promise<void> {
  const agentId = getCommerceDiscoveryAgentId(organizationId);
  const agent = await ctx.storage.virtualMcps.findById(agentId, organizationId);
  if (!agent) return;

  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const existing = metadata.githubRepo as { connectionId?: string } | null;
  const { githubRepo: _drop, ...restMetadata } = metadata;

  await ctx.storage.virtualMcps.update(agentId, userId, {
    metadata: {
      ...restMetadata,
      ...(repository ? { githubRepo: agentRepoBinding(repository) } : {}),
    },
    connections: withoutStaleRepoConnection(
      agent.connections ?? [],
      existing?.connectionId ?? null,
    ),
  });
}

export const COMMERCE_DISCOVERY_SET_REPOSITORY = defineTool({
  name: "COMMERCE_DISCOVERY_SET_REPOSITORY",
  description:
    "Point the organization's Commerce Discovery diagnostic at one of its linked repositories, or unlink the current one. Works for GitHub, GitLab and Bitbucket.",
  annotations: {
    title: "Set Commerce Discovery Repository",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to set the diagnostic's repository");
    }

    let repository: ReportsRepositoryRef | null = null;
    if (input.repositoryId) {
      const row = await ctx.storage.repositories.get(
        input.repositoryId,
        organization.id,
      );
      if (!row) {
        throw new Error(
          `Repository ${input.repositoryId} is not linked to this organization`,
        );
      }
      const ref = {
        repositoryId: row.id,
        provider: row.provider,
        host: row.host,
        path: row.path,
        defaultBranch: row.defaultBranch,
        webUrl: row.webUrl,
      };
      const parsed = ReportsRepositoryRefSchema.safeParse(ref);
      if (!parsed.success) {
        throw new Error(
          `Repository ${input.repositoryId} has invalid configuration (missing or empty host/path)`,
        );
      }
      repository = parsed.data;
    }

    /**
     * The connection first: it is the one Reports reads, so a failure there
     * must not leave the agent pointing at a repository the diagnostic never
     * heard about. The agent binding is the cosmetic half — tabs and clone —
     * and can safely be a moment behind.
     */
    await updateCommerceDiscoveryState(ctx, organization.id, repository);
    await updateReportAgentBinding(ctx, organization.id, userId, repository);

    return { repository };
  },
});
