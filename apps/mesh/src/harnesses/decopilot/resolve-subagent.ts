/**
 * Shared delegation-target resolution for the two `subtask` surfaces:
 * the in-process `subtask` built-in (`built-in-tools/subtask.ts`) and the
 * cluster-side `SUBTASK_MCP` tool (`tools/decopilot-mcp/subtask-tool.ts`).
 *
 * Both validate the target Virtual MCP identically (existence + org scope +
 * active status), open a passthrough client, and build the `targetRef` that
 * `runAgentLoop` expects. Keeping it here stops the two surfaces from drifting
 * on the error strings (`"Agent not found"` / `"Agent is not active"`) or the
 * targetRef shape.
 */
import type { GithubRepo } from "@decocms/mesh-sdk";
import type { StudioContext } from "@/core/studio-context";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import type { PassthroughClient } from "@/mcp-clients/virtual-mcp/passthrough-client";

export interface ResolvedSubagent {
  mcpClient: PassthroughClient;
  targetRef: {
    id: string;
    instructions: string | undefined;
    repo: GithubRepo | undefined;
  };
}

/**
 * Validate a delegation target, open a passthrough client for it, and build the
 * targetRef. `superUser` mirrors the parent loop's passthrough scope (used by
 * self-clones); leave it false for cross-agent delegation.
 *
 * @throws Error("Agent not found") when the id doesn't resolve in the org.
 * @throws Error("Agent is not active") when the agent exists but is inactive.
 */
export async function resolveSubagent(
  ctx: StudioContext,
  organizationId: string,
  agentId: string,
  { superUser = false }: { superUser?: boolean } = {},
): Promise<ResolvedSubagent> {
  const virtualMcp = await ctx.storage.virtualMcps.findById(
    agentId,
    organizationId,
  );
  if (!virtualMcp || virtualMcp.organization_id !== organizationId) {
    throw new Error("Agent not found");
  }
  if (virtualMcp.status !== "active") {
    throw new Error("Agent is not active");
  }

  const mcpClient = await createVirtualClientFrom(
    virtualMcp,
    ctx,
    "passthrough",
    superUser,
  );

  return {
    mcpClient,
    targetRef: {
      id: virtualMcp.id,
      instructions: mcpClient.getInstructions(),
      repo: virtualMcp.metadata?.githubRepo ?? undefined,
    },
  };
}
