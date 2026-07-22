/**
 * Shared delegation-target resolution for the inline `subtask` built-in and
 * the durable background-subtask workflow.
 *
 * A target may be a persisted Virtual MCP or a concrete MCP connection. The
 * latter becomes an ephemeral subagent whose MCP scope contains exactly that
 * connection; no Virtual MCP row is created. Both paths enforce organization
 * scope + active status and return the same runtime target shape.
 */
import type { GithubRepo } from "@decocms/mesh-sdk";
import type { StudioContext } from "@/core/studio-context";
import {
  createConnectionClient,
  createVirtualClientFrom,
} from "@/mcp-clients/virtual-mcp";
import type { PassthroughClient } from "@/mcp-clients/virtual-mcp/passthrough-client";
import { resolveEffectiveStudioPackVirtualMcp } from "@/tools/virtual/studio-pack";

export interface ResolvedSubagent {
  mcpClient: PassthroughClient;
  targetKind: "virtual-mcp" | "connection";
  targetRef: {
    id: string;
    instructions: string | undefined;
    repo: GithubRepo | undefined;
  };
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
  { superUser = false }: { superUser?: boolean } = {},
): Promise<ResolvedSubagent> {
  const virtualMcp = await ctx.storage.virtualMcps.findById(
    targetId,
    organizationId,
  );
  if (virtualMcp?.organization_id === organizationId) {
    if (virtualMcp.status !== "active") {
      throw new Error("Agent is not active");
    }

    const effectiveVirtualMcp = await resolveEffectiveStudioPackVirtualMcp({
      virtualMcp,
      organizationId,
      ctx,
    });
    const mcpClient = await createVirtualClientFrom(
      effectiveVirtualMcp,
      ctx,
      "passthrough",
      superUser,
      { includeSkillsCatalog: true },
    );

    return {
      mcpClient,
      targetKind: "virtual-mcp",
      targetRef: {
        id: effectiveVirtualMcp.id,
        instructions: mcpClient.getInstructions(),
        repo: effectiveVirtualMcp.metadata?.githubRepo ?? undefined,
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
