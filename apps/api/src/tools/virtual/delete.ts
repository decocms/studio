/**
 * COLLECTION_VIRTUAL_MCP_DELETE Tool
 *
 * Delete a virtual MCP with collection binding compliance.
 */

import { z } from "zod";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { deleteAgentPrompts } from "../../file-storage/agent-prompts";
import { VirtualMCPEntitySchema } from "./schema";

/**
 * Input schema for deleting a virtual MCP
 */
const DeleteInputSchema = z.object({
  id: z.string().describe("ID of the virtual MCP to delete"),
});

export type DeleteVirtualMCPInput = z.infer<typeof DeleteInputSchema>;

/**
 * Output schema for virtual MCP delete
 */
const DeleteOutputSchema = z.object({
  item: VirtualMCPEntitySchema.describe("The deleted virtual MCP entity"),
});

export const COLLECTION_VIRTUAL_MCP_DELETE = defineTool({
  name: "COLLECTION_VIRTUAL_MCP_DELETE",
  description: "Permanently delete a Virtual MCP and its virtual tools.",
  annotations: {
    title: "Delete Virtual MCP",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: DeleteInputSchema,
  outputSchema: DeleteOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    // Get the virtual MCP before deleting (to return it)
    const existing = await ctx.storage.virtualMcps.findById(input.id);
    if (!existing) {
      throw new Error(`Virtual MCP not found: ${input.id}`);
    }
    if (existing.organization_id !== organization.id) {
      throw new Error(`Virtual MCP not found: ${input.id}`);
    }

    // Delete the agent first. virtualMcps.delete() removes (in its transaction)
    // the connection_aggregations rows that reference the per-agent child
    // connection under an ON DELETE RESTRICT FK (migration 026) — deleting the
    // child before this would throw and make the agent undeletable. The child
    // connection row itself is NOT removed by this (it's a separate, non-VIRTUAL
    // connection), so its token is still readable below.
    await ctx.storage.virtualMcps.delete(input.id);

    // If this agent was the org's "main agent" (the one `/$org` lands on),
    // clear the pointer so the stored state stays truthful and the landing
    // falls back to the Super Agent. Best-effort: the landing resolver also
    // guards against a dangling id, so a cleanup hiccup must not fail delete.
    try {
      const settings = await ctx.storage.organizationSettings.get(
        organization.id,
      );
      if (settings?.main_agent_id === input.id) {
        await ctx.storage.organizationSettings.upsert(organization.id, {
          main_agent_id: null,
        });
      }
    } catch (err) {
      console.error("[VIRTUAL_MCP_DELETE] failed to clear main agent pointer", {
        id: input.id,
        error: (err as Error).message,
      });
    }

    // Drop the agent's seeded kickstart prompts from org-fs (best-effort).
    if (ctx.orgFs) {
      await deleteAgentPrompts(ctx.orgFs, input.id, getUserId(ctx) ?? "system");
    }

    // Tear down the per-agent repo-scoped mcp-github child connection (if any).
    // Best-effort: the agent is already deleted, so a cleanup hiccup must not
    // fail the user's delete (worst case it orphans a child whose minted token
    // self-expires within ~1h). Self-revoke the token first, then delete the
    // child (its downstream_tokens + now-unreferenced aggregation rows cascade).
    const childConnectionId = (
      existing.metadata as { githubRepo?: { connectionId?: string } } | null
    )?.githubRepo?.connectionId;
    if (childConnectionId) {
      try {
        const child = await ctx.storage.connections.findById(
          childConnectionId,
          organization.id,
        );
        // No need to check whether the child is aggregated under another agent:
        // the import flow creates a fresh child per agent (1:1), and the
        // ON DELETE RESTRICT FK on connection_aggregations.child_connection_id
        // makes connections.delete throw (caught + logged below) rather than
        // orphan a still-referenced child.
        if (child && getRepoScope(child)) {
          const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
          const tok = await tokenStorage.get(childConnectionId);
          if (tok?.accessToken) {
            try {
              await fetch("https://api.github.com/installation/token", {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${tok.accessToken}`,
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28",
                },
                signal: AbortSignal.timeout(5000),
              });
            } catch {
              // Best-effort revoke; the token self-expires within ~1h regardless.
            }
          }
          await ctx.storage.connections.delete(childConnectionId);
        }
      } catch (err) {
        console.error(
          "[VIRTUAL_MCP_DELETE] failed to tear down repo-scoped connection",
          { childConnectionId, error: (err as Error).message },
        );
      }
    }

    // Return virtual MCP entity directly (already in correct format)
    return {
      item: existing,
    };
  },
});
