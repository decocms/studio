import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  DeleteObjectsInputSchema,
  DeleteObjectsOutputSchema,
  requireObjectStorage,
} from "./schema";

export const DELETE_OBJECTS = defineTool({
  name: "DELETE_OBJECTS",
  description:
    "Delete multiple objects from the organization's storage in batch.",
  annotations: {
    title: "Delete Objects",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: DeleteObjectsInputSchema,
  outputSchema: DeleteObjectsOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const storage = requireObjectStorage(ctx);

    const deleted: string[] = [];
    const errors: { key: string; message: string }[] = [];

    await Promise.all(
      input.keys.map(async (key: string) => {
        try {
          await storage.delete(key);
          deleted.push(key);
        } catch (err) {
          errors.push({
            key,
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }),
    );

    return { deleted, errors };
  },
});
