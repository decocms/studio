/**
 * The ProductShelf title stores its heading level *inside* the string: an H1
 * title is saved as `<h1>Text</h1>`, a plain title as `Text`. The section
 * renders the title as HTML, so the tag takes effect on the storefront. These
 * helpers convert between the stored value and the (level, text) the editor
 * shows.
 */

export type HeadingLevel = "normal" | "h1" | "h2" | "h3";

export const HEADING_LEVELS: readonly HeadingLevel[] = [
  "normal",
  "h1",
  "h2",
  "h3",
];

const WRAPPED = /^<(h[1-3])>([\s\S]*)<\/\1>$/i;

/** Split a stored title into its heading level and inner text. */
export function parseHeadingValue(value: string): {
  level: HeadingLevel;
  text: string;
} {
  const match = value.match(WRAPPED);
  if (match) {
    return { level: match[1]!.toLowerCase() as HeadingLevel, text: match[2]! };
  }
  return { level: "normal", text: value };
}

/**
 * Rebuild the stored title from a level + text. Empty text stores `""` (no
 * dangling `<h1></h1>`); `normal` stores the bare text.
 */
export function formatHeadingValue(level: HeadingLevel, text: string): string {
  if (!text) return "";
  return level === "normal" ? text : `<${level}>${text}</${level}>`;
}
