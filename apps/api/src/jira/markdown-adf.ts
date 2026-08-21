/**
 * Board markdown → Atlassian Document Format, for the comments the sync
 * mirrors onto a Jira issue.
 *
 * Jira Cloud's v3 comment API takes ADF — not markdown, not the wiki markup of
 * the v2 API — so a comment posted as plain text shows the customer its own
 * syntax: literal `**bold**`, literal fences, `-` bullets that never become a
 * list. This is the inverse of `wiki-markdown.ts` and has the same shape: a
 * line-driven block parser, then a character scanner for inline marks with
 * recursion so nesting works.
 *
 * Two invariants keep a malformed comment from turning into a 400, which the
 * push treats as terminal (see `JiraClient.addComment`):
 *   - never emit an empty `text` node (ADF rejects one), and
 *   - only place a node where ADF's schema allows it — `listItem` and
 *     `blockquote` take a narrow set, so anything else is flattened rather
 *     than nested.
 * Anything unrecognized degrades to its literal source text: a stray `*` on
 * the issue is better than a mangled sentence, and far better than a comment
 * Jira refuses.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

export interface MarkdownToAdfOptions {
  /**
   * A paragraph prepended verbatim, never parsed. The push uses it for the
   * `"<author> · via Studio:"` attribution line, which carries a
   * tenant-supplied display name — running that through the inline scanner
   * would let `Ana *Nick* Souza` open emphasis.
   */
  header?: string;
}

export function markdownToAdf(
  markdown: string,
  options: MarkdownToAdfOptions = {},
): AdfDoc {
  const content = parseBlocks({ lines: toLines(markdown), i: 0 });
  if (options.header) content.unshift(textParagraph(options.header));
  return {
    type: "doc",
    version: 1,
    // A doc needs at least one child; an all-whitespace comment yields none.
    content:
      content.length > 0 ? content : [{ type: "paragraph", content: [] }],
  };
}

/** Leading tabs only: indentation drives block structure so it has to be
 *  countable in spaces, while a tab inside prose is content. */
function toLines(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\t+/, (tabs) => " ".repeat(tabs.length * 4)));
}

function textParagraph(text: string): AdfNode {
  return {
    type: "paragraph",
    content: text === "" ? [] : [{ type: "text", text }],
  };
}

interface Cursor {
  lines: string[];
  i: number;
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)/;
const RULE_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const BULLET_RE = /^( *)([-*+])([ \t]+)(.*)$/;
const ORDERED_RE = /^( *)(\d{1,9})([.)])([ \t]+)(.*)$/;

function parseBlocks(cursor: Cursor): AdfNode[] {
  const blocks: AdfNode[] = [];
  while (cursor.i < cursor.lines.length) {
    const line = cursor.lines[cursor.i] ?? "";
    if (line.trim() === "") {
      cursor.i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      blocks.push(parseFence(cursor, fence));
      continue;
    }
    // Ahead of the list rules: `---` and `* * *` also look like list markers.
    if (RULE_RE.test(line)) {
      cursor.i++;
      blocks.push({ type: "rule" });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      cursor.i++;
      blocks.push({
        type: "heading",
        attrs: { level: (heading[1] ?? "#").length },
        content: inlineNodes(heading[2]?.trim() ?? ""),
      });
      continue;
    }
    if (QUOTE_RE.test(line)) {
      blocks.push(parseQuote(cursor));
      continue;
    }
    const item = matchListItem(line);
    if (item) {
      blocks.push(parseList(cursor, item));
      continue;
    }
    const table = parseTable(cursor);
    if (table) {
      blocks.push(table);
      continue;
    }
    blocks.push(parseParagraph(cursor));
  }
  return blocks;
}

/** True for a line that opens a different block — where a paragraph ends
 *  without a blank line before it. */
function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    RULE_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    matchListItem(line) !== null
  );
}

function indentOf(line: string): number {
  let count = 0;
  while (line[count] === " ") count++;
  return count;
}

/** An unterminated fence (a comment truncated mid-code-block) runs to the end
 *  of the input rather than falling back to prose. */
