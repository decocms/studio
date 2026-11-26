import { asBlocks } from "../block-items";
import { type RawBlock } from "./block-registry";
import { parseJsonArray, str } from "./primitives";

/**
 * One question of the blog FAQ block: the question as inline rich-text HTML,
 * the answer as a list of sections the site renders one by one.
 */
export interface FaqItem {
  title: string;
  body: RawBlock[];
}

/**
 * The stored `items`, read as the array the schema declares or as the
 * JSON-encoded string an import can hand over. An entry that is not an object
 * is dropped rather than shown as an empty row.
 */
export function parseFaqItems(value: unknown): FaqItem[] {
  const items: FaqItem[] = [];
  for (const entry of parseJsonArray<unknown>(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { title, body } = entry as Record<string, unknown>;
    items.push({ title: str(title), body: asBlocks(body) });
  }
  return items;
}
