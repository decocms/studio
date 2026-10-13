import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  DeleteObjectInputSchema,
  DeleteObjectOutputSchema,
  deleteOrgFsKey,
  requireObjectStorage,
} from "./schema";
import { parseOrgFsKey } from "../../file-storage/org-fs-path";

export const DELETE_OBJECT = defineTool({
  name: "DELETE_OBJECT",
  description:
    "Delete a single object from the organization's storage. A `_fs/<volume>/<path>` key deletes " +
    "that Library file, or the folder and everything under it.",
  annotations: {
    title: "Delete Object",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: DeleteObjectInputSchema,
  outputSchema: DeleteObjectOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const fsTarget = parseOrgFsKey(input.key);
    if (fsTarget) {
      await deleteOrgFsKey(ctx, fsTarget);
      return { success: true, key: input.key };
    }
    const storage = requireObjectStorage(ctx);

    try {
      await storage.delete(input.key);
      return { success: true, key: input.key };
    } catch {
      return { success: false, key: input.key };
    }
  },
});
