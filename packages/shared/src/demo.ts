import { z } from "zod";

export const DEMO_UPDATED_EVENT = "demo.organization.updated";
export const DEMO_SCENARIO = "storefront-v1";
export const DemoRecipeSchema = z.enum(["search", "promotion", "diagnostic"]);
export type DemoRecipe = z.infer<typeof DemoRecipeSchema>;
export const DemoStatusSchema = z.object({
  enabled: z.boolean(),
  scenario: z.string(),
  generation: z.number().int(),
  resetAt: z.string(),
  activeRuns: z.number().int(),
  sessionOwner: z.string().nullable(),
  sessionExpiresAt: z.string().nullable(),
  tasks: z.array(z.object({ id: z.string(), recipe: DemoRecipeSchema })),
});
export type DemoStatus = z.infer<typeof DemoStatusSchema>;