function parseFence(cursor: Cursor, open: RegExpExecArray): AdfNode {
  const marker = open[1] ?? "```";
  const language = sanitizeLanguage(open[2] ?? "");
  const baseIndent = indentOf(cursor.lines[cursor.i] ?? "");
  const closeRe = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \t]*$`);
  cursor.i++;
  const body: string[] = [];
  while (cursor.i < cursor.lines.length) {
    const line = cursor.lines[cursor.i] ?? "";
    cursor.i++;
    if (closeRe.test(line)) break;
    body.push(line.slice(Math.min(baseIndent, indentOf(line))));
  }
  const text = body.join("\n");
  return {
    type: "codeBlock",
    ...(language ? { attrs: { language } } : {}),
    content: text === "" ? [] : [{ type: "text", text }],
  };
}

/** An info string is free-form in markdown (`js {highlight=1}`) but names a
 *  highlighter in ADF: keep the identifier shape, drop the rest. */
function sanitizeLanguage(info: string): string {
  return info
    .toLowerCase()
    .replace(/[^a-z0-9+#._-]/g, "")
    .slice(0, 20);
}

function parseQuote(cursor: Cursor): AdfNode {
  const inner: string[] = [];
  while (cursor.i < cursor.lines.length) {
    const match = QUOTE_RE.exec(cursor.lines[cursor.i] ?? "");
    if (!match) break;
    inner.push(match[1] ?? "");
    cursor.i++;
  }
  return {
    type: "blockquote",
    content: restrict(parseBlocks({ lines: inner, i: 0 }), QUOTE_CONTENT),
  };
}

interface ListMarker {
  indent: number;
  /** Column the item's own content starts at — what nested blocks dedent by. */
  contentIndent: number;
  ordered: boolean;
  start: number;
  text: string;
}

function matchListItem(line: string): ListMarker | null {
  const bullet = BULLET_RE.exec(line);
  if (bullet) {
    const indent = (bullet[1] ?? "").length;
    return {
      indent,
      contentIndent: indent + 1 + Math.min((bullet[3] ?? " ").length, 4),
      ordered: false,
      start: 1,
      text: bullet[4] ?? "",
    };
  }
  const ordered = ORDERED_RE.exec(line);
  if (ordered) {
    const indent = (ordered[1] ?? "").length;
    const digits = ordered[2] ?? "1";
    return {
      indent,
      contentIndent:
        indent + digits.length + 1 + Math.min((ordered[4] ?? " ").length, 4),
      ordered: true,
      start: Number(digits),
      text: ordered[5] ?? "",
    };
  }
  return null;
}

/**
 * One list, sibling items at `first.indent`.
 *
 * Everything indented to the item's content column is collected, dedented and
 * re-parsed as blocks — so a nested list, a fenced block or a second paragraph
 * inside an item all fall out of the same rule instead of needing their own.
 */
function parseList(cursor: Cursor, first: ListMarker): AdfNode {
  const items: AdfNode[] = [];
  let marker: ListMarker | null = first;
  while (marker) {
    const itemLines = [marker.text];
    cursor.i++;
    let blanks = 0;
    while (cursor.i < cursor.lines.length) {
      const line = cursor.lines[cursor.i] ?? "";
      if (line.trim() === "") {
        blanks++;
        cursor.i++;
        continue;
      }
      if (indentOf(line) < marker.contentIndent) break;
      // Replayed only once content follows, so trailing blanks stay outside.
      for (let blank = 0; blank < blanks; blank++) itemLines.push("");
      blanks = 0;
      itemLines.push(line.slice(marker.contentIndent));
      cursor.i++;
    }
    items.push({
      type: "listItem",
      content: listItemContent(parseBlocks({ lines: itemLines, i: 0 })),
    });
    const next = matchListItem(cursor.lines[cursor.i] ?? "");
    // A dedent, or a switch between bullets and numbers, ends this list.
    marker =
      next && next.ordered === marker.ordered && next.indent >= first.indent
        ? next
        : null;
  }
  return first.ordered
    ? {
        type: "orderedList",
        ...(first.start !== 1 ? { attrs: { order: first.start } } : {}),
        content: items,
      }
    : { type: "bulletList", content: items };
}

const QUOTE_CONTENT = new Set([
  "paragraph",
  "bulletList",
  "orderedList",
  "codeBlock",
]);
const LIST_ITEM_CONTENT = QUOTE_CONTENT;

function listItemContent(blocks: AdfNode[]): AdfNode[] {
  const content = restrict(blocks, LIST_ITEM_CONTENT);
  const first = content[0]?.type;
  // ADF opens a listItem with a paragraph or codeBlock; `- - a` starts a list.
  if (first !== "paragraph" && first !== "codeBlock") {
    content.unshift({ type: "paragraph", content: [] });
  }
  return content;
}

/**
 * Keep only nodes ADF allows in this parent. A heading becomes a paragraph and
 * a nested blockquote is spread into its parent (ADF has no blockquote inside a
 * blockquote or a listItem); anything else keeps its text as one paragraph,
 * because losing a table's layout beats losing the sentence inside it.
 */
function restrict(blocks: AdfNode[], allowed: ReadonlySet<string>): AdfNode[] {
  const out: AdfNode[] = [];
  for (const block of blocks) {
    if (allowed.has(block.type)) {
      out.push(block);
      continue;
    }
    if (block.type === "heading") {
      out.push({ type: "paragraph", content: block.content ?? [] });
      continue;
    }
    if (block.type === "blockquote") {
      out.push(...restrict(block.content ?? [], allowed));
      continue;
    }
    if (block.type === "rule") continue;
    const flattened = flatten(block);
    if (flattened) out.push(flattened);
  }
  return out;
}

function flatten(block: AdfNode): AdfNode | null {
  const parts: string[] = [];
  const walk = (node: AdfNode) => {
    if (node.type === "text" && node.text) parts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(block);
  const text = parts.join(" ").trim();
  return text === "" ? null : textParagraph(text);
}

const TABLE_ROW_RE = /^ {0,3}\|/;
const DELIMITER_CELL_RE = /^:?-+:?$/;

/** A GFM table: a pipe row, a delimiter row of matching width, then rows. The
 *  leading pipe is required — `a | b` in prose is not a table. */
function parseTable(cursor: Cursor): AdfNode | null {
  const header = splitRow(cursor.lines[cursor.i] ?? "");
  if (!header) return null;
  const delimiter = splitRow(cursor.lines[cursor.i + 1] ?? "");
  if (
    !delimiter ||
    delimiter.length !== header.length ||
    !delimiter.every((cell) => DELIMITER_CELL_RE.test(cell))
  ) {
    return null;
  }
  cursor.i += 2;
  const rows: AdfNode[] = [tableRow(header, "tableHeader", header.length)];
  while (cursor.i < cursor.lines.length) {
    const cells = splitRow(cursor.lines[cursor.i] ?? "");
    if (!cells) break;
    rows.push(tableRow(cells, "tableCell", header.length));
    cursor.i++;
  }
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: rows,
  };
}

function splitRow(line: string): string[] | null {
  if (!TABLE_ROW_RE.test(line)) return null;
  const cells: string[] = [];
  const trimmed = line.trim();
  let cell = "";
  for (let i = 1; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell.trim() !== "") cells.push(cell.trim());
  return cells.length > 0 ? cells : null;
}

/** Rows are padded and truncated to the header's width: ADF accepts a ragged
 *  table, but Jira's own editor then treats it as broken. */
function tableRow(cells: string[], cellType: string, width: number): AdfNode {
  return {
    type: "tableRow",
    content: Array.from({ length: width }, (_unused, column) => ({
      type: cellType,
      attrs: {},
      content: [paragraph(inlineNodes(cells[column] ?? ""))],
    })),
  };
}

function paragraph(content: AdfNode[]): AdfNode {
  return { type: "paragraph", content };
}

function parseParagraph(cursor: Cursor): AdfNode {
  const lines: string[] = [];
  while (cursor.i < cursor.lines.length) {
    const line = cursor.lines[cursor.i] ?? "";
    if (line.trim() === "") break;
    if (lines.length > 0 && (startsBlock(line) || TABLE_ROW_RE.test(line))) {
      break;
    }
    lines.push(lines.length === 0 ? line : line.trimStart());
    cursor.i++;
  }
  return paragraph(inlineNodes(joinLines(lines)));
}

/**
 * Paragraph lines → one string, with `\n` marking the breaks that survive.
 *
 * A single newline is a soft break: it renders as a space, which is what the
 * board's own renderer (remark-gfm, no `remark-breaks`) does, so the issue
 * reads the way the card does. Only markdown's explicit hard breaks — two
 * trailing spaces, or a trailing backslash — become a `hardBreak`.
 */
function joinLines(lines: string[]): string {
  let out = "";
  lines.forEach((line, index) => {
    let text = line.replace(/[ \t]+$/, "");
    let hard = /[ \t]{2,}$/.test(line);
    if (!hard && /(?:^|[^\\])\\$/.test(text)) {
      hard = true;
      text = text.slice(0, -1);
    }
    out += text;
    if (index < lines.length - 1) out += hard ? "\n" : " ";
  });
  return out;
}

const ESCAPABLE = "\\`*_{}[]()#+-.!|<>~\"'&$%,/:;=?@^";
const STRONG: AdfMark = { type: "strong" };
const EM: AdfMark = { type: "em" };
const STRIKE: AdfMark = { type: "strike" };

