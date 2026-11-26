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
  | { kind: "image"; url: string; alt: string; caption: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | {
      kind: "callout";
      title: string;
      body: string;
      /** Its other class names. The one the site's block accepts is its variant. */
      variants: string[];
    };

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
  return looksLikeHtml(trimmed) && !isMarkdownWithInlineHtml(trimmed)
    ? htmlToSections(trimmed)
    : markdownToSections(trimmed);
}

const BLOCK_HTML =
  /<(?:h[1-6]|p|ul|ol|div|img|hr|blockquote|section|article|figure|table)\b/i;

/**
 * Markdown whose only HTML is inline, like a `<br>` inside a pipe table's cell.
 * The HTML parser reads blocks from tags alone and would find none in it.
 */
function isMarkdownWithInlineHtml(input: string): boolean {
  if (BLOCK_HTML.test(input)) return false;
  const lines = input.split(/\r\n?|\n/);
  return lines.some(
    (line, index) =>
      line.includes("|") &&
      isTableDelimiter(lines[index + 1] ?? "", splitTableRow(line).length),
  );
}

// ------------------ HTML ------------------------------------------------------

/**
 * `&amp;` is decoded LAST on purpose. Decoding it first turns `&amp;lt;` into
 * `&lt;`, which the next pass turns into `<` — handing back the very character
 * the author's escaping denied.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/**
 * Strip tags to plain text — for headings, list items and quotes.
 *
 * Each of these strips repeats until the text stops changing, because a single
 * pass is not a sanitizer: removing the inner match of `<scr<x>ipt>` leaves
 * `<script>` behind. The loops are written out rather than factored into a
 * helper so that both a reader and a scanner can see the iteration.
 */
function stripTags(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== previous);
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/** Every HTML comment, repeating until none reappear: cutting the inner match
 *  of `<!--<!-- -->` would otherwise leave a `<!--` behind. */
function stripComments(html: string): string {
  let out = html;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/<!--[\s\S]*?-->/g, "");
  } while (out !== previous);
  return out;
}

/** The same, for script and style bodies. */
function stripScriptAndStyle(html: string): string {
  let out = html;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  } while (out !== previous);
  return out;
}

/** Both, together: cutting a script body can complete a comment that was not
 *  one before, so the pair repeats until neither finds anything left. */
function stripHostileMarkup(html: string): string {
  let out = html;
  let previous: string;
  do {
    previous = out;
    out = stripScriptAndStyle(stripComments(out));
  } while (out !== previous);
  return out;
}

/** Inline tags a paragraph may keep. Anything else loses its markup. */
const ALLOWED_INLINE = /^(a|b|strong|i|em|u|s|code|br|span|sub|sup)$/;

/**
 * A URL safe to put in an `href`/`src`. Relative URLs carry no scheme and are
 * fine; an absolute one has to name a scheme that cannot execute, which rules
 * out `javascript:` and `data:`.
 */
function isSafeUrl(url: string): boolean {
  // A browser drops control characters before resolving a URL, so `java<TAB>script:`
  // navigates. Drop them the same way, then judge the scheme on what is left.
  let bare = "";
  for (const char of url) if (char.charCodeAt(0) > 0x1f) bare += char;
  bare = bare.trim();
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(bare) || /^(https?|mailto|tel):/i.test(bare)
  );
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** One complete tag, anchored: `<name attrs>` or `</name>`. */
const TAG_AT_START = /^<\/?([a-z][a-z0-9]*)\b([^>]*)>/i;

/** Rewrite one matched tag into the only forms a paragraph may contain. */
function renderInlineTag(whole: string, rawName: string, rawAttrs: string) {
  const name = rawName.toLowerCase();
  if (!ALLOWED_INLINE.test(name)) return "";
  if (whole.startsWith("</")) return `</${name}>`;
  if (name !== "a") return `<${name}>`;
  const href = decodeEntities(
    rawAttrs.match(/href\s*=\s*"([^"]*)"/i)?.[1] ?? "",
  );
  return isSafeUrl(href) && href ? `<a href="${escapeAttr(href)}">` : "<a>";
}

