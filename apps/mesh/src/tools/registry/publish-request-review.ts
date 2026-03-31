import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  PublishRequestReviewInputSchema,
  PublishRequestReviewOutputSchema,
} from "./schema";

export const REGISTRY_PUBLISH_REQUEST_REVIEW = defineTool({
  name: "REGISTRY_PUBLISH_REQUEST_REVIEW" as const,
  description:
    "Approve or reject a publish request for the private registry in the current organization",
  inputSchema: PublishRequestReviewInputSchema,
  outputSchema: PublishRequestReviewOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const storage = ctx.storage.registry;

    // When approving, verify the requested_id/title don't conflict with existing registry items
    if (input.status === "approved") {
      const request = await storage.publishRequests.findById(
        organization.id,
        input.id,
      );
      if (!request) {
        throw new Error(`Publish request not found: ${input.id}`);
      }

      const targetId = request.requested_id ?? request.server?.name;
      // Check by id
      if (targetId) {
        const existing = await storage.items.findByIdOrName(
          organization.id,
          targetId,
        );
        if (existing) {
          throw new Error(
            `Cannot approve: a registry item with id "${existing.id}" already exists. Delete or rename it first.`,
          );
        }
      }
      // Check by title (it may differ from the id)
      if (request.title && request.title !== targetId) {
        const existingByTitle = await storage.items.findByIdOrName(
          organization.id,
          request.title,
        );
        if (existingByTitle) {
          throw new Error(
            `Cannot approve: a registry item with title "${existingByTitle.title}" already exists. Delete or rename it first.`,
          );
        }
      }
    }

    const item = await storage.publishRequests.updateStatus(
      organization.id,
      input.id,
      input.status,
      input.reviewerNotes ?? null,
    );
    return { item };
  },
});
