/**
 * VIRTUAL_MCP_RELEASE_EDIT Tool
 *
 * One edit to a project's draft list (`metadata.releases`), applied to the
 * stored list rather than sent as a whole array.
 */

import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import {
  applyReleaseEdit,
  ReleaseEditSchema,
} from "@decocms/shared/release-edits";
import { ReleaseSchema } from "@decocms/shared/sdk/types";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { resolveCallerProjectScope } from "../../core/project-scope";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";

export const VIRTUAL_MCP_RELEASE_EDIT = defineTool({
  name: "VIRTUAL_MCP_RELEASE_EDIT" as const,
  description:
    "Add, rename, remove, or retag one draft in a project's draft list (metadata.releases). Applied to the stored list, so concurrent edits compose. Removing a draft leaves its branch.",
  annotations: {
    title: "Edit Project Draft",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string().describe("ID of the project (virtual MCP)"),
    edit: ReleaseEditSchema,
  }),
  outputSchema: z.object({
    releases: z.array(ReleaseSchema).describe("The draft list as stored"),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to edit a project's drafts");
    }

    // A project-scoped role may only mutate projects in its allowlist.
    const projectScope = await resolveCallerProjectScope(ctx);
    const releases = isProjectAllowed(projectScope, input.id)
      ? await ctx.storage.virtualMcps.editReleases({
          id: input.id,
          organizationId: organization.id,
          edit: (current) => applyReleaseEdit(current, input.edit),
          by: userId,
        })
      : null;
    if (!releases) {
      throw new Error(`Virtual MCP not found: ${input.id}`);
    }
    return { releases };
  },
});
