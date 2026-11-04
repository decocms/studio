import {
  type BlogConnectionCandidate,
  pickBlogConnection,
} from "@decocms/shared/blog-connections";
import { VTEX_GROUNDING_TOOLS } from "./site-tools";

/**
 * The connections a blog run reads, a card's or a blog job's, with the tools
 * its key may call on each: VTEX only through its grounding tools, the Google
 * ones whole. Every one the organization has, ready or not; the tools refuse
 * what is not ready.
 *
 * A run's key reaches only the connections its agent aggregates, and a card's
 * agent is the Super Agent, which aggregates none of these. Without them its
 * grounding pass is denied on every call and reports nothing as if the store
 * had nothing to say.
 */
export function blogCardRunConnections(
  connections: readonly BlogConnectionCandidate[],
): { ids: string[]; limits: Record<string, string[]> } {
  const vtex = pickBlogConnection("vtex", connections);
  const google = [
    pickBlogConnection("ga4", connections),
    pickBlogConnection("gsc", connections),
  ];
  return {
    ids: [vtex, ...google]
      .filter((connection) => connection !== null)
      .map((connection) => connection.id),
    limits: vtex ? { [vtex.id]: [...VTEX_GROUNDING_TOOLS] } : {},
  };
}
