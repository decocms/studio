import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  DeleteObjectsInputSchema,
  DeleteObjectsOutputSchema,
  deleteOrgFsKey,
  requireObjectStorage,
} from "./schema";
import { parseOrgFsKey } from "../../file-storage/org-fs-path";

export const DELETE_OBJECTS = defineTool({
  name: "DELETE_OBJECTS",
  description:
    "Delete multiple objects from the organization's storage in batch. `_fs/<volume>/<path>` keys " +
    "delete those Library files or folders.",
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
          const fsTarget = parseOrgFsKey(key);
          if (fsTarget) await deleteOrgFsKey(ctx, fsTarget);
          else await storage.delete(key);
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