/**
 * Character scanner over one paragraph's text. Marks accumulate down the
 * recursion (a link label can be bold), and an unmatched delimiter falls
 * through as the literal character it is.
 */
function inlineNodes(source: string, marks: AdfMark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") {
      out.push(textNode(buffer, marks));
      buffer = "";
    }
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? "";

    if (char === "\\") {
      const next = source[i + 1];
      if (next && ESCAPABLE.includes(next)) {
        buffer += next;
        i += 2;
        continue;
      }
    } else if (char === "\n") {
      flush();
      out.push({ type: "hardBreak" });
      i++;
      continue;
    } else if (char === "`") {
      const code = matchCode(source, i);
      if (code) {
        flush();
        if (code.text !== "") out.push(textNode(code.text, codeMarks(marks)));
        i = code.next;
        continue;
      }
    } else if (char === "!" && source[i + 1] === "[") {
      const image = matchLink(source, i + 1);
      if (image) {
        flush();
        out.push(...imageNodes(image, marks));
        i = image.next;
        continue;
      }
    } else if (char === "[") {
      const link = matchLink(source, i);
      if (link) {
        flush();
        out.push(...linkNodes(link, marks));
        i = link.next;
        continue;
      }
    } else if (char === "<") {
      const auto = matchAutolink(source, i);
      if (auto) {
        flush();
        out.push(...linkNodes(auto, marks));
        i = auto.next;
        continue;
      }
    } else if (char === "*" || char === "_" || char === "~") {
      const emphasized = matchEmphasis(source, i, marks);
      if (emphasized) {
        flush();
        out.push(...emphasized.nodes);
        i = emphasized.next;
        continue;
      }
    } else if (char === "h") {
      const bare = matchBareUrl(source, i, marks);
      if (bare) {
        flush();
        out.push(bare.node);
        i = bare.next;
        continue;
      }
    }

    buffer += char;
    i++;
  }
  flush();
  return mergeText(out);
}

