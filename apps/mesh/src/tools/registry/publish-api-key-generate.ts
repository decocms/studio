import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  PublishApiKeyGenerateInputSchema,
  PublishApiKeyGenerateOutputSchema,
} from "./schema";

export const REGISTRY_PUBLISH_API_KEY_GENERATE = defineTool({
  name: "REGISTRY_PUBLISH_API_KEY_GENERATE" as const,
  description:
    "Generate a new API key for publish requests. The key value is only returned once — store it securely!",
  inputSchema: PublishApiKeyGenerateInputSchema,
  outputSchema: PublishApiKeyGenerateOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const { entity, key } = await storage.publishApiKeys.generate(
      organization.id,
      input.name,
    );

    return {
      id: entity.id,
      name: entity.name,
      prefix: entity.prefix,
      key,
      createdAt: entity.created_at,
    };
  },
});
