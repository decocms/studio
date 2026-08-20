/**
 * Jira wiki markup (the v2-API text format) → the markdown board cards render.
 *
 * A small hand-written parser, not regex passes: a block extractor walks the
 * string for {code}/{noformat}/{quote} sections (their contents are never
 * rewritten / are quoted whole), line rules handle headings, lists, tables
 * and rules, and a character scanner converts inline marks with recursion so
 * nesting works (bold containing a link, a table cell containing bold).
 * Anything ambiguous is left as-is — mangling a sentence is worse than
 * showing a stray `*`.
 */

export function wikiToMarkdown(
  wiki: string,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const resolved: string[] = [];
  const stash = (text: string) => stashMentions(text, names, resolved);
  const converted = splitBlocks(wiki)
    .map((block) => {
      if (block.type === "code") {
        return `\`\`\`${block.lang}\n${trimEdgeNewlines(block.content)}\n\`\`\``;
      }
      if (block.type === "quote") {
        return convertLines(stash(trimEdgeNewlines(block.content)))
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      }
      return convertLines(stash(block.content));
    })
    .join("");
  return restoreMentions(converted, resolved);
}

type Block =
  | { type: "text"; content: string }
  | { type: "code"; content: string; lang: string }
  | { type: "quote"; content: string };

function trimEdgeNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "\n") start++;
  while (end > start && text[end - 1] === "\n") end--;
  return text.slice(start, end);
}

/** Walk the string splitting out {code[:lang]}…{code}, {noformat}…{noformat}
 *  and {quote}…{quote} sections. An opener without its closer stays text. */
function splitBlocks(wiki: string): Block[] {
  const blocks: Block[] = [];
  let pos = 0;
  while (pos < wiki.length) {
    const code = findCodeBlock(wiki, pos);
    const noformat = findDelimited(wiki, pos, "{noformat}");
    const quote = findDelimited(wiki, pos, "{quote}");
    const candidates: Array<Block & { start: number; end: number }> = [];
    if (code) candidates.push({ type: "code", ...code });
    if (noformat) candidates.push({ type: "code", lang: "", ...noformat });
    if (quote) candidates.push({ type: "quote", ...quote });
    const next = candidates.sort((a, b) => a.start - b.start)[0];
    if (!next) {
      blocks.push({ type: "text", content: wiki.slice(pos) });
      break;
    }
    if (next.start > pos) {
      blocks.push({ type: "text", content: wiki.slice(pos, next.start) });
    }
    blocks.push(next);
    pos = next.end;
  }
  return blocks;
}

function findCodeBlock(
  wiki: string,
  from: number,
): { start: number; end: number; content: string; lang: string } | null {
  for (let start = wiki.indexOf("{code", from); start !== -1; ) {
    const openEnd = wiki.indexOf("}", start);
    if (openEnd === -1) return null;
    const params = wiki.slice(start + "{code".length, openEnd);
    if (params === "" || params.startsWith(":")) {
      const close = wiki.indexOf("{code}", openEnd + 1);
      if (close === -1) return null;
      const lang = params.startsWith(":")
        ? (params.slice(1).split("|")[0] ?? "")
        : "";
      return {
        start,
        end: close + "{code}".length,
        content: wiki.slice(openEnd + 1, close),
        lang,
      };
    }
    start = wiki.indexOf("{code", start + 1);
  }
  return null;
}

function findDelimited(
  wiki: string,
  from: number,
  tag: string,
): { start: number; end: number; content: string } | null {
  const start = wiki.indexOf(tag, from);
  if (start === -1) return null;
  const close = wiki.indexOf(tag, start + tag.length);
  if (close === -1) return null;
  return {
    start,
    end: close + tag.length,
    content: wiki.slice(start + tag.length, close),
  };
}

function convertLines(text: string): string {
  return text.split("\n").map(convertLine).join("\n");
}

function leadingRun(line: string, char: string): number {
  let count = 0;
  while (line[count] === char) count++;
  return count;
}

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 4 && leadingRun(trimmed, "-") === trimmed.length;
}

function convertLine(line: string): string {
  const digit = line[1] ?? "";
  if (line[0] === "h" && digit >= "1" && digit <= "6" && line[2] === ".") {
    return `${"#".repeat(Number(digit))} ${inline(line.slice(3).trimStart())}`;
  }
  if (isHorizontalRule(line)) return "---";

  const bullets = leadingRun(line, "*");
  if (bullets > 0 && line[bullets] === " ") {
    const marker = bullets === 1 ? "*" : `${"  ".repeat(bullets - 1)}-`;
    return `${marker} ${inline(line.slice(bullets + 1))}`;
  }
  const numbers = leadingRun(line, "#");
  if (numbers > 0 && line[numbers] === " ") {
    return `${"  ".repeat(numbers - 1)}1. ${inline(line.slice(numbers + 1))}`;
  }

  const trimmed = line.trimEnd();
  if (
    trimmed.startsWith("||") &&
    trimmed.endsWith("||") &&
    trimmed.length > 4
  ) {
    const cells = trimmed.slice(2, -2).split("||");
    const header = `| ${cells.map((cell) => inline(cell.trim())).join(" | ")} |`;
    return `${header}\n|${cells.map(() => " --- ").join("|")}|`;
  }
  if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2) {
    const cells = trimmed.slice(1, -1).split("|");
    return `| ${cells.map((cell) => inline(cell.trim())).join(" | ")} |`;
  }

  return inline(line);
}

function isUrl(text: string): boolean {
  return (
    (text.startsWith("http://") || text.startsWith("https://")) &&
    !text.includes(" ")
  );
}

