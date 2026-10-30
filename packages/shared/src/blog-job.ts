import { z } from "zod";
import { MAX_PROPOSED_CAMPAIGNS } from "./blog-campaign";

/** Where a blog job's chat is marked in its thread metadata, as a card's chat is by `blogCard`. */
export const BLOG_JOB_THREAD_KEY = "blogJob";

const BlogJobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("brand-fill"), brand: z.string().min(1) }),
  z.object({
    kind: z.literal("campaigns"),
    brand: z.string().min(1),
    seedId: z.string().min(1),
    campaignIds: z.array(z.string().min(1)).min(1).max(MAX_PROPOSED_CAMPAIGNS),
  }),
]);
export type BlogJob = z.infer<typeof BlogJobSchema>;

/** The job a chat runs, from its thread's metadata, or null for any other chat. */
export function blogJobOfThread(
  metadata: Record<string, unknown> | null | undefined,
): BlogJob | null {
  const parsed = BlogJobSchema.safeParse(metadata?.[BLOG_JOB_THREAD_KEY]);
  return parsed.success ? parsed.data : null;
}
