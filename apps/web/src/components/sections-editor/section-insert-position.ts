import { isSavedBlockResolveType } from "./block-type-utils";
import { isLazyResolveType } from "./section-lazy";
import type { RawSection } from "./section-types";

/** A footer module path (`site/sections/Footer/Footer.tsx`) or a saved block
 *  named after one (`Footer`, `Footer Farm ETC`) — not `PreFooterBanner`. */
const FOOTER_PATTERN = /(^|[/\s_-])footer/i;

/** Saved blocks can point at other saved blocks; stop following after this many hops. */
const MAX_SAVED_BLOCK_HOPS = 5;

function isFooterSection(
  section: RawSection,
  decofile: Record<string, unknown>,
): boolean {
  let rt = section.__resolveType ?? "";
  if (isLazyResolveType(rt)) rt = section.section?.__resolveType ?? "";

  for (let hop = 0; hop < MAX_SAVED_BLOCK_HOPS; hop++) {
    if (FOOTER_PATTERN.test(rt)) return true;
    if (!isSavedBlockResolveType(rt) || !(rt in decofile)) return false;
    const block = decofile[rt] as Record<string, unknown> | undefined;
    if (typeof block?.name === "string" && FOOTER_PATTERN.test(block.name)) {
      return true;
    }
    rt = typeof block?.__resolveType === "string" ? block.__resolveType : "";
  }
  return false;
}

/**
 * Where "Add section" drops a new section when no position was picked: right
 * before the footer(s) closing the page, so it doesn't land below the footer.
 * A page that doesn't end in a footer gets it appended, as before.
 */
export function defaultSectionInsertIndex(
  rawSections: RawSection[],
  decofile: Record<string, unknown>,
): number {
  let index = rawSections.length;
  while (index > 0) {
    const previous = rawSections[index - 1];
    if (!previous || !isFooterSection(previous, decofile)) break;
    index--;
  }
  return index;
}
