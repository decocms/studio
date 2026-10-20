import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { assertOwnsSite } from "./ownership";

export const EXPERIMENT_DELETE = defineTool({
  name: "EXPERIMENT_DELETE",
  description:
    "Delete an experiment (metadata) by site + key. Returns whether a row existed.",
  annotations: {
    title: "Delete Experiment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    key: z.string().min(1),
  }),
  outputSchema: z.object({
    site: z.string(),
    key: z.string(),
    deleted: z.boolean(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);
    const deleted = await ctx.storage.experiments.delete(
      organization.id,
      input.site,
      input.key,
    );
    return { site: input.site, key: input.key, deleted };
  },
});