/**
 * Imported HTML is untrusted and the site renders a paragraph's `html` as HTML,
 * so a paragraph keeps only inline formatting: every other tag loses its markup
 * and every attribute is dropped but a vetted `href`. Without this an imported
 * `<img onerror>` would be stored XSS on the customer's published blog.
 *
 * Tokenized left to right rather than pattern-replaced, because a replace only
 * sees COMPLETE tags: `<img onerror=...` with no `>` matched nothing and passed
 * through untouched, and the browser would close it with the next `>` on the
 * page. Here every `<` either opens a complete allowed tag or becomes text.
 * Consuming forward also makes reassembly impossible, so no repeat pass.
 */
function sanitizeInlineHtml(html: string): string {
  const source = stripHostileMarkup(html);
  let out = "";
  let index = 0;
  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next === -1) {
      out += source.slice(index);
      break;
    }
    out += source.slice(index, next);
    const tag = TAG_AT_START.exec(source.slice(next));
    if (!tag) {
      out += "&lt;";
      index = next + 1;
      continue;
    }
    out += renderInlineTag(tag[0], tag[1] ?? "", tag[2] ?? "");
    index = next + tag[0].length;
  }
  return out;
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m?.[1] ? decodeEntities(m[1]) : "";
}

/**
 * A flat, block-level scan. The content this imports is well-structured
 * ("bem mastigadinho" — h1/h2/p/ul/img), so matching block elements in document
 * order is enough and stays dependency-free. Deeply nested same-tag structures
 * (a list inside a list, a table inside a table) are the known limitation; they
 * degrade, never crash. A div is matched only to find a callout.
 */
const BLOCK_RE =
  /<(h[1-6]|p|ul|ol|blockquote|figure|table)\b[^>]*>([\s\S]*?)<\/\1\s*>|<hr\b[^>]*\/?>|<img\b[^>]*>|<div\b[^>]*>/gi;

/** Where one block ends inside a prop that can only hold inline HTML. */
const BLOCK_END = /<\/(?:p|li|div|h[1-6])\s*>|<br\b[^>]*>/gi;

/** Sanitized inline HTML for a table cell or a callout body, its blocks kept apart by `<br>`. */
function inlineHtml(inner: string): string {
  const html = sanitizeInlineHtml(inner.replace(BLOCK_END, "<br>"))
    .replace(/\s+/g, " ")
    .replace(/(?:<br> ?)+/g, "<br>")
    .replace(/^(?:<br>| )+|(?:<br>| )+$/g, "");
  return stripTags(html) ? html : "";
}

/** Every row as wide as the widest, so a short one cannot shift its columns. */
function tableSection(headers: string[], rows: string[][]): ImportedSection {
  const head = headers.some(Boolean) ? headers : [];
  const width = rows.reduce(
    (max, row) => Math.max(max, row.length),
    head.length,
  );
  const pad = (cells: string[]) => [
    ...cells,
    ...Array<string>(width - cells.length).fill(""),
  ];
  return {
    kind: "table",
    headers: head.length > 0 ? pad(head) : [],
    rows: rows.map(pad),
  };
}

// Rows and cells end at their close tag or where the next one opens: HTML lets
// `</tr>`, `</td>` and `</th>` be left out.
const TABLE_HEAD_RE =
  /<thead\b[^>]*>[\s\S]*?(?=<\/thead\s*>|<tbody\b|<tfoot\b|$)/i;
const TABLE_ROW_RE =
  /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tr\s*>|<\/t(?:head|body|foot)\s*>|$)/gi;
const TABLE_CELL_RE = /<(th|td)\b[^>]*>([\s\S]*?)(?=<t[hd]\b|<\/t[hd]\s*>|$)/gi;

/**
 * A table's header and body rows. The header is the first row of `<thead>`, or
 * a first row made only of `<th>`; a table with neither has none. Matching the
 * whole table as one block also keeps a cell's paragraphs and lists from
 * landing in the post as loose blocks. Merged cells are not expanded.
 */
