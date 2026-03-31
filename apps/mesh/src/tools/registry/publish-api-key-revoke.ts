import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  PublishApiKeyRevokeInputSchema,
  PublishApiKeyRevokeOutputSchema,
} from "./schema";

export const REGISTRY_PUBLISH_API_KEY_REVOKE = defineTool({
  name: "REGISTRY_PUBLISH_API_KEY_REVOKE" as const,
  description:
    "Revoke a publish request API key. The key can no longer be used for authentication.",
  inputSchema: PublishApiKeyRevokeInputSchema,
  outputSchema: PublishApiKeyRevokeOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const revoked = await storage.publishApiKeys.revoke(
      organization.id,
      input.keyId,
    );

    if (!revoked) {
      throw new Error("API key not found");
    }

    return { success: true, keyId: input.keyId };
  },
});
