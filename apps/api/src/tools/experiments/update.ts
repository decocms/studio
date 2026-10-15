import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  experimentSchema,
  experimentStatusSchema,
  variantsInputSchema,
} from "./schema";
import { assertOwnsSite } from "./ownership";
import {
  canTransition,
  changesStructure,
  structureEditable,
  transitionError,
} from "./lifecycle";
import { withTaskKey } from "./task-key";

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
    status: experimentStatusSchema
      .optional()
      .describe(
        "The lifecycle move to make. A draft starts (`running`); a started experiment pauses, resumes and ends. It never goes back to `draft`, and an `ended` one is final.",
      ),
    goals: z.array(z.string()).optional(),
    variants: variantsInputSchema.optional(),
  }),
  outputSchema: z.object({ experiment: experimentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);

    const current = await ctx.storage.experiments.getByKey(
      organization.id,
      input.site,
      input.key,
    );
    if (!current) {
      throw new Error(`No experiment "${input.key}" on ${input.site}.`);
    }
    if (input.status && !canTransition(current.status, input.status)) {
      throw new Error(transitionError(current.status, input.status));
    }
    if (
      input.variants &&
      !structureEditable(current.status) &&
      changesStructure(current.variants, input.variants)
    ) {
      throw new Error(
        `This experiment is ${current.status}, so its arms can be reweighted but not added, removed or renamed — users are already assigned on those identifiers.`,
      );
    }

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
    return {
      experiment: await withTaskKey(
        ctx,
        organization.id,
        organization.slug,
        experiment,
      ),
    };
  },
});
