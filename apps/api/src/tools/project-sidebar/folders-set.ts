import { z } from "zod";
import { ProjectFoldersSchema } from "@decocms/shared/project-sidebar";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { emitProjectFoldersUpdated } from "./emit";

export const PROJECT_FOLDERS_SET = defineTool({
  name: "PROJECT_FOLDERS_SET",
  description:
    "Replace the organization's project folders: names, order, and which projects each holds. Org-wide, every member sees the change. A project listed in two folders stays in the first. Deleting a folder never deletes its projects.",
  annotations: {
    title: "Set Project Folders",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ folders: ProjectFoldersSchema }),
  outputSchema: z.object({ folders: ProjectFoldersSchema }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);

    const folders = await ctx.storage.projectSidebar.setFolders(
      organization.id,
      input.folders,
    );
    emitProjectFoldersUpdated(organization.id);
    return { folders };
  },
});
