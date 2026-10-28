/**
 * The blog's editorial context, read off an organization's `brand.md`.
 *
 * The brand page and the blog read the same file, so they find sections the
 * same way: through {@link groupBrandSections}. A section the page shows on the
 * "Tom de voz" row is the section the blog writes its tone from — the two can
 * never disagree about which heading is which.
 *
 * The file is prose a person or an agent wrote, so every read degrades: a
 * section in an unexpected shape still yields something, and a missing one
 * yields nothing rather than an error.
 */

import { parseFrontmatterDoc } from "../harness/skill-md";
import {
  type BrandItemId,
  brandSections,
  DO_MARK,
  DONT_MARK,
  groupBrandSections,
  sectionMarkdown,
} from "./brand-md";

export type BrandRule = {
  name: string;
  value: string;
};

export type BrandVoiceExample = {
  text: string;
  sounds: boolean;
};

/** Who the brand is — the shape the blog tools take as `brand`. */
export type BlogBrand = {
  companyName: string;
  description: string;
  language: string;
  storeUrl: string;
  targetAudience: string;
  values: BrandRule[];
  competitors: BrandRule[];
  keywords: string[];
  commercialPolicies: BrandRule[];
  specialDates: BrandRule[];
};

/** How the blog is written. */
export type BlogContext = {
  tone: string;
  dos: BrandRule[];
  avoid: BrandRule[];
  vocabulary: BrandRule[];
  voiceExamples: BrandVoiceExample[];
};

export type BlogFormats = {
  formats: BrandRule[];
};

/** One item's sections, joined: a brand may split a part across two headings. */
function itemMarkdown(
  md: string,
  byItem: Map<BrandItemId, string[]>,
  id: BrandItemId,
): string {
  return (byItem.get(id) ?? [])
    .map((title) => sectionMarkdown(md, title) ?? "")
    .filter(Boolean)
    .join("\n\n");
}

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * A section's list items, each with its continuation lines. A section with no
 * list is one item: prose someone wrote as a paragraph is still one rule.
 */
