/**
 * Pure helpers for the Variant Calendar view. Walks every decofile block
 * recursively and emits one entry per (variant container, date matcher)
 * pair. A "variant container" is any object whose `__resolveType` looks
 * like `<scope>/flags/multivariate/<kind>.ts` and that has a `variants`
 * array; this covers top-level section flags (`website/flags/multivariate/
 * section.ts`), image-field flags nested inside other blocks
 * (`website/flags/multivariate/image.ts`), and site-specific custom flags
 * (e.g. `site/flags/multivariate/etcMediaKitContent.ts`).
 *
 * Date matchers are extracted from each variant's `rule`, including those
 * nested inside `website/matchers/multi.ts` and legacy `$live` aliases.
 * Variants without any date matcher are skipped — those run on every page
 * load and have no place on a time axis.
 */

const DATE_MATCHER_TYPES = new Set([
  "website/matchers/date.ts",
  "$live/matchers/MatchDate.ts",
]);

const MULTI_MATCHER_TYPES = new Set([
  "website/matchers/multi.ts",
  "$live/matchers/MatchMulti.ts",
]);

// Sentinels for open-ended ranges (campaign with only a `start`, or only an
// `end`). `new Date(±8.64e15)` are the min/max representable Date values, so
// they clamp cleanly to any visible window and sort to the extremes without
// special-casing the layout math. Openness is tracked explicitly via the
// `openStart`/`openEnd` flags so rendering/tooltips never sniff for these.
const OPEN_START = new Date(-8_640_000_000_000_000);
const OPEN_END = new Date(8_640_000_000_000_000);

// Non-anchored on purpose: matches `<scope>/flags/multivariate.ts` (the
// page-level flag) as well as `<scope>/flags/multivariate/<x>.ts` for any
// scope, so `website/flags/multivariate.ts`,
// `website/flags/multivariate/section.ts`,
// `site/flags/multivariate/etcMediaKitContent.ts`, and the legacy
// `$live/flags/multivariate/section.ts` all match.
const MULTIVARIATE_FLAG_PATTERN = /\/flags\/multivariate(?:\/[^/]+)?\.ts$/;

// The page-level flag (no `/kind` subpath): `<scope>/flags/multivariate.ts`.
// It lives at a page's conventional `sections` field and *is* the page's
// variant, so it carries no meaningful inner path (which would otherwise read
// as the literal field name "sections").
const PAGE_LEVEL_FLAG_PATTERN = /\/flags\/multivariate\.ts$/;

export interface ScheduledVariant {
  /** Top-level decofile key the variant lives under (used for grouping/color). */
  blockKey: string;
  /** Display-friendly version of `blockKey` — URL-decoded, page-prefix stripped. */
  blockLabel: string;
  /** Human-readable path inside the block, empty for top-level containers. */
  innerPath: string;
  variantIndex: number;
  start: Date;
  end: Date;
  /** True when the variant has no `start` (runs since forever, open on the left). */
  openStart: boolean;
  /** True when the variant has no `end` (runs indefinitely, open on the right). */
  openEnd: boolean;
  /** Best-effort short label from the variant's `value`, or a path-derived fallback. */
  label: string;
  /** The flag's `__resolveType`, e.g. `website/flags/multivariate/image.ts`. */
  flagResolveType: string;
}

/**
 * Turns a raw decofile key into something a human can read at a glance.
 * Examples:
 *   "Alerta"                                       → "Alerta"
 *   "pages-Bazar%20Melhores%20Descontos-743529"    → "Bazar Melhores Descontos"
 *   "Category Banner - 01"                         → "Category Banner - 01"
 */
function humanizeBlockKey(key: string): string {
  let label = key;
  // Strip `pages-` prefix and trailing numeric id (e.g. `-743529`).
  if (label.startsWith("pages-")) {
    label = label.slice("pages-".length).replace(/-\d+$/, "");
  }
  try {
    label = decodeURIComponent(label);
  } catch {
    // Leave as-is when not valid percent-encoded text.
  }
  return label;
}

interface DateRange {
  start: Date;
  end: Date;
  openStart: boolean;
  openEnd: boolean;
}

function readDateRange(rule: unknown): DateRange | null {
  if (!rule || typeof rule !== "object") return null;
  const { start, end } = rule as { start?: unknown; end?: unknown };
  const hasStart = typeof start === "string";
  const hasEnd = typeof end === "string";
  // Both sides absent → an always-on variant with no time axis; it belongs
  // off the calendar (same as audience/device matchers).
  if (!hasStart && !hasEnd) return null;
  const startDate = hasStart ? new Date(start) : OPEN_START;
  const endDate = hasEnd ? new Date(end) : OPEN_END;
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return null;
  }
  // Only enforce ordering when both ends are real dates.
  if (hasStart && hasEnd && endDate.getTime() <= startDate.getTime()) {
    return null;
  }
  return {
    start: startDate,
    end: endDate,
    openStart: !hasStart,
    openEnd: !hasEnd,
  };
}

function collectDateRanges(rule: unknown, out: DateRange[]): void {
  if (!rule || typeof rule !== "object") return;
  const rt = (rule as { __resolveType?: unknown }).__resolveType;
  if (typeof rt !== "string") return;
  if (DATE_MATCHER_TYPES.has(rt)) {
    const range = readDateRange(rule);
    if (range) out.push(range);
    return;
  }
  if (MULTI_MATCHER_TYPES.has(rt)) {
    const matchers = (rule as { matchers?: unknown }).matchers;
    if (Array.isArray(matchers)) {
      for (const m of matchers) collectDateRanges(m, out);
    }
  }
}

