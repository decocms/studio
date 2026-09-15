import { z } from "zod";

const experimentVariantSchema = z.object({
  id: z.string().min(1).describe("Arm id, e.g. `control` or `variant-b`."),
  weight: z.number().int().min(0).max(100),
  role: z.enum(["control", "treatment"]).nullable().optional(),
});

/** The experiment row as the tools return it (metadata; ISO timestamps). */
export const experimentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  site: z.string(),
  key: z.string(),
  name: z.string(),
  status: z.enum(["draft", "running", "paused", "ended"]),
  goals: z.array(z.string()),
  variants: z.array(experimentVariantSchema),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
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
