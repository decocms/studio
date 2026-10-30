import { z } from "zod";

/** Where a brand fill's chat is marked in its thread metadata, as a card's chat is by `blogCard`. */
export const BRAND_FILL_THREAD_KEY = "brandFill";

const BrandFillThreadSchema = z.object({ brand: z.string().min(1) });
export type BrandFillThread = z.infer<typeof BrandFillThreadSchema>;

/** The brand a chat fills, from its thread's metadata, or null for any other chat. */
export function brandFillOfThread(
  metadata: Record<string, unknown> | null | undefined,
): BrandFillThread | null {
  const parsed = BrandFillThreadSchema.safeParse(
    metadata?.[BRAND_FILL_THREAD_KEY],
  );
  return parsed.success ? parsed.data : null;
}
