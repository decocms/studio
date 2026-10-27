/**
 * Shared delegation-target resolution for the inline `subtask` built-in and
 * the durable background-subtask workflow.
 *
 * A target is a Virtual MCP, an MCP connection, or a project's AGENT.md.
 */
import { type RepositoryBinding, WellKnownOrgMCPId } from "@decocms/shared/sdk";
import type { StudioContext } from "@/core/studio-context";
import {
  createConnectionClient,
  createVirtualClientFrom,
} from "@/mcp-clients/virtual-mcp";
import type { PassthroughClient } from "@/mcp-clients/virtual-mcp/passthrough-client";
import { resolveEffectiveStudioPackVirtualMcp } from "@/tools/virtual/studio-pack";
import type { VirtualMCPEntity } from "@/tools/virtual/schema";
import {
  AGENT_TARGET_PREFIX,
  agentInstructions,
  readProjectAgent,
} from "@/file-storage/project-agents";

export interface ResolvedSubagent {
  mcpClient: PassthroughClient;
  targetKind: "virtual-mcp" | "connection" | "definition";
  targetRef: {
    id: string;
    instructions: string | undefined;
    repo: RepositoryBinding | undefined;
  };
  /** The only tools the delegate may call, when its definition says so. */
  toolAllowlist?: readonly string[] | null;
}

/**
 * Validate a delegation target, open a passthrough client for it, and build the
 * targetRef. `superUser` mirrors the parent loop's passthrough scope (used by
 * self-clones); leave it false for cross-target delegation.
 *
 * @throws when the id doesn't resolve to an agent or concrete connection in
 * the organization, or when the resolved target is inactive.
 */
export async function resolveSubagent(
  ctx: StudioContext,
  organizationId: string,
  targetId: string,
  {
    superUser = false,
    homeProjectId,
  }: { superUser?: boolean; homeProjectId?: string } = {},
): Promise<ResolvedSubagent> {
  if (targetId.startsWith(AGENT_TARGET_PREFIX)) {
    return await resolveDefinition(
      ctx,
      organizationId,
      targetId.slice(AGENT_TARGET_PREFIX.length),
      homeProjectId,
    );
  }

  const virtualMcp = await ctx.storage.virtualMcps.findById(
    targetId,
    organizationId,
  );
  if (virtualMcp?.organization_id === organizationId) {
    if (virtualMcp.status !== "active") {
      throw new Error("Agent is not active");
    }

    const effectiveVirtualMcp =
      resolveEffectiveStudioPackVirtualMcp(virtualMcp);
    const mcpClient = await createVirtualClientFrom(
      effectiveVirtualMcp,
      ctx,
      superUser,
      { includeSkillsCatalog: true },
    );

    return {
      mcpClient,
      targetKind: "virtual-mcp",
      targetRef: {
        id: effectiveVirtualMcp.id,
        instructions: mcpClient.getInstructions(),
        repo: effectiveVirtualMcp.metadata?.repository ?? undefined,
      },
    };
  }

  const connection = await ctx.storage.connections.findById(
    targetId,
    organizationId,
  );
  if (
    !connection ||
    connection.organization_id !== organizationId ||
    connection.connection_type === "VIRTUAL"
  ) {
    throw new Error("Agent or MCP connection not found");
  }
  if (connection.status !== "active") {
    throw new Error("MCP connection is not active");
  }

  const mcpClient = createConnectionClient(connection, ctx, superUser);

  return {
    mcpClient,
    targetKind: "connection",
    targetRef: {
      id: connection.id,
      instructions: mcpClient.getInstructions(),
      repo: undefined,
    },
  };
}

/**
 * A specialist defined in the calling project's folder.
 *
 * It borrows the project's own MCP scope — the connections someone attached to
 * this CMS — and differs from the project only in what it was told. Resolving
 * it needs to know which project is asking, so a definition is reachable only
 * from a run that has one; there is no organization-wide namespace of these,
 * deliberately, because the file lives under a project and so does the role.
 */
async function resolveDefinition(
  ctx: StudioContext,
  organizationId: string,
  slug: string,
  homeProjectId: string | undefined,
): Promise<ResolvedSubagent> {
  if (!homeProjectId) {
    throw new Error(
      "A definition-backed agent is only reachable from a project",
    );
  }
  if (!ctx.orgFs) {
    throw new Error("Organization filesystem is not configured");
  }
  const project = await ctx.storage.virtualMcps.findById(
    homeProjectId,
    organizationId,
  );
  if (!project || project.organization_id !== organizationId) {
    throw new Error("Agent not found");
  }
  const definition = await readProjectAgent(ctx.orgFs, project, slug);
  if (!definition) throw new Error(`Agent not found: ${slug}`);

  const mcpClient = await createVirtualClientFrom(
    withStudioTools(
      resolveEffectiveStudioPackVirtualMcp(project),
      organizationId,
      definition.tools,
    ),
    ctx,
    false,
    { includeSkillsCatalog: true },
  );

  return {
    mcpClient,
    targetKind: "definition",
    toolAllowlist: definition.tools,
    targetRef: {
      id: `${AGENT_TARGET_PREFIX}${definition.slug}`,
      instructions: agentInstructions(definition),
      repo: project.metadata?.repository ?? undefined,
    },
  };
}

/**
 * The project's scope, plus Studio's own tools when the role names any.
 *
 * A project aggregates the connections someone attached to its CMS, and
 * nothing else — so a specialist reading that scope cannot see `BLOG_STATE_GET`
 * or any other tool this product implements. The organization's `self`
 * connection is where those live, and a role reaches them by naming them.
 *
 * Only when it names them. A role with no belt keeps the project's own
 * connections, which for a researcher is the whole point and for everyone is
 * what stops ~250 management tools landing in a prompt nobody asked to widen.
 */
function withStudioTools(
  project: VirtualMCPEntity,
  organizationId: string,
  belt: readonly string[] | null | undefined,
): VirtualMCPEntity {
  if (!belt || belt.length === 0) return project;
  const selfId = WellKnownOrgMCPId.SELF(organizationId);
  if (project.connections.some((c) => c.connection_id === selfId)) {
    return project;
  }
  return {
    ...project,
    connections: [
      ...project.connections,
      {
        connection_id: selfId,
        selected_tools: [...belt],
        selected_resources: [],
        selected_prompts: [],
      },
    ],
  };
}
