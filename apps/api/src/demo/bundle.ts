import { z } from "zod";
import { DemoRecipeSchema } from "@decocms/shared/demo";

const RecipeSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(50_000),
  steps: z.array(z.string().min(1)).length(3),
  result: z.string().min(1),
  diff: z.string().min(1),
});

/** Operator-supplied executable assets. Import through the CLI, never an org tool. */
export const DemoBundleSchema = z.object({
  version: z.literal(1),
  source: z.object({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    reportsCommit: z.string().regex(/^[a-f0-9]{40}$/),
    siteUrl: z.string().url(),
    capturedAt: z.string().datetime(),
  }),
  recipes: z.record(DemoRecipeSchema, RecipeSchema),
  storefront: z.object({
    base: z.string().min(1),
    search: z.string().min(1),
    promotion: z.string().min(1),
    diagnostic: z.string().min(1),
    "search,promotion": z.string().min(1),
    "search,diagnostic": z.string().min(1),
    "promotion,diagnostic": z.string().min(1),
    "search,promotion,diagnostic": z.string().min(1),
  }),
  assets: z
    .record(
      z.string().regex(/^[a-f0-9]{64}$/),
      z.object({
        mime: z
          .string()
          .regex(/^(image\/|font\/|application\/(font|x-font|octet-stream))/),
        body: z.string().max(14_000_000),
      }),
    )
    .default({}),
  reportsHtml: z.string().min(1).max(5_000_000),
  diagnostic: z
    .object({
      url: z.string(),
      sections: z.array(z.unknown()).min(1),
      summary: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
});
export type DemoBundle = z.infer<typeof DemoBundleSchema>;
export function storefrontKey(
  recipes: string[],
): keyof DemoBundle["storefront"] {
  return (["search", "promotion", "diagnostic"]
    .filter((r) => recipes.includes(r))
    .join(",") || "base") as keyof DemoBundle["storefront"];
}
