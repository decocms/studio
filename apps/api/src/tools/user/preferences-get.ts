import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { UserModelPreferencesSchema } from "@decocms/shared/organization/schema";

const EMPTY: z.infer<typeof UserModelPreferencesSchema> = { tiers: {} };

export const USER_MODEL_PREFERENCES_GET = defineTool({
  name: "USER_MODEL_PREFERENCES_GET",
  description:
    "Get the calling user's personal chat tier → model overrides for the current organization. Absent tiers fall back to the org default.",
  annotations: {
    title: "Get User Model Preferences",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: UserModelPreferencesSchema,

  handler: async (_, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = ctx.auth?.user?.id;
    if (!userId) throw new Error("No authenticated user in context");

    const prefs = await ctx.storage.userModelPreferences.get(
      userId,
      organization.id,
    );
    return prefs ?? EMPTY;
  },
});
