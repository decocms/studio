import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  PublishRequestDeleteInputSchema,
  PublishRequestDeleteOutputSchema,
} from "./schema";

export const REGISTRY_PUBLISH_REQUEST_DELETE = defineTool({
  name: "REGISTRY_PUBLISH_REQUEST_DELETE" as const,
  description:
    "Delete a publish request from the private registry in the current organization",
  inputSchema: PublishRequestDeleteInputSchema,
  outputSchema: PublishRequestDeleteOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const storage = ctx.storage.registry;
    const item = await storage.publishRequests.delete(
      organization.id,
      input.id,
    );
    return { item };
  },
});
