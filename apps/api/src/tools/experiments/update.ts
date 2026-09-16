import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { experimentSchema, variantsInputSchema } from "./schema";
import { assertOwnsSite } from "./ownership";

export const EXPERIMENT_UPDATE = defineTool({
  name: "EXPERIMENT_UPDATE",
  description:
    "Update an experiment's definition (name, status, goals, variants). Errors when the (site, key) is unknown. When `variants` is present it replaces the full set (weights must sum to 100).",
  annotations: {
    title: "Update Experiment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1).optional(),
    status: z.enum(["draft", "running", "paused", "ended"]).optional(),
    goals: z.array(z.string()).optional(),
    variants: variantsInputSchema.optional(),
  }),
  outputSchema: z.object({ experiment: experimentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);

    const experiment = await ctx.storage.experiments.update(
      organization.id,
      input.site,
      input.key,
      {
        name: input.name,
        status: input.status,
        goals: input.goals,
        variants: input.variants,
      },
    );
    if (!experiment) {
      throw new Error(`No experiment "${input.key}" on ${input.site}.`);
    }
    return { experiment };
  },
});
