import { z } from "zod";

const experimentVariantSchema = z.object({
  id: z.string().min(1).describe("Arm id, e.g. `control` or `variant-b`."),
  weight: z.number().int().min(0).max(100),
  role: z.enum(["control", "treatment"]).nullable().optional(),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("One sentence: what this arm specifically shows or does."),
});

/** The lifecycle an operator drives: `draft` while the test is still being
 *  iterated on, the rest once they have started it. `lifecycle.ts` owns which
 *  moves between them are legal. */
export const experimentStatusSchema = z.enum([
  "draft",
  "running",
  "paused",
  "ended",
]);
export type ExperimentStatus = z.infer<typeof experimentStatusSchema>;

/** The experiment row as the tools return it (metadata; ISO timestamps). */
export const experimentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  site: z.string(),
  key: z.string(),
  name: z.string(),
  status: experimentStatusSchema,
  goals: z.array(z.string()),
  variants: z.array(experimentVariantSchema),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** The task board card implementing this experiment's frontend, when it has
   *  been delegated. `taskKey` is that card's human address (`DECO-07`) — what
   *  the Experiments screen deep-links to so the operator can keep talking to
   *  the Super Agent about the pull request it opened. Null before delegation,
   *  and `taskKey` alone is null when the org has no slug or the card predates
   *  the key backfill. */
  taskBoardItemId: z.string().nullable(),
  taskKey: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Variants for create/update: unique ids, integer weights summing to 100. */
export const variantsInputSchema = z
  .array(experimentVariantSchema)
  .min(1)
  .superRefine((vs, ctx) => {
    const sum = vs.reduce((a, v) => a + v.weight, 0);
    if (sum !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `variant weights must sum to 100 (got ${sum})`,
      });
    }
    if (new Set(vs.map((v) => v.id)).size !== vs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "variant ids must be unique",
      });
    }
  });
