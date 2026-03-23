import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  checkModelPermission,
  fetchModelPermissions,
} from "@/api/routes/decopilot/model-permissions";
import { CLAUDE_CODE_MODELS } from "@/ai-providers/adapters/claude-code";

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
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    // Claude Code uses a DB key with providerId "claude-code"
    const keyInfo = await ctx.storage.aiProviderKeys
      .findById(input.keyId, org.id)
      .catch(() => null);

    if (keyInfo?.providerId === "claude-code") {
      return { models: CLAUDE_CODE_MODELS };
    }

    const allowedModels = await fetchModelPermissions(
      ctx.db,
      org.id,
      ctx.auth.user?.role,
    );

    const models = await ctx.aiProviders.listModels(input.keyId, org.id);

    const filtered = models.filter((m) =>
      checkModelPermission(allowedModels, input.keyId, m.modelId),
    );

    return { models: filtered };
  },
});
