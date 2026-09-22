import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { experimentSchema } from "./schema";
import { assertOwnsSite } from "./ownership";

export const EXPERIMENT_LIST = defineTool({
  name: "EXPERIMENT_LIST",
  description: "List the A/B experiments configured for a site.",
  annotations: {
    title: "List Experiments",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1).describe("Site slug the experiments belong to."),
  }),
  outputSchema: z.object({ experiments: z.array(experimentSchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);
    const experiments = await ctx.storage.experiments.listBySite(
      organization.id,
      input.site,
    );
    return { experiments };
  },
});