function isVariantContainer(node: unknown): node is {
  __resolveType: string;
  variants: unknown[];
} {
  if (!node || typeof node !== "object") return false;
  const rt = (node as { __resolveType?: unknown }).__resolveType;
  if (typeof rt !== "string") return false;
  if (!MULTIVARIATE_FLAG_PATTERN.test(rt)) return false;
  const variants = (node as { variants?: unknown }).variants;
  return Array.isArray(variants);
}

function readValueLabel(value: unknown): string | null {
  // Plain string values (e.g. image URLs in `website/flags/multivariate/image.ts`)
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // For URLs, return the last meaningful path segment without query string.
    try {
      const u = new URL(trimmed);
      const segments = u.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      if (last) return decodeURIComponent(last);
    } catch {
      // not a URL; fall through
    }
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const config = v.config as Record<string, unknown> | undefined;
  const desktop = v.desktop as Record<string, unknown> | undefined;
  const desktopMedia = desktop?.media as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    v.title,
    v.name,
    v.label,
    v.alt,
    config?.title,
    config?.name,
    (config?.typeAlert as Record<string, unknown> | undefined)?.message,
    desktopMedia?.alt,
    Array.isArray(v.matcher) ? (v.matcher as unknown[])[0] : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  // Last resort: derive a label from the section's resolveType, e.g.
  // "site/sections/NewSearch/ProductListGallery.tsx" → "ProductListGallery".
  const rt = v.__resolveType;
  if (typeof rt === "string") {
    const last = rt.split("/").pop() ?? rt;
    const stripped = last.replace(/\.(tsx?|jsx?)$/i, "");
    if (stripped.length > 0) return stripped;
  }
  return null;
}

function formatInnerPath(segments: Array<string | number>): string {
  // "/banners/0/image/mobile" → "banners[0] · image · mobile"
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (typeof seg === "number") {
      // Attach index to previous segment.
      if (parts.length > 0) parts[parts.length - 1] += `[${seg}]`;
      else parts.push(`[${seg}]`);
    } else {
      parts.push(seg);
    }
  }
  return parts.join(" · ");
}

function walkAndCollect(
  node: unknown,
  blockKey: string,
  blockLabel: string,
  innerSegments: Array<string | number>,
  out: ScheduledVariant[],
): void {
  if (isVariantContainer(node)) {
    const variants = (node as { variants: unknown[] }).variants;
    const flagResolveType = (node as { __resolveType: string }).__resolveType;
    // Page-level flags have no meaningful inner path — the label then falls
    // back to the page name (`blockLabel`) instead of the field name.
    const innerPath = PAGE_LEVEL_FLAG_PATTERN.test(flagResolveType)
      ? ""
      : formatInnerPath(innerSegments);
    variants.forEach((variant, variantIndex) => {
      if (!variant || typeof variant !== "object") return;
      const v = variant as Record<string, unknown>;
      const ranges: DateRange[] = [];
      collectDateRanges(v.rule, ranges);
      if (ranges.length === 0) return;
      const valueLabel = readValueLabel(v.value);
      const label = valueLabel ?? (innerPath || blockLabel);
      for (const range of ranges) {
        out.push({
          blockKey,
          blockLabel,
          innerPath,
          variantIndex,
          start: range.start,
          end: range.end,
          openStart: range.openStart,
          openEnd: range.openEnd,
          label,
          flagResolveType,
        });
      }
    });
    // Recurse into variant values too — a variant's value can itself
    // contain nested multivariate flags (rare but legal).
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      if (v && typeof v === "object") {
        walkAndCollect(
          (v as { value?: unknown }).value,
          blockKey,
          blockLabel,
          [...innerSegments, "variants", i, "value"],
          out,
        );
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkAndCollect(node[i], blockKey, blockLabel, [...innerSegments, i], out);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      // Skip __resolveType so we don't recurse into it as a string field.
      if (k === "__resolveType") continue;
      walkAndCollect(v, blockKey, blockLabel, [...innerSegments, k], out);
    }
  }
}

export function extractScheduledVariants(
  decofile: Record<string, unknown> | null | undefined,
): ScheduledVariant[] {
  if (!decofile) return [];
  const out: ScheduledVariant[] = [];
  for (const [blockKey, block] of Object.entries(decofile)) {
    walkAndCollect(block, blockKey, humanizeBlockKey(blockKey), [], out);
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export interface BlockColor {
  bg: string;
  text: string;
  border: string;
}

/**
 * Builds a stable per-block color map. Block keys are sorted and assigned
 * hues using the golden-angle sequence (137.508°), which maximizes visual
 * separation regardless of how many distinct blocks we have. Hashing the
 * key directly into a hue (the previous approach) was prone to collisions
 * — different blocks could land on nearby or identical hues.
 *
 * Same blockKey always gets the same color **for the same set of inputs**;
 * adding a new block re-sorts and may shift colors. Stability across
 * renders comes from the input being derived deterministically from the
 * decofile, not from the key in isolation.
 */
export function buildBlockColorMap(
  blockKeys: Iterable<string>,
): Map<string, BlockColor> {
  const sorted = [...new Set(blockKeys)].sort();
  const map = new Map<string, BlockColor>();
  sorted.forEach((key, i) => {
    const hue = (i * 137.508) % 360;
    map.set(key, {
      bg: `oklch(0.62 0.14 ${hue})`,
      text: "white",
      border: `oklch(0.50 0.14 ${hue})`,
    });
  });
  return map;
}

const FALLBACK_COLOR: BlockColor = {
  bg: "oklch(0.62 0.14 0)",
  text: "white",
  border: "oklch(0.50 0.14 0)",
};

export function colorFromMap(
  map: Map<string, BlockColor>,
  blockKey: string,
): BlockColor {
  return map.get(blockKey) ?? FALLBACK_COLOR;
}
