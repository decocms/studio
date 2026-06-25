/**
 * Brand folder parsing for the Library brand card + editor. A brand folder is
 * org-fs `brands/<name>/` holding a `tokens.css` (CSS custom properties in the
 * `--brand-*` namespace — the cross-artifact source of truth) and a `brand.md`
 * (voice/tone prose for agents). This is the client-side reader/writer; see
 * the org-fs `hasBrand` marker for detection. Token edits replace declarations
 * in place so hand-authored comments and any non-token CSS survive.
 */

/** Coarse category for grouping tokens into editor sections. */
export type BrandTokenKind =
  | "color"
  | "font"
  | "type"
  | "space"
  | "radius"
  | "shadow"
  | "motion"
  | "other";

export interface BrandToken {
  /** Full custom-property name incl. the leading `--` (e.g. `--brand-primary`). */
  name: string;
  /** Trimmed declared value (e.g. `#0a0a0a`, `"Inter", sans-serif`). */
  value: string;
  /** Value parses as a CSS color — drives the swatch + native color picker. */
  isColor: boolean;
  /** Name is in the `--brand-font-*` sub-namespace — drives the font field. */
  isFont: boolean;
  /** Editor grouping bucket (see `classifyKind`). */
  kind: BrandTokenKind;
}

/** Bucket a token by name + color-ness, for grouped editor sections. */
export function classifyKind(
  name: string,
  isColor: boolean,
  isFont: boolean,
): BrandTokenKind {
  if (isColor) return "color";
  if (isFont) return "font";
  if (/^--brand-(text|fw|leading|tracking)/i.test(name)) return "type";
  if (/^--brand-space/i.test(name)) return "space";
  if (/^--brand-radius/i.test(name)) return "radius";
  if (/^--brand-shadow/i.test(name)) return "shadow";
  if (/^--brand-(duration|delay|ease)/i.test(name)) return "motion";
  return "other";
}

const COLOR_FN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const IMAGE_EXTS = ["svg", "png", "jpg", "jpeg", "webp", "avif", "gif"];

function extOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A value the swatch + `<input type="color">` can render. */
export function isColorValue(value: string): boolean {
  const v = value.trim();
  return HEX.test(v) || COLOR_FN.test(v);
}

/** `#abc` → `#aabbcc`; pass-through for anything else (incl. already-6-digit). */
export function expandHex(value: string): string {
  const v = value.trim();
  const m = v.match(/^#([0-9a-f]{3})$/i);
  if (!m?.[1]) return v;
  return `#${[...m[1]].map((ch) => ch + ch).join("")}`;
}

/**
 * Parse `--brand-*` custom properties from a tokens.css body, in source order.
 * A property declared more than once keeps its last value (CSS cascade) but its
 * first position. Non-`--brand-*` declarations are ignored.
 */
export function parseBrandTokens(css: string): BrandToken[] {
  const order: string[] = [];
  const values = new Map<string, string>();
  const re = /(--brand-[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const name = m[1]!;
    const value = m[2]!.trim();
    if (!values.has(name)) order.push(name);
    values.set(name, value);
  }
  return order.map((name) => {
    const value = values.get(name)!;
    const isColor = isColorValue(value);
    const isFont = /^--brand-font/i.test(name);
    return {
      name,
      value,
      isColor,
      isFont,
      kind: classifyKind(name, isColor, isFont),
    };
  });
}

/** A color family (e.g. `primary`) and its tokens, grouped for the editor. */
export interface BrandColorFamily {
  /** Family key from the token name (`--brand-<family>…`). */
  family: string;
  tokens: BrandToken[];
  /** A numeric scale (≥5 stepped tokens) — render as one swatch band. */
  isRamp: boolean;
}

// Known families render in this design-system order; others keep discovery order.
const FAMILY_ORDER = [
  "primary",
  "secondary",
  "accent",
  "neutral",
  "success",
  "warning",
  "error",
  "info",
  "bg",
  "fg",
  "border",
  "ring",
];

function colorFamilyOf(name: string): string {
  return name.match(/^--brand-([a-z]+)/i)?.[1]?.toLowerCase() ?? name;
}

/**
 * Group color tokens by family (`--brand-<family>…`), flagging numeric scales
 * as ramps so the editor can render them as a single swatch band instead of a
 * wall of rows. Known families come first in DS order.
 */
export function groupColorFamilies(tokens: BrandToken[]): BrandColorFamily[] {
  const seen: string[] = [];
  const byFamily = new Map<string, BrandToken[]>();
  for (const t of tokens) {
    if (t.kind !== "color") continue;
    const family = colorFamilyOf(t.name);
    if (!byFamily.has(family)) {
      seen.push(family);
      byFamily.set(family, []);
    }
    byFamily.get(family)!.push(t);
  }
  const families = seen.map((family) => {
    const fts = byFamily.get(family)!;
    return {
      family,
      tokens: fts,
      isRamp: fts.filter((t) => /-\d+$/.test(t.name)).length >= 5,
    };
  });
  return families.sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a.family);
    const ib = FAMILY_ORDER.indexOf(b.family);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/**
 * Replace a token's declared value in place (preserving the rest of the file).
 * If the token is absent it is inserted into the first `:root { … }` block, or
 * a new `:root` block appended when the file has none.
 */
export function updateBrandToken(
  css: string,
  name: string,
  value: string,
): string {
  const decl = new RegExp(`(${escapeRegExp(name)}\\s*:\\s*)[^;]+(;)`);
  if (decl.test(css)) {
    return css.replace(decl, (_m, pre: string, semi: string) => {
      return `${pre}${value}${semi}`;
    });
  }
  const rootIdx = css.search(/:root\s*\{/);
  if (rootIdx !== -1) {
    const insertAt = css.indexOf("{", rootIdx) + 1;
    return `${css.slice(0, insertAt)}\n  ${name}: ${value};${css.slice(insertAt)}`;
  }
  const sep = css.length > 0 && !css.endsWith("\n") ? "\n" : "";
  return `${css}${sep}:root {\n  ${name}: ${value};\n}\n`;
}

/** The brand's logo file path: a `logo.<imageExt>`, else the first image. */
export function findBrandLogo(
  entries: { path: string; kind: "file" | "dir" }[],
): string | null {
  const files = entries.filter((e) => e.kind === "file");
  const named = files.find((f) =>
    /(^|\/)logo\.(svg|png|jpe?g|webp|avif|gif)$/i.test(f.path),
  );
  if (named) return named.path;
  return files.find((f) => IMAGE_EXTS.includes(extOf(f.path)))?.path ?? null;
}
