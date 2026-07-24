import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { UserModelPreferencesSchema } from "@decocms/shared/organization/schema";

export const USER_MODEL_PREFERENCES_UPDATE = defineTool({
  name: "USER_MODEL_PREFERENCES_UPDATE",
  description:
    "Set the calling user's personal chat tier → model overrides for the current organization. Only affects this user; the org default is unchanged. Omit a tier (or set it null) to fall back to the org default.",
  annotations: {
    title: "Update User Model Preferences",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UserModelPreferencesSchema,
  outputSchema: UserModelPreferencesSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = ctx.auth?.user?.id;
    if (!userId) throw new Error("No authenticated user in context");

    // Scoped strictly to the caller: a user can only ever write their own row.
    // The chosen model still passes the org's role-based model allow-list at
    // send time (see decopilot/routes.ts), so no extra permission check here.
    return await ctx.storage.userModelPreferences.upsert(
      userId,
      organization.id,
      input,
    );
  },
});
