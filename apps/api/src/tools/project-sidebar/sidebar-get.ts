import { z } from "zod";
import { SidebarSchema } from "@decocms/shared/project-sidebar";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const SIDEBAR_GET = defineTool({
  name: "SIDEBAR_GET",
  description:
    "Get the project sidebar for the calling member: the organization's folders (the same for everyone), the member's own pinned, hidden and dismissed projects and hidden folders, and when they joined the organization.",
  annotations: {
    title: "Get Project Sidebar",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: SidebarSchema,

  handler: async (_, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = ctx.auth?.user?.id;
    if (!userId) throw new Error("No authenticated user in context");
    const storage = ctx.storage.projectSidebar;

    const [folders, preferences, joinedAt] = await Promise.all([
      storage.getFolders(organization.id),
      storage.getPreferences(userId, organization.id),
      storage.joinedAt(userId, organization.id),
    ]);
    return { folders, preferences, joinedAt };
  },
});
