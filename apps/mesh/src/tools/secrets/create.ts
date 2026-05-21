import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { secretInfoSchema } from "./schema";

export const SECRET_CREATE = defineTool({
  name: "SECRET_CREATE",
  description:
    "Create a secret. The value is encrypted at rest in the credential vault and never returned by any tool. Scope 'user' is private to the caller within this organization; scope 'organization' is visible to all org members.",
  inputSchema: z.object({
    scope: z.enum(["user", "organization"]),
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.-]+$/, {
        message:
          "Name may only contain letters, digits, underscore, dot, and hyphen.",
      }),
    value: z.string().min(1),
    description: z.string().max(500).optional(),
  }),
  outputSchema: secretInfoSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const callerUserId = ctx.auth.user!.id;
    const scope =
      input.scope === "user"
        ? ({ kind: "user", userId: callerUserId } as const)
        : ({ kind: "organization" } as const);

    const info = await ctx.storage.secrets.create({
      organizationId: org.id,
      scope,
      name: input.name,
      value: input.value,
      description: input.description ?? null,
      createdBy: callerUserId,
    });

    return info;
  },
});
