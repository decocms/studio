import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { experimentSchema, variantsInputSchema } from "./schema";
import { assertOwnsSite } from "./ownership";

export const EXPERIMENT_CREATE = defineTool({
  name: "EXPERIMENT_CREATE",
  description:
    "Create a draft A/B experiment for a site. `key` must be unique for the site and match the identifier the site's `useExperiment(key)` call uses; weights must sum to 100. Does not publish — it stores the definition; registering the split with the deco-ab-testing Worker and wiring the site's build-time manifest is a separate step.",
  annotations: {
    title: "Create Experiment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe(
        "The test's identifier (e.g. `valentine-banner`) — must exactly match the string the site's code passes to `useExperiment(key)` and the test name registered with the deco-ab-testing Worker. Results only populate when both agree with this key.",
      ),
    name: z.string().min(1),
    goals: z.array(z.string()).optional(),
    variants: variantsInputSchema.optional(),
  }),
  outputSchema: z.object({ experiment: experimentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);
    const createdBy = ctx.auth.user!.id;

    const existing = await ctx.storage.experiments.getByKey(
      organization.id,
      input.site,
      input.key,
    );
    if (existing) {
      throw new Error(
        `An experiment "${input.key}" already exists on ${input.site}.`,
      );
    }

    const experiment = await ctx.storage.experiments.create({
      organizationId: organization.id,
      site: input.site,
      key: input.key,
      name: input.name,
      goals: input.goals,
      variants: input.variants,
      createdBy,
    });
    return { experiment };
  },
});
