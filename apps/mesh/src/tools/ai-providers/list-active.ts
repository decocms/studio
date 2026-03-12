import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PROVIDERS } from "../../ai-providers/registry";

export const AI_PROVIDERS_ACTIVE = defineTool({
  name: "AI_PROVIDERS_ACTIVE",
  description: "List AI providers that have at least one API key configured",
  inputSchema: z.object({}),
  outputSchema: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        logo: z.string().optional(),
        keyCount: z.number(),
      }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const allKeys = await ctx.storage.aiProviderKeys.list({
      organizationId: org.id,
    });

    // Group by provider, count keys, enrich with registry metadata
    const countByProvider = new Map<string, number>();
    for (const key of allKeys) {
      countByProvider.set(
        key.providerId,
        (countByProvider.get(key.providerId) ?? 0) + 1,
      );
    }

    const providers = [...countByProvider.entries()].flatMap(
      ([providerId, keyCount]) => {
        const adapter = PROVIDERS[providerId as keyof typeof PROVIDERS];
        if (!adapter) {
          console.warn(
            `AI provider "${providerId}" has stored keys but is not in the registry; skipping.`,
          );
          return [];
        }
        return [{ ...adapter.info, keyCount }];
      },
    );

    return { providers };
  },
});
