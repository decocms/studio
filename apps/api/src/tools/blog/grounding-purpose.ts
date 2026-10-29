/**
 * What a grounding pass asks the brand's systems, per the thing being written.
 *
 * These sentences used to live inside each generator, which is why five tools
 * each ran their own pass. Collected here so one pass can serve whichever
 * generator comes next, and so the question stays server-owned: the caller
 * names a purpose, never the prompt.
 *
 * `focus` is the one thing a caller legitimately knows and this file cannot —
 * which campaign, which subject. It is named in the task sentence and nowhere
 * else, so it steers relevance without rewriting the brief.
 */

export const GROUNDING_PURPOSES = [
  "brand",
  "context",
  "format",
  "link",
  "campaign",
  "post",
] as const;

export type GroundingPurpose = (typeof GROUNDING_PURPOSES)[number];

interface Brief {
  task: string;
  wanted: string;
}

const BRIEFS: Record<GroundingPurpose, Brief> = {
  brand: {
    task: "Building a brand profile for this site's blog, from its own pages.",
    wanted:
      "What this business actually sells and under what names — the shape of its catalog, the words it uses for its categories and products, its price range, and anything currently being promoted. These are the terms customers search for, which a site's prose almost never states about itself.",
  },
  context: {
    task: "Inferring how this brand's blog is written, from what it has published.",
    wanted:
      "The vocabulary this brand uses for ordinary things, and the subjects its published pages keep returning to. What it calls its own categories matters more than what the category is.",
  },
  format: {
    task: "Proposing the shapes of post this brand would publish.",
    wanted:
      "What the brand sells and who buys it, enough to tell which kinds of post would have something to say. Categories and their sizes are worth more than individual products.",
  },
  link: {
    task: "Choosing which of this brand's own pages a post should link to.",
    wanted:
      "The categories and collections this store actually has, with the addresses a reader can open.",
  },
  campaign: {
    task: "Proposing blog campaigns for this brand.",
    wanted:
      "What is selling and what is not, what people search for and do not find, what is in stock and what is being promoted. Numbers read from a tool are the point; a campaign proposed without them is a guess.",
  },
  post: {
    task: "Writing blog posts for one of this brand's campaigns.",
    wanted:
      "The products and categories this post could name, with their ids, prices, addresses and image URLs exactly as the store reports them. A post names real things or it names nothing.",
  },
};

/** The brief for a purpose, with the caller's `focus` named in the task. */
export function groundingRequestFor(
  purpose: GroundingPurpose,
  focus?: string,
): Brief {
  const brief = BRIEFS[purpose];
  const trimmed = focus?.trim();
  return trimmed
    ? { ...brief, task: `${brief.task} Specifically: ${trimmed}` }
    : brief;
}
