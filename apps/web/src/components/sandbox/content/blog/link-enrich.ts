/**
 * Pure helpers for the "suggest internal links" enrichment: read a post's body
 * as plain text for the model, and apply an accepted link back onto the post's
 * paragraph blocks.
 *
 * The model quotes from the PLAIN TEXT (tags stripped, entities decoded,
 * whitespace collapsed), so applying can't just `indexOf` the raw html — a
 * `&nbsp;` or a `<strong>` in the middle would never match. Instead we normalize
 * the html the same way while keeping, for each text character, where it sits in
 * the html, then wrap the matched html span. A quote whose span crosses an inline
 * tag is skipped rather than wrapped, so we never produce unbalanced markup.
 */
import { blockComponentName } from "./blog-data";

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

/** A text character plus the html offsets it came from (for mapping back). */
interface MappedChar {
  ch: string;
  start: number;
  end: number;
}

/**
 * Normalize html to text the same way the body sent to the model is normalized
 * (skip tags, decode known entities, collapse whitespace), keeping each text
 * char's html span so a match can be located back in the html.
 */
function htmlToTextMap(html: string): { text: string; chars: MappedChar[] } {
  const chars: MappedChar[] = [];
  let i = 0;
  let lastWasSpace = false;
  while (i < html.length) {
    if (html[i] === "<") {
      const gt = html.indexOf(">", i);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    let decoded = html[i] ?? "";
    let end = i + 1;
    if (html[i] === "&") {
      const semi = html.indexOf(";", i);
      if (semi >= 0 && semi - i <= 10) {
        const entity = ENTITIES[html.slice(i, semi + 1).toLowerCase()];
        if (entity !== undefined) {
          decoded = entity;
          end = semi + 1;
        }
      }
    }
    const start = i;
    i = end;
    if (/\s/.test(decoded)) {
      if (lastWasSpace) {
        const prev = chars[chars.length - 1];
        if (prev) prev.end = end;
        continue;
      }
      chars.push({ ch: " ", start, end });
      lastWasSpace = true;
    } else {
      chars.push({ ch: decoded, start, end });
      lastWasSpace = false;
    }
  }
  return { text: chars.map((c) => c.ch).join(""), chars };
}

/** The plain text of a single html value — the model reads this. */
function htmlText(html: string): string {
  return htmlToTextMap(html).text.trim();
}

/** The post body as plain text, one line per content block. */
export function postBodyText(blocks: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (blockComponentName(str(block.__resolveType))) {
      case "Paragraph":
        lines.push(htmlText(str(block.html)));
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

/** True when the html offset sits inside an `<a>…</a>` — already a link. */
function insideAnchor(html: string, index: number): boolean {
  const before = html.slice(0, index);
  return before.lastIndexOf("<a") > before.lastIndexOf("</a");
}

/**
 * Wrap the first verbatim, not-yet-linked occurrence of `quote` in a paragraph
 * with a link to `href`. Matches on normalized text, wraps the mapped html span,
 * and skips a span that crosses an inline tag. Returns the same array (identity)
 * when nothing was linked, so callers can tell applied from skipped.
 */
export function applyLinkToBlocks(
  blocks: Array<Record<string, unknown>>,
  quote: string,
  href: string,
): { blocks: Array<Record<string, unknown>>; applied: boolean } {
  const needle = quote.trim();
  if (!needle || !href) return { blocks, applied: false };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block.html !== "string") continue;
    const html = block.html;
    const { text, chars } = htmlToTextMap(html);
    let at = text.indexOf(needle);
    while (at >= 0) {
      const first = chars[at];
      const last = chars[at + needle.length - 1];
      if (first && last) {
        const hStart = first.start;
        const hEnd = last.end;
        const span = html.slice(hStart, hEnd);
        if (!span.includes("<") && !insideAnchor(html, hStart)) {
          const nextHtml =
            html.slice(0, hStart) +
            `<a href="${escapeAttr(href)}">${span}</a>` +
            html.slice(hEnd);
          const next = blocks.slice();
          next[i] = { ...block, html: nextHtml };
          return { blocks: next, applied: true };
        }
      }
      at = text.indexOf(needle, at + 1);
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