function tableToSection(inner: string): ImportedSection | null {
  const thead = TABLE_HEAD_RE.exec(inner);
  const headStart = thead?.index ?? -1;
  const headEnd = thead ? headStart + thead[0].length : -1;

  let headers: string[] | null = null;
  const rows: string[][] = [];
  for (const row of inner.matchAll(TABLE_ROW_RE)) {
    const cells = [...(row[1] ?? "").matchAll(TABLE_CELL_RE)];
    if (cells.length === 0) continue;
    const values = cells.map((cell) => inlineHtml(cell[2] ?? ""));
    const inHead = row.index >= headStart && row.index < headEnd;
    const allHeaderCells = cells.every((c) => c[1]?.toLowerCase() === "th");
    const isHeader =
      headers === null && (inHead || (rows.length === 0 && allHeaderCells));
    if (isHeader) headers = values;
    else if (values.some(Boolean)) rows.push(values);
  }

  const table = tableSection(headers ?? [], rows);
  return table.kind === "table" &&
    (table.headers.length > 0 || table.rows.length > 0)
    ? table
    : null;
}

/**
 * The `</div>` closing the div whose opening tag ends at `from`, or null when
 * it never closes. Divs nest, so the first `</div>` after it may be an inner
 * one's.
 */
function closingDiv(
  html: string,
  from: number,
): { start: number; end: number } | null {
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = from;
  let depth = 1;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return { start: tag.index, end: tags.lastIndex };
  }
  return null;
}

/** A tag that starts or ends a line of a callout, kept beside the text it bounds. */
const CALLOUT_LINE_TAG = /(<\/?(?:p|div|li|ul|ol|h[1-6])\b[^>]*>|<br\b[^>]*>)/i;

/** A leading bold, and what follows it on the same line. */
const LEADING_BOLD = /^\s*<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>([\s\S]*)$/i;

/** `title`, `callout-title`, `callout__title`: a class that marks the title. */
const TITLE_CLASS = /(?:^|[-_])title$/i;

function opensTitle(tag: string): boolean {
  return (
    /^<h[1-6]\b/i.test(tag) ||
    (!tag.startsWith("</") &&
      attr(tag, "class")
        .split(/\s+/)
        .some((name) => TITLE_CLASS.test(name)))
  );
}

/**
 * A `<div class="callout">` as the Callout block stores it: a plain title, and
 * a body of inline HTML the site renders as HTML.
 *
 * The title is the callout's first line when a heading or a `…-title` element
 * holds it, when it is bold and nothing else, or when it opens with a bold
 * label ending in a colon. A callout of one line has no title: that line is its
 * body. An image or a table inside a callout is not carried over, because the
 * block has nowhere to put it.
 */
function calloutToSection(
  classes: string[],
  inner: string,
): ImportedSection | null {
  const parts = inner.split(CALLOUT_LINE_TAG);
  const lines: Array<{ html: string; titled: boolean }> = [];
  for (let index = 0; index < parts.length; index += 2) {
    const html = parts[index] ?? "";
    if (stripTags(html)) {
      lines.push({ html, titled: opensTitle(parts[index - 1] ?? "") });
    }
  }

  let title = "";
  let body = lines.map((line) => line.html);
  const first = lines[0];
  if (first && lines.length > 1 && first.titled) {
    title = stripTags(first.html);
    body = body.slice(1);
  } else if (first) {
    const bold = LEADING_BOLD.exec(first.html);
    const label = stripTags(bold?.[2] ?? "");
    const rest = bold?.[3] ?? "";
    if (label && !stripTags(rest) && lines.length > 1) {
      title = label.replace(/\s*:$/, "");
      body = body.slice(1);
    } else if (label.endsWith(":") && stripTags(rest)) {
      title = label.replace(/\s*:$/, "");
      body = [rest, ...body.slice(1)];
    }
  }

  const html = inlineHtml(body.join("<br>"));
  if (!html) return null;
  return {
    kind: "callout",
    title,
    body: html,
    variants: classes
      .filter((name) => name !== "callout")
      .map((name) => name.replace(/^callout[-_]+/, "")),
  };
}