/** Fold neighbouring text nodes that carry the same marks — valid either way,
 *  but a document Jira's editor round-trips without reshaping it. */
function mergeText(nodes: AdfNode[]): AdfNode[] {
  const merged: AdfNode[] = [];
  for (const node of nodes) {
    const previous = merged.at(-1);
    if (
      node.type === "text" &&
      previous?.type === "text" &&
      JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      previous.text = `${previous.text ?? ""}${node.text ?? ""}`;
      continue;
    }
    merged.push(node);
  }
  return merged;
}

function textNode(text: string, marks: AdfMark[]): AdfNode {
  return { type: "text", text, ...(marks.length > 0 ? { marks } : {}) };
}

/** ADF's `code` mark is exclusive with the other formatting marks; a link
 *  around inline code is the one combination it keeps. */
function codeMarks(marks: AdfMark[]): AdfMark[] {
  return [...marks.filter((mark) => mark.type === "link"), { type: "code" }];
}

function withMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  return marks.some((existing) => existing.type === mark.type)
    ? marks
    : [...marks, mark];
}

function hasLink(marks: AdfMark[]): boolean {
  return marks.some((mark) => mark.type === "link");
}

function runLength(source: string, at: number, char: string): number {
  let length = 0;
  while (source[at + length] === char) length++;
  return length;
}

/** A code span: N backticks to the next run of exactly N. Newlines collapse to
 *  spaces — a `hardBreak` cannot live inside a marked text node. */
function matchCode(
  source: string,
  at: number,
): { text: string; next: number } | null {
  const fence = runLength(source, at, "`");
  for (let j = at + fence; j < source.length; j++) {
    if (source[j] !== "`") continue;
    const run = runLength(source, j, "`");
    if (run !== fence) {
      j += run - 1;
      continue;
    }
    let text = source.slice(at + fence, j).replace(/\n/g, " ");
    if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ")) {
      text = text.slice(1, -1);
    }
    return { text, next: j + run };
  }
  return null;
}

interface LinkMatch {
  label: string;
  href: string;
  next: number;
}

/** `[label](href "title")`, honouring nesting and escapes so a label with
 *  brackets or a URL with parens survives. */
function matchLink(source: string, at: number): LinkMatch | null {
  const labelEnd = findClosing(source, at, "[", "]");
  if (labelEnd === -1 || source[labelEnd + 1] !== "(") return null;
  const hrefEnd = findClosing(source, labelEnd + 1, "(", ")");
  if (hrefEnd === -1) return null;
  const target = source.slice(labelEnd + 2, hrefEnd).trim();
  // A title is display-only in markdown and has nowhere to go in ADF.
  const titled = /^(\S+)\s+["'(].*["')]$/.exec(target);
  return {
    label: source.slice(at + 1, labelEnd),
    href: titled?.[1] ?? target,
    next: hrefEnd + 1,
  };
}

function findClosing(
  source: string,
  at: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let j = at; j < source.length; j++) {
    const char = source[j];
    if (char === "\\") {
      j++;
      continue;
    }
    if (char === open) depth++;
    else if (char === close && --depth === 0) return j;
  }
  return -1;
}

