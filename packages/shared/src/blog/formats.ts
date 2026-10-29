/**
 * A format is how this brand builds a post of a given kind, written as prose
 * that cites blocks as `@Name`.
 *
 * The citations are the link between an editorial decision and a technical
 * one: they pick the blocks a draft reaches for, on top of the basic ones.
 */
import {
  type BlogBlockDiscoveryOptions,
  blockComponentName,
  discoverBlogBlockTypes,
} from "./block-discovery";
import type { LiveMeta } from "./live-meta";

/**
 * A format is a name plus a markdown brief, injected into the generation
 * prompt — deliberately loose, so it cites sections rather than sequencing
 * them. Same `{ name, value }` shape as a brand rule, so `normalizeBrandRules`
 * already reads the list.
 */
export const FORMATS_BLOCK_KEY = "blog-manager-formats";

export interface MentionableSection {
  /** The label a citation shows: `ProductShelf`. */
  name: string;
  /** What the citation actually points at — the block it resolves to. */
  resolveType: string;
  title: string;
  description?: string;
}

/**
 * The sections a format's brief may cite.
 *
 * Every discovered block, not one per component name: a site that overrides an
 * app block has two `Heading`s, and they are different blocks. Collapsing them
 * was only tenable while a citation was the bare name, which could not tell
 * them apart; now that it carries the `resolveType` they are distinguishable,
 * and hiding one meant a brief could never cite it.
 */
export function mentionableSections(
  meta: LiveMeta,
  options?: BlogBlockDiscoveryOptions,
): MentionableSection[] {
  return discoverBlogBlockTypes(meta, options).map((block) => ({
    name: blockComponentName(block.resolveType),
    resolveType: block.resolveType,
    title: block.title,
    description: block.description,
  }));
}

/**
 * The blocks a brief cites, as resolveTypes.
 *
 * A citation is the markdown link `[@Heading](<resolveType>)` — the same shape
 * `@decocms/shared/mentions` uses for people, and for the same reason: a
 * component name repeats across an app block and a site's override of it, so
 * which block renders must not depend on the name.
 *
 * A bare `@Name` still reads, because briefs written before this and briefs a
 * model writes both use it. It resolves through `byName` when the site has that
 * component, and is returned as-is when it does not, so an unknown citation
 * stays visible as one.
 */
/**
 * A `[@Name](resolveType)` citation.
 *
 * Both repetitions are bounded, which is the whole reason this is a constant
 * rather than a literal beside each use. Unbounded, a format of `[@[@[@…`
 * costs time quadratic in its length: every `[@` starts a scan to the end of
 * the string looking for a `]` that never comes. A block name and a
 * resolveType are both far shorter than these caps, so nothing real is
 * excluded — and a format is written by a person or a model, which is exactly
 * the input a bound belongs on.
 */
const CITATION = /\[@[^\]]{1,200}\]\(([^)\s]{1,500})\)/g;

export function citedSections(
  markdown: string,
  byName: Record<string, string> = {},
): string[] {
  const cited = new Set<string>();
  const linked = CITATION;
  for (const match of markdown.matchAll(linked)) {
    if (match[1]) cited.add(match[1]);
  }
  const bare = /(?:^|[\s([{>])@([A-Za-z][\w-]*)/g;
  for (const match of markdown.replace(linked, " ").matchAll(bare)) {
    const name = match[1];
    if (name) cited.add(byName[name] ?? name);
  }
  return [...cited];
}

// ------------------ Generation ----------------------------------------------
