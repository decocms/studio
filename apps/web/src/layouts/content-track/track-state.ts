/**
 * Which track Execute shows and which state the content track is in, apart
 * from the components that render them.
 */

import {
  type BrandRequirement,
  missingBrandForGeneration,
  readBlogContext,
} from "@/components/sandbox/content/blog/blog-data";
import type { BlogState } from "@/components/sandbox/content/blog/use-blog-state";

export type Track = "code" | "content";

/**
 * Which track Execute shows, or `pending` while the answer is still loading.
 *
 * The code track is the default and needs nothing loaded. The content track
 * exists only in the project-first navigation with the blog on, and never for
 * a task opened by its address or another tenant's board. An org whose plan
 * leaves out the board opens on the content track rather than on a paywall.
 */
export function resolveExecuteTrack(input: {
  track: Track | undefined;
  /** A task open by its address, `/tasks/<KEY>`. */
  taskKey: string | undefined;
  /** `?boardOrg=`: another tenant's board. */
  boardOrg: string | undefined;
  projectFirstNav: boolean;
  /** The blog flag, undefined while the org's settings load. */
  blogAi: boolean | undefined;
  /** Whether the plan includes the board, undefined until the plan settles. */
  kanban: boolean | undefined;
}): Track | "pending" {
  if (input.taskKey || input.boardOrg || !input.projectFirstNav) return "code";
  if (input.track === "code") return "code";
  if (input.blogAi === undefined) {
    return input.track === "content" || input.kanban !== true
      ? "pending"
      : "code";
  }
  if (!input.blogAi) return "code";
  if (input.track === "content") return "content";
  if (input.kanban === undefined) return "pending";
  return input.kanban ? "code" : "content";
}

/**
 * Which of the track's states to show: still reading the brand, the setup
 * while the guide lacks what a post needs, or the track itself.
 */
export function contentTrackGate(
  blog: Pick<BlogState, "ready" | "blocks">,
):
  | { gate: "loading" | "open" }
  | { gate: "setup"; missing: BrandRequirement[] } {
  if (!blog.ready) return { gate: "loading" };
  const missing = missingBrandForGeneration(
    readBlogContext(blog.blocks).merged,
  );
  return missing.length > 0 ? { gate: "setup", missing } : { gate: "open" };
}
