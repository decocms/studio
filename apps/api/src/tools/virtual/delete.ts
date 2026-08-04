/**
 * COLLECTION_VIRTUAL_MCP_DELETE Tool
 *
 * Delete a virtual MCP with collection binding compliance.
 */

import { z } from "zod";
import {
  getRepoScope,
  isOrgSharedConnection,
} from "@decocms/shared/github-repo-scope";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { deleteAgentPrompts } from "../../file-storage/agent-prompts";
import { VirtualMCPEntitySchema } from "./schema";
import { isUndeletableWellKnownVirtualMcp } from "./well-known-virtual-mcp";

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

    // These well-known agent ids are synthetic (never a real `connections` row) —
    // findById() below returns a fake entity for them instead of null, which
    // would bypass the not-found check and let delete() silently wipe out the
    // agent's threads (virtual_mcp_id has no DB FK) while reporting success.
    if (isUndeletableWellKnownVirtualMcp(input.id)) {
      throw new Error(`Virtual MCP not found: ${input.id}`);
    }

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

    // Tear down this agent's repo-scoped mcp-github child connection, if the
    // connection is in fact this agent's alone (see the checks below).
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
        // A repo connection is NOT this agent's to delete when someone else
        // holds it. Import reuses an existing connection for a repository the
        // org already has, so the old 1:1 child-per-agent assumption is gone:
        //
        //  - org-shared ("Add repo") belongs to the org, not to any agent;
        //  - still-aggregated means another agent lists it (this agent's own
        //    rows were dropped by `virtualMcps.delete` above).
        //
        // Both checks run BEFORE the revoke. Relying on the ON DELETE RESTRICT
        // FK to stop the delete is not enough: the token would already have
        // been revoked by then, leaving a live connection with a dead grant.
        const heldBySomeoneElse =
          child &&
          (isOrgSharedConnection(child) ||
            (
              await ctx.storage.virtualMcps.listByConnectionId(
                organization.id,
                childConnectionId,
              )
            ).length > 0);
        if (child && getRepoScope(child) && !heldBySomeoneElse) {
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
