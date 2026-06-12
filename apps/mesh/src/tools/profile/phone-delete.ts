import z from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/studio-context";

/** Unlink the caller's WhatsApp number. */
export const PHONE_DELETE = defineTool({
  name: "PHONE_DELETE",
  description: "Unlink the caller's WhatsApp number.",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    await ctx.storage.userPhones.delete(userId);
    return { ok: true };
  },
});
