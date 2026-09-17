/**
 * Pure helpers for the "suggest internal links" enrichment: read a post's body
 * as plain text for the model, and apply an accepted link back onto the post's
 * paragraph blocks. Applying is a verbatim, single-occurrence wrap — the model's
 * quote must appear as-is, and never inside an existing link — so an accepted
 * suggestion either lands exactly or is skipped, never mangles the html.
 */
import { blockComponentName } from "./blog-data";

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Rough tag/entity strip — enough to give the model readable prose. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** The post body as plain text, one line per content block. */
export function postBodyText(blocks: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (blockComponentName(str(block.__resolveType))) {
      case "Paragraph":
        lines.push(stripTags(str(block.html)));
        break;
      case "Heading":
        lines.push(str(block.text));
        break;
      case "Quote":
        lines.push(str(block.quote));
        break;
      case "List":
        lines.push(str(block.items));
        break;
    }
  }
  return lines.filter(Boolean).join("\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * True when the character at `index` sits inside an `<a>…</a>` — the nearest
 * anchor tag before it is an opening one. Keeps a suggestion from linking text
 * that is already a link.
 */
function insideAnchor(html: string, index: number): boolean {
  const before = html.slice(0, index);
  return before.lastIndexOf("<a") > before.lastIndexOf("</a");
}

/**
 * Wrap the first verbatim, not-yet-linked occurrence of `quote` in a paragraph
 * with a link to `href`. Returns the same array (identity) when the quote isn't
 * found anywhere, so callers can tell an applied link from a skipped one.
 */
export function applyLinkToBlocks(
  blocks: Array<Record<string, unknown>>,
  quote: string,
  href: string,
): { blocks: Array<Record<string, unknown>>; applied: boolean } {
  if (!quote || !href) return { blocks, applied: false };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block.html !== "string") continue;
    const html = block.html;
    let from = 0;
    let idx = html.indexOf(quote, from);
    while (idx >= 0) {
      if (!insideAnchor(html, idx)) {
        const anchor = `<a href="${escapeAttr(href)}">${quote}</a>`;
        const nextHtml =
          html.slice(0, idx) + anchor + html.slice(idx + quote.length);
        const next = blocks.slice();
        next[i] = { ...block, html: nextHtml };
        return { blocks: next, applied: true };
      }
      from = idx + quote.length;
      idx = html.indexOf(quote, from);
    }
  }
  return { blocks, applied: false };
}

/** Apply a batch of accepted links in order; reports how many landed. */
export function applyLinksToBlocks(
  blocks: Array<Record<string, unknown>>,
  links: Array<{ quote: string; href: string }>,
): { blocks: Array<Record<string, unknown>>; applied: number } {
  let current = blocks;
  let applied = 0;
  for (const link of links) {
    const result = applyLinkToBlocks(current, link.quote, link.href);
    if (result.applied) {
      current = result.blocks;
      applied++;
    }
  }
  return { blocks: current, applied };
}
