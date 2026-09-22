/**
 * Import externally-authored content (HTML or Markdown) into a blog post,
 * deterministically and WITHOUT any AI — so bringing a finished post in and
 * publishing it never spends credits. The parser is pure (no DOM, no deps) so it
 * runs the same in the browser and under `bun test`; it maps content onto the
 * site's own blog blocks, which already render in the brand's design system.
 *
 * Enrichment that does cost credits — product vitrines, internal-link
 * suggestions, a product-grounded cover image — is deliberately a separate,
 * opt-in step, never part of import.
 */
import { slugifyTitle, uniquePostSlug } from "./blog-data";

/**
 * A parsed content section, before it is bound to the site's concrete block
 * types. `kind` maps to a blog block component name in {@link sectionsToBlocks}.
 */
export type ImportedSection =
  | { kind: "heading"; text: string; level: string }
  | { kind: "paragraph"; html: string }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "quote"; text: string }
  | { kind: "divider" }
  | { kind: "image"; url: string; alt: string; caption: string };

export interface ParsedImport {
  /** The first H1 (HTML) or first `#` (Markdown), used as the post title. */
  title: string;
  sections: ImportedSection[];
}

const HTML_HINT =
  /<(h[1-6]|p|ul|ol|div|img|br|blockquote|section|article|figure)\b|<\/[a-z]/i;

/** Detect the input format; content the Bagaggio flow produces is HTML. */
export function looksLikeHtml(input: string): boolean {
  return HTML_HINT.test(input);
}

/** Parse pasted/uploaded content into a title + sections, format auto-detected. */
export function parseImportedContent(input: string): ParsedImport {
  const trimmed = input.trim();
  if (!trimmed) return { title: "", sections: [] };
  return looksLikeHtml(trimmed)
    ? htmlToSections(trimmed)
    : markdownToSections(trimmed);
}

// ------------------ HTML ------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
}

/** Strip tags to plain text — for headings, list items and quotes. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m?.[1] ? decodeEntities(m[1]) : "";
}

/**
 * A flat, block-level scan. The content this imports is well-structured
 * ("bem mastigadinho" — h1/h2/p/ul/img), so matching block elements in document
 * order is enough and stays dependency-free. Deeply nested same-tag structures
 * (a list inside a list) are the known limitation; they degrade, never crash.
 */
const BLOCK_RE =
  /<(h[1-6]|p|ul|ol|blockquote|figure)\b[^>]*>([\s\S]*?)<\/\1\s*>|<hr\b[^>]*\/?>|<img\b[^>]*>/gi;

function htmlToSections(html: string): ParsedImport {
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");

  let title = "";
  const sections: ImportedSection[] = [];

  for (const match of clean.matchAll(BLOCK_RE)) {
    const tag = match[1]?.toLowerCase();
    const inner = match[2] ?? "";
    const whole = match[0];

    if (!tag) {
      if (/^<img/i.test(whole)) {
        const url = attr(whole, "src");
        if (url) {
          sections.push({
            kind: "image",
            url,
            alt: attr(whole, "alt"),
            caption: "",
          });
        }
      } else {
        sections.push({ kind: "divider" });
      }
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      const text = stripTags(inner);
      if (!text) continue;
      if (tag === "h1" && !title) {
        title = text;
        continue;
      }
      sections.push({ kind: "heading", text, level: tag.slice(1) });
    } else if (tag === "p") {
      const html = inner.trim();
      if (stripTags(html)) sections.push({ kind: "paragraph", html });
    } else if (tag === "ul" || tag === "ol") {
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)]
        .map((li) => stripTags(li[1] ?? ""))
        .filter(Boolean);
      if (items.length) {
        sections.push({ kind: "list", items, ordered: tag === "ol" });
      }
    } else if (tag === "blockquote") {
      const text = stripTags(inner);
      if (text) sections.push({ kind: "quote", text });
    } else if (tag === "figure") {
      const imgTag = inner.match(/<img\b[^>]*>/i)?.[0];
      const url = imgTag ? attr(imgTag, "src") : "";
      const caption = stripTags(
        inner.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/i)?.[1] ??
          "",
      );
      if (url) {
        sections.push({
          kind: "image",
          url,
          alt: imgTag ? attr(imgTag, "alt") : "",
          caption,
        });
      }
    }
  }

  return { title, sections };
}

