import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  PublishRequestListInputSchema,
  PublishRequestListOutputSchema,
} from "./schema";

export const REGISTRY_PUBLISH_REQUEST_LIST = defineTool({
  name: "REGISTRY_PUBLISH_REQUEST_LIST" as const,
  description:
    "List publish requests for the private registry in the current organization",
  inputSchema: PublishRequestListInputSchema,
  outputSchema: PublishRequestListOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const storage = ctx.storage.registry;
    return storage.publishRequests.list(organization.id, input);
  },
});
