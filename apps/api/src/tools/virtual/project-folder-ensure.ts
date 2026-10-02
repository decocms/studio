import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { resolveCallerProjectScope } from "../../core/project-scope";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { ensureProjectFolder } from "../../file-storage/project-folder";

export const PROJECT_FOLDER_ENSURE = defineTool({
  name: "PROJECT_FOLDER_ENSURE",
  description:
    "Create whatever is missing from a project's folder in the org's home volume: its fixed subfolders and memory.md. Never overwrites or removes existing files.",
  annotations: {
    title: "Ensure Project Folder",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string().min(1) }),
  outputSchema: z.object({
    path: z.string().describe("The folder's path inside the home volume"),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const project = await ctx.storage.virtualMcps.findById(
      input.id,
      organization.id,
    );
    const projectScope = await resolveCallerProjectScope(ctx);
    if (
      !project ||
      project.organization_id !== organization.id ||
      !isProjectAllowed(projectScope, project.id)
    ) {
      throw new Error(`Project not found: ${input.id}`);
    }
    if (!ctx.orgFs) {
      throw new Error("Organization filesystem is not configured");
    }

    const path = await ensureProjectFolder(
      ctx.orgFs,
      project,
      getUserId(ctx) ?? "system",
    );
    return { path };
  },
});