// ------------------ Markdown --------------------------------------------------

/** Minimal inline Markdown → HTML for paragraph bodies (links, bold, italic, code). */
function inlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function markdownToSections(md: string): ParsedImport {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  const sections: ImportedSection[] = [];

  let para: string[] = [];
  let list: { items: string[]; ordered: boolean } | null = null;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) {
      sections.push({
        kind: "paragraph",
        html: inlineMarkdown(para.join(" ")),
      });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      sections.push({ kind: "list", items: list.items, ordered: list.ordered });
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      sections.push({ kind: "quote", text: quote.join(" ") });
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    const listItem = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    const ordered = /^\s*\d+\./.test(line);
    const quoteLine = line.match(/^>\s?(.*)$/);

    if (!line.trim()) {
      flushAll();
    } else if (heading) {
      flushAll();
      const text = heading[2]?.trim() ?? "";
      const level = String(heading[1]?.length ?? 1);
      if (level === "1" && !title) title = text;
      else if (text) sections.push({ kind: "heading", text, level });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      sections.push({ kind: "divider" });
    } else if (image) {
      flushAll();
      sections.push({
        kind: "image",
        url: image[2] ?? "",
        alt: image[1] ?? "",
        caption: "",
      });
    } else if (listItem) {
      flushPara();
      flushQuote();
      if (!list) list = { items: [], ordered };
      list.items.push(listItem[1]?.trim() ?? "");
    } else if (quoteLine) {
      flushPara();
      flushList();
      quote.push(quoteLine[1]?.trim() ?? "");
    } else {
      flushList();
      flushQuote();
      para.push(line.trim());
    }
  }
  flushAll();

  return { title, sections };
}

// ------------------ Binding to the site's blocks ------------------------------

const COMPONENT_FOR_KIND: Record<ImportedSection["kind"], string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  list: "List",
  quote: "Quote",
  divider: "Divider",
  image: "BlockImage",
};

/**
 * Bind parsed sections to concrete decofile blocks using the site's
 * component→resolveType map (see `sectionResolveTypes`). A kind the site does
 * not expose is dropped — better a shorter post than a block that renders empty,
 * matching how generated drafts are built.
 */
export function sectionsToBlocks(
  sections: ImportedSection[],
  resolveTypes: Record<string, string>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const section of sections) {
    const __resolveType = resolveTypes[COMPONENT_FOR_KIND[section.kind]];
    if (!__resolveType) continue;
    switch (section.kind) {
      case "heading":
        blocks.push({
          __resolveType,
          text: section.text,
          level: section.level,
        });
        break;
      case "paragraph":
        blocks.push({ __resolveType, html: section.html });
        break;
      case "list":
        blocks.push({
          __resolveType,
          items: section.items.join("\n"),
          style: section.ordered ? "ordered" : "unordered",
        });
        break;
      case "quote":
        blocks.push({ __resolveType, quote: section.text });
        break;
      case "divider":
        blocks.push({ __resolveType });
        break;
      case "image":
        blocks.push({
          __resolveType,
          url: section.url,
          alt: section.alt,
          caption: section.caption,
          size: "normal",
        });
        break;
    }
  }
  return blocks;
}

/**
 * The post payload for imported content: lands in `in_review` (ready for a human
 * pass, never auto-published), carrying the parsed body. No `status`-crossing
 * and no AI — the caller writes it as a planning block and the reviewer publishes.
 */
export function buildImportedPostPayload({
  title,
  blocks,
  takenSlugs,
  now,
}: {
  title: string;
  blocks: Array<Record<string, unknown>>;
  takenSlugs: string[];
  now: Date;
}): Record<string, unknown> {
  const safeTitle = title.trim();
  return {
    title: safeTitle,
    slug: safeTitle ? uniquePostSlug(safeTitle, takenSlugs) : slugifyTitle(""),
    date: now.toISOString().slice(0, 10),
    excerpt: "",
    image: "",
    alt: "",
    authors: [],
    categories: [],
    sections: blocks,
    status: "in_review",
  };
}