function matchAutolink(source: string, at: number): LinkMatch | null {
  const end = source.indexOf(">", at);
  if (end === -1) return null;
  const target = source.slice(at + 1, end);
  if (target === "" || /[\s<]/.test(target)) return null;
  return { label: target, href: target, next: end + 1 };
}

/** With no href we can trust — a Studio-relative path, a `javascript:` URL —
 *  the label stays plain text: ADF rejects a link mark without a real href. */
function linkNodes(link: LinkMatch, marks: AdfMark[]): AdfNode[] {
  const href = safeHref(link.href);
  const label = link.label.trim() === "" ? href : link.label;
  if (!label) return [];
  if (!href || hasLink(marks)) return inlineNodes(label, marks);
  return inlineNodes(label, withMark(marks, { type: "link", attrs: { href } }));
}

/**
 * An image degrades to its link, because ADF has no external image: `media`
 * addresses an attachment in the issue's own media collection, which a mirrored
 * board comment has no way to populate. An `org/output/…` screenshot (rewritten
 * to a Studio path by `embedOrgOutputImages`) has no absolute URL at all, so it
 * degrades further, to its alt text.
 */
function imageNodes(image: LinkMatch, marks: AdfMark[]): AdfNode[] {
  return linkNodes(image, marks);
}

function safeHref(raw: string): string | null {
  const target = raw.trim().replace(/^<|>$/g, "");
  if (target === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  return ["http:", "https:", "mailto:"].includes(parsed.protocol)
    ? target
    : null;
}

const BARE_URL_RE = /^https?:\/\/[^\s<>]+/;
/** Trailing punctuation a sentence lends to a URL, not part of it. */
const URL_TRAILING = ".,;:!?'\"";

function matchBareUrl(
  source: string,
  at: number,
  marks: AdfMark[],
): { node: AdfNode; next: number } | null {
  if (hasLink(marks)) return null;
  const before = source[at - 1];
  if (before && /[\w/]/.test(before)) return null;
  const match = BARE_URL_RE.exec(source.slice(at));
  if (!match) return null;
  let url = match[0];
  for (;;) {
    const last = url.at(-1) ?? "";
    if (URL_TRAILING.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    // A `)` goes only when unbalanced, so a wiki-style URL keeps its own.
    if (last === ")" && url.split(")").length > url.split("(").length) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  const href = safeHref(url);
  if (!href) return null;
  return {
    node: textNode(url, withMark(marks, { type: "link", attrs: { href } })),
    next: at + url.length,
  };
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function matchEmphasis(
  source: string,
  at: number,
  marks: AdfMark[],
): { nodes: AdfNode[]; next: number } | null {
  const char = source[at] ?? "";
  const run = runLength(source, at, char);
  if (char === "~") {
    if (run < 2) return null;
    const close = findDelimiter(source, at + 2, "~", 2);
    if (close === -1) return null;
    return {
      nodes: inlineNodes(source.slice(at + 2, close), withMark(marks, STRIKE)),
      next: close + 2,
    };
  }
  const length = Math.min(run, 3);
  if (isSpace(source[at + length])) return null;
  // `_` never marks up mid-word: `snake_case_name` is an identifier.
  if (char === "_" && isWordChar(source[at - 1])) return null;
  const close = findDelimiter(source, at + length, char, length);
  if (close === -1) return null;
  if (char === "_" && isWordChar(source[close + length])) return null;
  const added = length >= 3 ? [STRONG, EM] : length === 2 ? [STRONG] : [EM];
  let inner = marks;
  for (const mark of added) inner = withMark(inner, mark);
  return {
    nodes: inlineNodes(source.slice(at + length, close), inner),
    next: close + length,
  };
}

/** The closing run for an opener of `length`: a run of at least `length` chars
 *  not preceded by whitespace (`a * b *` is not emphasis). */
function findDelimiter(
  source: string,
  from: number,
  char: string,
  length: number,
): number {
  for (let j = from; j < source.length; j++) {
    if (source[j] === "\\") {
      j++;
      continue;
    }
    if (source[j] !== char) continue;
    const run = runLength(source, j, char);
    if (run < length || isSpace(source[j - 1])) {
      j += run - 1;
      continue;
    }
    return j;
  }
  return -1;
}
