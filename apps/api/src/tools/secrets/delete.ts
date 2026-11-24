import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const SECRET_DELETE = defineTool({
  name: "SECRET_DELETE",
  description:
    "Delete a secret by id. Organization-scoped secrets and the caller's own user-scoped secrets can be deleted; anything that still references the secret by name stops resolving it.",
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
  },
  inputSchema: z.object({
    id: z.string().min(1),
  }),
  outputSchema: z.object({
    success: z.literal(true),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    await ctx.storage.secrets.delete(input.id, org.id, ctx.auth.user!.id);
    return { success: true as const };
  },
});