export function listItems(markdown: string): string[] {
  const items: string[] = [];
  let current: string[] | null = null;
  let sawBullet = false;
  for (const line of markdown.split("\n")) {
    const bullet = line.match(BULLET);
    if (bullet && (bullet[1] ?? "").length < 2) {
      sawBullet = true;
      if (current) items.push(current.join("\n").trim());
      current = [bullet[2] ?? ""];
    } else if (current && line.trim()) {
      current.push(line.trim());
    } else if (current && !line.trim()) {
      items.push(current.join("\n").trim());
      current = null;
    }
  }
  if (current) items.push(current.join("\n").trim());
  if (sawBullet) return items.filter(Boolean);
  const prose = markdown.replace(/^#{3,}.*$/gm, "").trim();
  return prose ? [prose] : [];
}

/**
 * `**Name** — value`, `**Name**: value`, `Name: value` or `Name — value` as a
 * named rule; anything else is a rule whose name is the whole line, which is
 * how the tools render a rule with no body.
 */
export function ruleFromItem(item: string): BrandRule {
  const bold = item.match(/^\*\*(.+?)\*\*\s*(?:[:—–-]\s*)?([\s\S]*)$/);
  if (bold?.[1]) {
    return { name: bold[1].trim(), value: (bold[2] ?? "").trim() };
  }
  const split = item.match(/^([^:\n—–]{1,60}?)\s*(?::|\s[—–]\s)\s*([\s\S]+)$/);
  if (split?.[1] && split[2] && !/https?$/i.test(split[1])) {
    return { name: split[1].trim(), value: split[2].trim() };
  }
  return { name: item.trim(), value: "" };
}

function rules(markdown: string): BrandRule[] {
  return listItems(markdown).map(ruleFromItem);
}

/** Plain list entries, for a field that holds terms rather than rules. */
function terms(markdown: string): string[] {
  return listItems(markdown)
    .flatMap((item) => (item.includes("\n") ? [item] : item.split(/\s*,\s*/)))
    .map((term) => term.replace(/[*_`]/g, "").trim())
    .filter(Boolean);
}

/** Prose with list marks and emphasis kept — the tools read markdown. */
function prose(markdown: string): string {
  return markdown.trim();
}

const SOUNDS_HEADING = /^#{3,}\s*(.*)$/;
const NOT_SOUNDS =
  /n[ãa]o\s+soa|don.?t\s+sound|doesn.?t\s+sound|avoid|evit|never|nunca/i;

function stripQuotes(text: string): string {
  return text.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
}

/**
 * Example sentences, marked by `✅`/`❌` or filed under a `###` that says
 * which side they are on ("Soa como a marca" / "Não soa como ela"). Unmarked
 * lines outside any such heading count as on-voice: an example someone wrote
 * down without a mark is far more often one to imitate.
 */
export function voiceExamples(markdown: string): BrandVoiceExample[] {
  const examples: BrandVoiceExample[] = [];
  let side = true;
  for (const line of markdown.split("\n")) {
    const heading = line.match(SOUNDS_HEADING);
    if (heading) {
      side = !NOT_SOUNDS.test(heading[1] ?? "");
      continue;
    }
    let sounds = side;
    let text: string | null = null;
    if (DO_MARK.test(line)) {
      sounds = true;
      text = line.replace(DO_MARK, "");
    } else if (DONT_MARK.test(line)) {
      sounds = false;
      text = line.replace(DONT_MARK, "");
    } else {
      const bullet = line.match(BULLET);
      if (bullet) text = bullet[2] ?? "";
    }
    const sentence = text ? stripQuotes(text) : "";
    if (sentence) examples.push({ text: sentence, sounds });
  }
  return examples;
}

/**
 * A "Do / Don't" section: `❌` lines are what to avoid and `✅` lines are more
 * dos. With no marks at all, every item is a don't — that is what a section
 * titled "O que evitar" is.
 */
export function doDont(markdown: string): {
  dos: BrandRule[];
  avoid: BrandRule[];
} {
  const lines = markdown.split("\n");
  if (!lines.some((line) => DO_MARK.test(line) || DONT_MARK.test(line))) {
    return { dos: [], avoid: rules(markdown) };
  }
  const dos: BrandRule[] = [];
  const avoid: BrandRule[] = [];
  for (const line of lines) {
    if (DO_MARK.test(line)) {
      dos.push(ruleFromItem(line.replace(DO_MARK, "").trim()));
    } else if (DONT_MARK.test(line)) {
      avoid.push(ruleFromItem(line.replace(DONT_MARK, "").trim()));
    }
  }
  return { dos, avoid };
}

/** Each `### Name` under the formats section, with its brief. */
export function formatsFrom(markdown: string): BrandRule[] {
  const formats: BrandRule[] = [];
  const chunks = markdown.split(/^###\s+/m).slice(1);
  for (const chunk of chunks) {
    const [heading = "", ...rest] = chunk.split("\n");
    const name = heading.replace(/[*_`]/g, "").trim();
    if (name) formats.push({ name, value: rest.join("\n").trim() });
  }
  return formats;
}

/**
 * The blog's brand, writing rules and formats, from `brand.md`.
 *
 * `fallbackName` names a brand whose file has no `name:` — the folder's name,
 * which the brand page shows as its title too.
 */
export function brandForBlog(
  md: string,
  fallbackName: string,
): { brand: BlogBrand; context: BlogContext; formats: BlogFormats } {
  const { fm, body } = parseFrontmatterDoc(md);
  const { groups } = groupBrandSections(brandSections(body));
  const byItem = new Map<BrandItemId, string[]>();
  for (const group of groups) {
    for (const item of group.items) {
      byItem.set(
        item.id,
        item.sections.map((section) => section.title),
      );
    }
  }
  const part = (id: BrandItemId) => itemMarkdown(body, byItem, id);
  const guardrails = doDont(part("donts"));

  return {
    brand: {
      companyName: fm.name || fallbackName,
      description: fm.description ?? "",
      language: fm.language ?? "",
      storeUrl: fm.site ?? "",
      targetAudience: prose(part("audience")),
      values: rules(part("values")),
      competitors: rules(part("competitors")),
      keywords: terms(part("keywords")),
      commercialPolicies: rules(part("policies")),
      specialDates: rules(part("dates")),
    },
    context: {
      tone: prose(part("voice")),
      dos: [...rules(part("rules")), ...guardrails.dos],
      avoid: guardrails.avoid,
      vocabulary: rules(part("vocabulary")),
      voiceExamples: voiceExamples(part("examples")),
    },
    formats: { formats: formatsFrom(part("formats")) },
  };
}
