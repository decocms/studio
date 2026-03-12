import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  checkModelPermission,
  fetchModelPermissions,
} from "@/api/routes/decopilot/model-permissions";

export const AI_PROVIDERS_LIST_MODELS = defineTool({
  name: "AI_PROVIDERS_LIST_MODELS",
  description:
    "List models available from an AI provider using a specific API key",
  inputSchema: z.object({
    keyId: z.string().describe("The provider key ID to use"),
  }),
  outputSchema: z.object({
    models: z.array(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        logo: z.string().nullable(),
        capabilities: z.array(z.string()),
        limits: z
          .object({
            contextWindow: z.coerce.number(),
            maxOutputTokens: z.coerce.number().nullable(),
          })
          .nullable(),
        costs: z
          .object({
            input: z.coerce.number(),
            output: z.coerce.number(),
          })
          .nullable(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const allowedModels = await fetchModelPermissions(
      ctx.db,
      org.id,
      ctx.auth.user?.role,
    );

    const models = await ctx.aiProviders.listModels(input.keyId, org.id);

    const filtered = models.filter((m) =>
      checkModelPermission(allowedModels, m.providerId, m.modelId),
    );

    return { models: filtered };
  },
});
