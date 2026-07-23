/**
 * Icon-select previews from a site's SVG sprite sheet.
 *
 * Migrated deco sites ship their icon set as `public/sprites.svg` — a hidden
 * `<svg>` of `<symbol id="…" viewBox="…">…</symbol>` elements, rendered at
 * runtime via `<use href="/sprites.svg#id">`. The block-editor icon-select
 * field reuses that same set for its previews: it fetches the sprite (through
 * the same-origin preview proxy) and converts each `<symbol>` into a standalone
 * `<svg>` string, which the combobox renders as a data-URI `<img>`.
 *
 * Each icon is rendered in isolation (its own data-URI document), so `clipPath`
 * / gradient ids inside a symbol can't collide with another icon's — no id
 * namespacing is needed.
 */

const attr = (attrs: string, name: string): string | undefined =>
  attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1];

/**
 * Parse a sprite sheet into a map of `symbol id → standalone <svg> markup`.
 * Each `<symbol id="X" viewBox="V" fill="F">INNER</symbol>` becomes
 * `<svg xmlns=… viewBox="V" fill="F">INNER</svg>`, preserving the symbol's own
 * viewBox/fill (they vary per icon).
 */
export function parseSpriteSymbols(svgText: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof svgText !== "string") return out;
  // The attribute-list group tolerates a literal `>` inside a quoted attribute
  // value (`"..."`/`'...'`) instead of stopping at the first `>`. The three
  // alternatives are disjoint on their first char, so there's no backtracking.
  const symbolRe =
    /<symbol\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/symbol>/gi;
  for (const match of svgText.matchAll(symbolRe)) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const id = attr(attrs, "id");
    if (!id) continue;
    const viewBox = attr(attrs, "viewBox");
    const fill = attr(attrs, "fill");
    const svgAttrs = [
      'xmlns="http://www.w3.org/2000/svg"',
      viewBox ? `viewBox="${viewBox}"` : "",
      fill ? `fill="${fill}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    out[id] = `<svg ${svgAttrs}>${inner}</svg>`;
  }
  return out;
}

/** Fetch a site's sprite sheet (via the preview proxy) and parse its symbols. */
export async function fetchSpriteIcons(
  url: string,
): Promise<Record<string, string>> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch sprite sheet: ${res.status}`);
  }
  return parseSpriteSymbols(await res.text());
}
