import { SidebarPreferencesSchema } from "@decocms/shared/project-sidebar";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const SIDEBAR_PREFERENCES_SET = defineTool({
  name: "SIDEBAR_PREFERENCES_SET",
  description:
    "Replace the calling member's own sidebar preferences: pinned, hidden and dismissed projects, and hidden folders. Affects only this member.",
  annotations: {
    title: "Set Sidebar Preferences",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: SidebarPreferencesSchema,
  outputSchema: SidebarPreferencesSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = ctx.auth?.user?.id;
    if (!userId) throw new Error("No authenticated user in context");

    // Scoped to the caller: a member only ever writes their own row.
    return ctx.storage.projectSidebar.setPreferences(
      userId,
      organization.id,
      input,
    );
  },
});
