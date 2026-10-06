import { asBlocks } from "../block-items";
import { type RawBlock } from "./block-registry";
import { parseJsonArray, str } from "./primitives";

/**
 * One question of the FAQ block (`blog/sections/blocks/FAQ.tsx`): the question
 * as inline rich-text HTML, the answer as a list of deco sections.
 */
export interface FaqItem {
  title: string;
  body: RawBlock[];
}

/**
 * Read the stored `items`, tolerating both shapes the section accepts: a real
 * array (what the editor writes, and what the schema declares) and a
 * JSON-encoded string (what a Spire import hands over). Entries that aren't
 * objects are dropped rather than rendered as empty rows.
 */
export function parseFaqItems(value: unknown): FaqItem[] {
  const out: FaqItem[] = [];
  for (const entry of parseJsonArray<unknown>(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    out.push({ title: str(record.title), body: asBlocks(record.body) });
  }
  return out;
}
