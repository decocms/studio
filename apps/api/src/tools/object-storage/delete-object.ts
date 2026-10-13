import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  assertNotOrgFsKey,
  DeleteObjectInputSchema,
  DeleteObjectOutputSchema,
  requireObjectStorage,
} from "./schema";

export const DELETE_OBJECT = defineTool({
  name: "DELETE_OBJECT",
  description:
    "Delete a single object from the organization's storage. Keys under `_fs/` are rejected; " +
    "delete Library files with `DELETE /api/<org>/fs/<volume>/file`.",
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
    assertNotOrgFsKey(input.key);
    const storage = requireObjectStorage(ctx);

    try {
      await storage.delete(input.key);
      return { success: true, key: input.key };
    } catch {
      return { success: false, key: input.key };
    }
  },
});
