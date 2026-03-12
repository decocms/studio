import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  checkKeyPermission,
  fetchModelPermissions,
} from "@/api/routes/decopilot/model-permissions";

export const AI_PROVIDER_KEY_DELETE = defineTool({
  name: "AI_PROVIDER_KEY_DELETE",
  description: "Delete a stored AI provider API key",
  inputSchema: z.object({
    keyId: z.string().describe("The provider key ID to delete"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const allowedModels = await fetchModelPermissions(
      ctx.db,
      org.id,
      ctx.auth.user?.role,
    );
    if (!checkKeyPermission(allowedModels, input.keyId)) {
      throw new Error("Access denied: insufficient permissions for this key");
    }

    await ctx.storage.aiProviderKeys.delete(input.keyId, org.id);

    return { success: true };
  },
});
