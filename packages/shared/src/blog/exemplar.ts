/**
 * The brand's own posts, as a writer reads them for an example of one.
 *
 * A writer imitates what it reads, so an example teaches more than any rule
 * about density and structure. It reads like the page — headings by level,
 * text without markup, one line per block — rather than as stored JSON: a
 * stored post may hold prop values its blocks ignore, and copying those is
 * exactly what an example must not teach.
 */
import { blockComponentName } from "./block-discovery";
import { asRecord, str, toArray } from "./fields";
import { productSlotOf, referencePosts } from "./generation";
import { readProductListIds } from "./product-loader";

/** About a long post's worth: enough to show its rhythm, not a second brief. */
export const MAX_EXEMPLAR_CHARS = 6_000;

/** How many examples one brief carries. */
export const MAX_EXEMPLARS = 2;

/** A block's longest line; a paragraph past it has shown what it shows. */
const MAX_LINE_CHARS = 700;

/** The props a block's reader sees, in the order they read. */
const TEXT_PROPS = [
  "title",
  "text",
  "html",
  "body",
  "quote",
  "items",
  "steps",
  "stats",
  "cards",
  "left",
  "right",
  "headers",
  "rows",
  "caption",
  "alt",
  "label",
  "value",
  "description",
  "attribution",
] as const;

export interface Exemplar {
  title: string;
  slug: string;
  /** The post's blocks, one line each. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&(?:amp|lt|gt|quot|#39|nbsp);/g,
      (entity) => ENTITIES[entity] ?? entity,
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** A prop's readable text. Several blocks keep their rows as JSON inside a string. */
function textOf(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("; ");
  const record = asRecord(value);
  if (record) {
    return Object.values(record).map(textOf).filter(Boolean).join(" — ");
  }
  const raw = str(value).trim();
  if (/^[[{]/.test(raw)) {
    try {
      return textOf(JSON.parse(raw));
    } catch {
      // Not JSON after all: read it as text.
    }
  }
  return plainText(raw);
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS).trimEnd()}…`
    : line;
}

function itemLines(value: unknown): string {
  const items = Array.isArray(value) ? value : str(value).split("\n");
  return items
    .map((item) => textOf(item))
    .filter(Boolean)
    .map((item) => `- ${clip(item)}`)
    .join("\n");
}

/** One block as a line of the page. */
function blockLine(section: Record<string, unknown>): string | null {
  const name = blockComponentName(str(section.__resolveType));
  if (/heading/i.test(name)) {
    const text = textOf(section.text);
    if (!text) return null;
    const depth = Number(String(section.level ?? "").replace(/\D/g, "")) || 2;
    return `${"#".repeat(Math.min(Math.max(depth, 2), 4))} ${clip(text)}`;
  }
  const slot = productSlotOf(section);
  if (slot) {
    const count = readProductListIds(section[slot]).filter(Boolean).length;
    const title = textOf(section.title);
    return `[${name}${title ? `: ${title}` : ""} — ${count} product(s)]`;
  }
  if (typeof section.items === "string" || Array.isArray(section.items)) {
    const list = itemLines(section.items);
    return list ? (name === "List" ? list : `[${name}]\n${list}`) : null;
  }
  const text = TEXT_PROPS.map((prop) => textOf(section[prop]))
    .filter(Boolean)
    .join(" — ");
  if (/paragraph/i.test(name)) return text ? clip(text) : null;
  return `[${name}]${text ? ` ${clip(text)}` : ""}`;
}

/** A post's blocks, one line each, cut at a line once it has shown enough. */
export function exemplarText(
  post: Record<string, unknown>,
  maxChars = MAX_EXEMPLAR_CHARS,
): string {
  const lines: string[] = [];
  let used = 0;
  for (const raw of toArray(post.sections)) {
    const section = asRecord(raw);
    const line = section ? blockLine(section) : null;
    if (!line) continue;
    if (used + line.length > maxChars) {
      lines.push("…");
      break;
    }
    lines.push(line);
    used += line.length + 2;
  }
  return lines.join("\n\n");
}

/**
 * The posts a format holds up as its examples, by slug, in its order; with
 * none of them on the site, the newest post the brand published itself.
 */
export function brandExemplars(
  decofile: Record<string, unknown>,
  preferSlugs: readonly string[],
): Exemplar[] {
  const posts = referencePosts(decofile, preferSlugs).filter(
    (post) => toArray(post.sections).length > 0,
  );
  const cited = posts.filter((post) => preferSlugs.includes(str(post.slug)));
  return (cited.length > 0 ? cited : posts.slice(0, 1))
    .slice(0, MAX_EXEMPLARS)
    .map((post) => ({
      title: str(post.title),
      slug: str(post.slug),
      text: exemplarText(post),
    }))
    .filter((exemplar) => exemplar.text);
}
