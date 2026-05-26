import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { getGitProviders } from "@/git-providers/registry";

export const GIT_PROVIDERS_LIST = defineTool({
  name: "GIT_PROVIDERS_LIST",
  description:
    "List supported Git providers (e.g. GitHub) and whether each is configured on this Studio instance.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: z.object({}),
  outputSchema: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        logo: z.string().optional(),
        available: z
          .boolean()
          .describe(
            "True when env vars are present and the adapter can be used.",
          ),
      }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const providers = Object.values(getGitProviders()).map((adapter) => ({
      ...adapter.info,
    }));
    return { providers };
  },
});
