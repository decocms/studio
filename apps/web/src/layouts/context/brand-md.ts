/**
 * Reads the parts of a brand's `brand.md` the Context brand page shows: the
 * line that sums up its voice, a do and a don't, and one row per `##` section.
 * The file is prose written for agents, so every read degrades to nothing.
 */

export interface BrandSection {
  title: string;
  summary: string;
}

/** Inline markdown down to plain text: emphasis, code, links and list marks. */
function plainText(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+\.|>)\s*/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

/** `## 4. Voice & tone (see tokens.css)` reads as `Voice & tone`. */
function sectionTitle(heading: string): string {
  return heading
    .replace(/^\d+\.\s*/, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}

/** A line that carries prose: not a heading, a table row or a fence. */
function isProse(line: string): boolean {
  const text = line.trim();
  return (
    text.length > 0 &&
    !text.startsWith("#") &&
    !text.startsWith("|") &&
    !text.startsWith("```")
  );
}

export function brandSections(body: string): BrandSection[] {
  const sections: BrandSection[] = [];
  for (const chunk of body.split(/^## /m).slice(1)) {
    const [heading = "", ...lines] = chunk.split("\n");
    const title = sectionTitle(heading);
    const first = lines.find(isProse);
    if (title) {
      sections.push({ title, summary: first ? plainText(first) : "" });
    }
  }
  return sections;
}

/** The first blockquote, the brand saying what it is in its own voice. */
export function brandQuote(body: string): string | null {
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith(">")) lines.push(plainText(line));
    else if (lines.length > 0) break;
  }
  const quote = lines.join(" ").trim();
  return quote || null;
}

const DO = /^\s*[-*]\s*(?:✅|✓|✔)\s*/;
const DONT = /^\s*[-*]\s*(?:❌|✗|✘)\s*/;

/** The first do and the first don't, from `- ✅ …` and `- ❌ …` lines. */
export function brandDoDont(body: string): {
  doLine: string | null;
  dontLine: string | null;
} {
  const lines = body.split("\n");
  const first = (pattern: RegExp) => {
    const line = lines.find((l) => pattern.test(l));
    return line ? plainText(line.replace(pattern, "")) : null;
  };
  return { doLine: first(DO), dontLine: first(DONT) };
}

/** The first family in a `font-family` value: `"Inter", sans-serif` → Inter. */
export function fontName(value: string): string {
  return (value.split(",")[0] ?? "").replace(/["']/g, "").trim();
}

/** The same `font-family` with its first family renamed, fallbacks kept. */
export function withFontName(value: string, name: string): string {
  const rest = value.split(",").slice(1).join(",");
  return rest ? `"${name}",${rest}` : `"${name}"`;
}

/** The parts of a brand guide agents write with, each found by its section titles. */
const BRAND_GROUPS = [
  {
    id: "basics",
    items: [
      { id: "voice", match: /voice|tone|\btom\b|\bvoz\b/i },
      { id: "audience", match: /audience|customer|persona|p[úu]blico/i },
      { id: "examples", match: /example|phrase|frase/i },
    ],
  },
  {
    id: "rules",
    items: [
      { id: "rules", match: /\brules?\b|\bdo'?s\b|instruction|regras?\b/i },
      { id: "vocabulary", match: /vocab|glossar|vocabul/i },
    ],
  },
  {
    id: "guardrails",
    items: [{ id: "donts", match: /don.?t|avoid|guardrail|never|evitar/i }],
  },
  {
    id: "extra",
    items: [
      { id: "values", match: /\bvalues?\b|valores/i },
      { id: "competitors", match: /competitor|rival|concorrent/i },
      { id: "keywords", match: /keyword|palavras-chave|\bseo\b/i },
      { id: "dates", match: /date|campaign|calendar|datas|campanha/i },
      { id: "policies", match: /polic|shipping|returns?\b|frete|troca/i },
    ],
  },
] as const;

export type BrandGroupId = (typeof BRAND_GROUPS)[number]["id"];
export type BrandItemId = (typeof BRAND_GROUPS)[number]["items"][number]["id"];

/** Don'ts before rules, so "Do / Don't" lands with the guardrails. */
const MATCH_ORDER: BrandItemId[] = [
  "donts",
  "examples",
  "vocabulary",
  "keywords",
  "voice",
  "audience",
  "rules",
  "values",
  "competitors",
  "dates",
  "policies",
];

/** Each section under the part it writes, every part listed even when empty. */
export function groupBrandSections(sections: readonly BrandSection[]): {
  groups: {
    id: BrandGroupId;
    items: { id: BrandItemId; sections: BrandSection[] }[];
  }[];
  more: BrandSection[];
} {
  const items: readonly { id: BrandItemId; match: RegExp }[] =
    BRAND_GROUPS.flatMap(
      (group): readonly { id: BrandItemId; match: RegExp }[] => group.items,
    );
  const byItem = new Map<BrandItemId, BrandSection[]>();
  const more: BrandSection[] = [];
  for (const section of sections) {
    const id = MATCH_ORDER.find((itemId) =>
      items.find((item) => item.id === itemId)?.match.test(section.title),
    );
    if (id) byItem.set(id, [...(byItem.get(id) ?? []), section]);
    else more.push(section);
  }
  return {
    groups: BRAND_GROUPS.map((group) => ({
      id: group.id,
      items: group.items.map((item) => ({
        id: item.id,
        sections: byItem.get(item.id) ?? [],
      })),
    })),
    more,
  };
}

/** Where each `##` section's text sits in the whole file, by its display title. */
function sectionSpans(md: string) {
  const headings = [...md.matchAll(/^## (.*)$/gm)];
  return headings.map((match, i) => ({
    title: sectionTitle(match[1] ?? ""),
    start: (match.index ?? 0) + match[0].length,
    end: headings[i + 1]?.index ?? md.length,
  }));
}

/** The markdown under a section's heading, trimmed; null when there is none. */
export function sectionMarkdown(md: string, title: string): string | null {
  const span = sectionSpans(md).find((s) => s.title === title);
  return span ? md.slice(span.start, span.end).trim() : null;
}

/** The file with one section's text replaced, or the section appended. */
export function writeSection(md: string, title: string, text: string): string {
  const span = sectionSpans(md).find((s) => s.title === title);
  const body = text.trim();
  if (!span) {
    const sep =
      md.length === 0 || md.endsWith("\n\n")
        ? ""
        : md.endsWith("\n")
          ? "\n"
          : "\n\n";
    return `${md}${sep}## ${title}\n\n${body}\n`;
  }
  const tail = span.end < md.length ? "\n\n" : "\n";
  return `${md.slice(0, span.start)}\n\n${body}${tail}${md.slice(span.end)}`;
}

/** The file with its first blockquote replaced, or one added before the first section. */
export function writeQuote(md: string, text: string): string {
  const quote = text
    .trim()
    .split("\n")
    .map((line) => `> ${line.trim()}`)
    .join("\n");
  const lines = md.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith(">"));
  if (start !== -1) {
    let end = start;
    while (lines[end + 1]?.trimStart().startsWith(">")) end++;
    if (!quote)
      return [...lines.slice(0, start), ...lines.slice(end + 2)].join("\n");
    return [...lines.slice(0, start), quote, ...lines.slice(end + 1)].join(
      "\n",
    );
  }
  if (!quote) return md;
  const firstSection = md.search(/^## /m);
  return firstSection === -1
    ? `${md}${md.endsWith("\n") || !md ? "" : "\n"}\n${quote}\n`
    : `${md.slice(0, firstSection)}${quote}\n\n${md.slice(firstSection)}`;
}