function htmlToSections(html: string): ParsedImport {
  const clean = stripHostileMarkup(html);

  let title = "";
  const sections: ImportedSection[] = [];

  const blocks = new RegExp(BLOCK_RE.source, BLOCK_RE.flags);
  for (let match = blocks.exec(clean); match; match = blocks.exec(clean)) {
    const tag = match[1]?.toLowerCase();
    const inner = match[2] ?? "";
    const whole = match[0];

    if (!tag) {
      if (/^<img/i.test(whole)) {
        const url = attr(whole, "src");
        if (url && isSafeUrl(url)) {
          sections.push({
            kind: "image",
            url,
            alt: attr(whole, "alt"),
            caption: "",
          });
        }
      } else if (/^<div/i.test(whole)) {
        const classes = attr(whole, "class")
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        // An unclosed callout stays a wrapper, or it would swallow the rest of the post.
        const close = classes.includes("callout")
          ? closingDiv(clean, blocks.lastIndex)
          : null;
        if (close) {
          const callout = calloutToSection(
            classes,
            clean.slice(blocks.lastIndex, close.start),
          );
          if (callout) sections.push(callout);
          blocks.lastIndex = close.end;
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
      const html = sanitizeInlineHtml(inner.trim());
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
    } else if (tag === "table") {
      const table = tableToSection(inner);
      if (table) sections.push(table);
    } else if (tag === "figure") {
      // A table some editors wrap in a figure. A cell can hold a figure of
      // its own, which is where the lazy match above would have stopped, so
      // the table is read from the document and the scan resumes after it.
      const tableAt = inner.search(/<table\b/i);
      if (tableAt >= 0) {
        const wrapped = /<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi;
        wrapped.lastIndex = match.index + whole.indexOf(">") + 1 + tableAt;
        const found = wrapped.exec(clean);
        if (found) {
          const table = tableToSection(found[1] ?? "");
          if (table) sections.push(table);
          blocks.lastIndex = wrapped.lastIndex;
          continue;
        }
      }
      const imgTag = inner.match(/<img\b[^>]*>/i)?.[0];
      const url = imgTag ? attr(imgTag, "src") : "";
      const caption = stripTags(
        inner.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/i)?.[1] ??
          "",
      );
      if (url && isSafeUrl(url)) {
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

/** A pipe table row's cells, without the optional outer pipes. */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** The `|---|:--:|` row that makes the line above it a table header. */
function isTableDelimiter(line: string, columns: number): boolean {
  if (!line.includes("-") || !line.includes("|")) return false;
  const cells = splitTableRow(line);
  return (
    cells.length === columns && cells.every((cell) => /^:?-+:?$/.test(cell))
  );
}

/** A line that starts another block, ending a table that has no blank line after it. */
const STARTS_MARKDOWN_BLOCK = /^(?:#{1,6}\s|>|\s*(?:[-*+]|\d+\.)\s)/;

function markdownCell(cell: string): string {
  return sanitizeInlineHtml(inlineMarkdown(cell));
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
        html: sanitizeInlineHtml(inlineMarkdown(para.join(" "))),
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

  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? "").trimEnd();

    if (line.includes("|")) {
      const header = splitTableRow(line);
      if (isTableDelimiter(lines[index + 1] ?? "", header.length)) {
        flushAll();
        const rows: string[][] = [];
        index += 2;
        for (; index < lines.length; index++) {
          const row = lines[index] ?? "";
          if (!row.trim() || !row.includes("|")) break;
          if (
            !row.trimStart().startsWith("|") &&
            STARTS_MARKDOWN_BLOCK.test(row)
          )
            break;
          // Cells past the last column have no header to sit under.
          rows.push(
            splitTableRow(row).slice(0, header.length).map(markdownCell),
          );
        }
        index--;
        sections.push(tableSection(header.map(markdownCell), rows));
        continue;
      }
    }

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
      const url = image[2] ?? "";
      if (isSafeUrl(url)) {
        sections.push({ kind: "image", url, alt: image[1] ?? "", caption: "" });
      }
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
  table: "Table",
  callout: "Callout",
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
  /** The variants the site's Callout declares: one it does not know can break its render. */
  calloutVariants: readonly string[] = [],
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
      case "table":
        blocks.push({
          __resolveType,
          headers: JSON.stringify(section.headers),
          rows: JSON.stringify(section.rows),
        });
        break;
      case "callout": {
        const variant = section.variants
          .map((name) =>
            calloutVariants.find((known) => known.toLowerCase() === name),
          )
          .find((known) => known !== undefined);
        blocks.push({
          __resolveType,
          title: section.title,
          body: section.body,
          ...(variant ? { variant } : {}),
        });
        break;
      }
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
  body,
  takenSlugs,
  now,
}: {
  title: string;
  /** `{ sections }` of blocks, or `{ content }` HTML on the legacy format. */
  body: { sections: Array<Record<string, unknown>> } | { content: string };
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
    ...body,
    status: "in_review",
  };
}
