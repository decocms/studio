import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { experimentSchema } from "./schema";
import { assertOwnsSite } from "./ownership";

export const EXPERIMENT_GET = defineTool({
  name: "EXPERIMENT_GET",
  description: "Get one experiment by site + key. Null when it does not exist.",
  annotations: {
    title: "Get Experiment",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    key: z.string().min(1),
  }),
  outputSchema: z.object({ experiment: experimentSchema.nullable() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);
    const experiment = await ctx.storage.experiments.getByKey(
      organization.id,
      input.site,
      input.key,
    );
    return { experiment };
  },
});
