import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

const secretInfoSchema = z.object({
  id: z.string(),
  scope: z.enum(["user", "organization"]),
  userId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export const SECRET_LIST = defineTool({
  name: "SECRET_LIST",
  description:
    "List secrets visible to the caller: all organization-scoped secrets, plus user-scoped secrets owned by the caller. Values are never returned.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  inputSchema: z.object({
    scope: z.enum(["user", "organization"]).optional(),
  }),
  outputSchema: z.object({
    secrets: z.array(secretInfoSchema),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const callerUserId = ctx.auth.user!.id;
    const scopeFilter =
      input.scope === "user"
        ? ({ kind: "user", userId: callerUserId } as const)
        : input.scope === "organization"
          ? ({ kind: "organization" } as const)
          : undefined;

    const secrets = await ctx.storage.secrets.list({
      organizationId: org.id,
      callerUserId,
      scope: scopeFilter,
    });

    return { secrets };
  },
});
