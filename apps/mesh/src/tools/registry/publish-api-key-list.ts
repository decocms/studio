import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { z } from "zod";
import { PublishApiKeyListOutputSchema } from "./schema";

export const REGISTRY_PUBLISH_API_KEY_LIST = defineTool({
  name: "REGISTRY_PUBLISH_API_KEY_LIST" as const,
  description:
    "List all publish request API keys for the current organization (metadata only, no key values)",
  inputSchema: z.object({}),
  outputSchema: PublishApiKeyListOutputSchema,

  handler: async (_input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const items = await storage.publishApiKeys.list(organization.id);

    return {
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        prefix: item.prefix,
        createdAt: item.created_at,
      })),
    };
  },
});