const OPENER_BOUNDARY = " ([{>";
/** Includes markup starters ({, [, !) — a closer may butt against markup
 *  that a later scanner step consumes, e.g. `*bold*{color}`. */
const CLOSER_BOUNDARY = ` )]}.,:;!?{["'`;

/** Character scanner over one line (or one cell). Recursion via `emphasis`
 *  handles nesting; unmatched or mid-word markers fall through untouched. */
function inline(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? "";

    if (char === "{") {
      if (text.startsWith("{{", i)) {
        const end = text.indexOf("}}", i + 2);
        if (end !== -1) {
          out += `\`${text.slice(i + 2, end)}\``;
          i = end + 2;
          continue;
        }
      }
      if (text.startsWith("{color", i)) {
        const end = text.indexOf("}", i);
        if (end !== -1) {
          i = end + 1;
          continue;
        }
      }
    } else if (char === "[") {
      const end = text.indexOf("]", i);
      if (end !== -1) {
        const body = text.slice(i + 1, end);
        const pipe = body.indexOf("|");
        if (pipe !== -1 && isUrl(body.slice(pipe + 1))) {
          out += `[${body.slice(0, pipe)}](${body.slice(pipe + 1)})`;
          i = end + 1;
          continue;
        }
        if (isUrl(body)) {
          out += body;
          i = end + 1;
          continue;
        }
      }
    } else if (char === "!") {
      const end = text.indexOf("!", i + 1);
      if (end !== -1) {
        const body = text.slice(i + 1, end);
        const pipe = body.indexOf("|");
        const target = pipe === -1 ? body : body.slice(0, pipe);
        if (isUrl(target)) {
          out += `![](${target})`;
          i = end + 1;
          continue;
        }
      }
    } else if (char === "*" || char === "_") {
      // Opener boundary = last EMITTED char, so consumed markup (a stripped {color}) doesn't block it.
      const emphasized = emphasis(text, i, char, out.slice(-1) || " ");
      if (emphasized) {
        out += emphasized.text;
        i = emphasized.next;
        continue;
      }
    }

    out += char;
    i++;
  }
  return out;
}

function emphasis(
  text: string,
  at: number,
  marker: "*" | "_",
  before: string,
): { text: string; next: number } | null {
  if (!OPENER_BOUNDARY.includes(before)) return null;
  const first = text[at + 1];
  if (!first || first === " " || first === marker) return null;
  for (let j = at + 2; j < text.length; j++) {
    if (text[j] !== marker || text[j - 1] === " ") continue;
    const after = text[j + 1];
    if (after !== undefined && !CLOSER_BOUNDARY.includes(after)) continue;
    const innerText = inline(text.slice(at + 1, j));
    return {
      text: marker === "*" ? `**${innerText}**` : `*${innerText}*`,
      next: j + 1,
    };
  }
  return null;
}

/** What a mention renders as when the account id can't be resolved to a name:
 *  a deleted account, or a credential without "Browse users and groups". Still
 *  better than leaking the raw opaque id into a card. */
export const UNKNOWN_MENTION = "@unknown";

/** A Cloud mention: `[~accountid:557058:1a2b…]`. The `accountid:` prefix is
 *  load-bearing — matching bare `[~token]` too would rewrite prose describing
 *  code (`lookup[~key]`, `arr[~1]`), and Cloud has no other mention form. */
const WIKI_MENTION = /\[~accountid:([^\]\s|]+)\]/g;

/** Markdown metacharacters in a DISPLAY NAME, which is tenant-controlled text:
 *  an unescaped `Ana _Nick_ Souza` renders as italics, and a `|` splits a table
 *  cell. Escaped for the markdown the card renders; the wiki parser never sees
 *  the name at all (see `stashMentions`). */
export function escapeMentionName(name: string): string {
  return name.replace(/([\\`*_[\]|~])/g, "\\$1");
}

/** Account ids referenced by wiki mentions outside code blocks — what a name
 *  lookup needs. Skips `{code}`/`{noformat}` so it can't request a name the
 *  renderer will then discard. */
export function collectWikiMentionAccountIds(wiki: string): string[] {
  const ids: string[] = [];
  for (const block of splitBlocks(wiki)) {
    if (block.type === "code") continue;
    for (const [, id] of block.content.matchAll(WIKI_MENTION)) {
      if (id) ids.push(id);
    }
  }
  return ids;
}

/** NUL can't occur in Jira text (Postgres can't even store it) and carries no
 *  markup, so it survives the parser as inert content. */
const SENTINEL = "\u0000";
const SENTINEL_REF = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g");

/** Swap each mention for an inert sentinel BEFORE parsing, per non-code block:
 *  the resolved name never reaches the inline scanner, so a name can't open
 *  emphasis or split a table cell, and code stays byte-exact. */
function stashMentions(
  wiki: string,
  names: ReadonlyMap<string, string>,
  resolved: string[],
): string {
  // Dropped first so the sentinel namespace is ours alone and source text
  // can't forge a reference. Postgres rejects NUL, so this text is unstorable.
  return wiki
    .replaceAll(SENTINEL, "")
    .replace(WIKI_MENTION, (_whole, id: string) => {
      const name = names.get(id);
      const index = resolved.length;
      resolved.push(name ? `@${escapeMentionName(name)}` : UNKNOWN_MENTION);
      return `${SENTINEL}${index}${SENTINEL}`;
    });
}

function restoreMentions(markdown: string, resolved: string[]): string {
  return markdown.replace(
    SENTINEL_REF,
    (_whole, index: string) => resolved[Number(index)] ?? UNKNOWN_MENTION,
  );
}
