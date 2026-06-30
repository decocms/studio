/**
 * Pure helpers for the Variant Calendar view. Pulls scheduled variants out of
 * a decofile by recursively scanning each block's `variants[].rule` for
 * `website/matchers/date.ts` matchers (also nested inside `multi.ts`/legacy
 * `$live` aliases). Each emitted entry corresponds to one (block, variant,
 * date-range) tuple — a variant with two date matchers becomes two rows so
 * each can be drawn on the calendar independently.
 */

const DATE_MATCHER_TYPES = new Set([
  "website/matchers/date.ts",
  "$live/matchers/MatchDate.ts",
]);

const MULTI_MATCHER_TYPES = new Set([
  "website/matchers/multi.ts",
  "$live/matchers/MatchMulti.ts",
]);

const FLAG_RESOLVE_TYPES = new Set([
  "website/flags/multivariate/section.ts",
  "website/flags/audience.ts",
  "$live/flags/Flag.ts",
]);

export interface ScheduledVariant {
  blockKey: string;
  variantIndex: number;
  start: Date;
  end: Date;
  label: string;
  resolveType: string | null;
}

function readDateRange(rule: unknown): { start: Date; end: Date } | null {
  if (!rule || typeof rule !== "object") return null;
  const { start, end } = rule as { start?: unknown; end?: unknown };
  if (typeof start !== "string" || typeof end !== "string") return null;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (
    Number.isNaN(startDate.getTime()) ||
    Number.isNaN(endDate.getTime()) ||
    endDate.getTime() <= startDate.getTime()
  ) {
    return null;
  }
  return { start: startDate, end: endDate };
}

function collectDateRanges(
  rule: unknown,
  out: Array<{ start: Date; end: Date }>,
): void {
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

function readValueLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const candidates: unknown[] = [
    v.title,
    v.name,
    v.label,
    (v.config as Record<string, unknown> | undefined)?.title,
    (v.config as Record<string, unknown> | undefined)?.name,
    (
      (v.config as Record<string, unknown> | undefined)?.typeAlert as
        | Record<string, unknown>
        | undefined
    )?.message,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

function readResolveType(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const rt = (value as { __resolveType?: unknown }).__resolveType;
  return typeof rt === "string" ? rt : null;
}

/**
 * Walk every block in the decofile and emit one ScheduledVariant per
 * (variant, date-matcher) pair. Variants without any date matcher are
 * skipped — those run on every page load (e.g. always/audience-only) and
 * have no place on a time axis.
 */
export function extractScheduledVariants(
  decofile: Record<string, unknown> | null | undefined,
): ScheduledVariant[] {
  if (!decofile) return [];
  const out: ScheduledVariant[] = [];
  for (const [blockKey, block] of Object.entries(decofile)) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const variants = b.variants;
    if (!Array.isArray(variants)) continue;
    // Only treat as a variant container when the block uses the multivariate
    // flag resolver — other blocks may incidentally hold a `variants` field.
    const blockResolveType = b.__resolveType;
    if (
      typeof blockResolveType !== "string" ||
      !FLAG_RESOLVE_TYPES.has(blockResolveType)
    ) {
      continue;
    }
    variants.forEach((variant, variantIndex) => {
      if (!variant || typeof variant !== "object") return;
      const v = variant as Record<string, unknown>;
      const ranges: Array<{ start: Date; end: Date }> = [];
      collectDateRanges(v.rule, ranges);
      if (ranges.length === 0) return;
      const valueLabel = readValueLabel(v.value);
      const resolveType = readResolveType(v.value);
      const label = valueLabel ?? blockKey;
      for (const range of ranges) {
        out.push({
          blockKey,
          variantIndex,
          start: range.start,
          end: range.end,
          label,
          resolveType,
        });
      }
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Deterministic, repo-wide-stable color per block key. Variants from the
 * same block share a color so the calendar reads as "this campaign across
 * its blocks" rather than per-row noise.
 */
export function colorForBlock(blockKey: string): {
  bg: string;
  text: string;
  border: string;
} {
  let hash = 0;
  for (let i = 0; i < blockKey.length; i++) {
    hash = (hash * 31 + blockKey.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return {
    bg: `oklch(0.62 0.14 ${hue})`,
    text: "white",
    border: `oklch(0.50 0.14 ${hue})`,
  };
}
