import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  checkModelPermission,
  fetchModelPermissions,
} from "@/api/routes/decopilot/model-permissions";

export const AI_PROVIDERS_LIST_MODELS = defineTool({
  name: "AI_PROVIDERS_LIST_MODELS",
  description:
    "List models available from an AI provider. Requires a valid stored API key.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  inputSchema: z.object({
    keyId: z.string().describe("The provider key ID to use"),
  }),
  outputSchema: z.object({
    models: z.array(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
        title: z.string(),
        description: z.string().nullish(),
        logo: z.string().nullish(),
        capabilities: z.array(z.string()),
        limits: z
          .object({
            contextWindow: z.coerce.number(),
            maxOutputTokens: z.coerce.number().nullable(),
          })
          .nullish(),
        costs: z
          .object({
            input: z.coerce.number(),
            output: z.coerce.number(),
          })
          .nullish(),
        asyncResearch: z.boolean().optional(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const [models, allowedModels] = await Promise.all([
      ctx.aiProviders.listModels(input.keyId, org.id),
      // `org.role` is the path-resolved role (set by resolveOrgFromPath);
      // ctx.auth.user?.role is the session's active-org role and may belong
      // to a different org than `org` if this MCP call targets a non-active one.
      fetchModelPermissions(ctx.db, org.id, org.role ?? ctx.auth.user?.role),
    ]);

    const filtered = models.filter((m) =>
      checkModelPermission(allowedModels, input.keyId, m.modelId),
    );

    return { models: filtered };
  },
});
