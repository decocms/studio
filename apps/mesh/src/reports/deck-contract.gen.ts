// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: commerce-discovery/api/diagnostic/deck-contract.ts
// Regenerate: (in the engine repo) bun run gen:deck-contract -- <this dir>

import { z } from "zod";

// ---------------------------------------------------------------------------
// deck-contract — the ONE source of truth for a persisted deck slide.
//
// Historically the slide shape lived FOUR times: the engine's `flatSlide` (the
// LLM-facing flat schema) + `reshape()` (flat → nested), and the LP site's
// `types.ts` union + `normalizeSlide()` drop rules. They drifted. This module is
// the consolidated NESTED shape — exactly what is stored in `section.props` and
// what the site renders — as a Zod schema whose per-template validity rules ARE
// the old `normalizeSlide` drop rules (series needs ≥2 points, arrays non-empty,
// threshold needs a numeric ratio, table cells self-repair, …).
//
// PORTABLE: pure Zod, no engine imports, so `scripts/gen-deck-contract.ts` can
// copy it verbatim into the LP site and BOTH repos validate against the same
// schema.
// ---------------------------------------------------------------------------

const SLIDE_TEMPLATE_KINDS = [
  "cover",
  "series",
  "threshold",
  "stats",
  "bars",
  "gauges",
  "checklist",
  "table",
  "products",
  "list",
  "keywords",
  "competitor",
  "scorecard",
  "cta",
] as const;
export type SlideTemplateKind = (typeof SLIDE_TEMPLATE_KINDS)[number];

const tone = z.enum(["good", "bad", "neutral"]);

// A table cell. Mirrors the engine's `flatSlide` tableCell preprocess (a bare
// scalar or single-element array becomes a text cell) AND the site's repairs
// (a badge reads `.label`, falling back to `.value`; a `score` cell coerces its
// value to a number or degrades to text). One place, both behaviours.
const tableCell = z.preprocess(
  (v) => {
    if (Array.isArray(v)) {
      const scalar = v.find((x) => x !== null && typeof x !== "object");
      return { kind: "text", value: (scalar ?? "") as unknown };
    }
    return v !== null && typeof v === "object"
      ? v
      : { kind: "text", value: v as unknown };
  },
  z
    .object({
      kind: z
        .enum(["text", "number", "sparkline", "badge", "score"])
        .catch("text"),
      value: z.coerce.string().optional(),
      tone: tone.optional(),
      muted: z.boolean().optional(),
      delta: z.coerce.string().optional(),
      deltaDir: z.enum(["up", "down", "neutral"]).optional(),
      points: z.array(z.coerce.number()).optional(),
      label: z.coerce.string().optional(),
    })
    .transform((c) => {
      if (c.kind === "badge" && c.label == null) c.label = c.value ?? "";
      if (c.kind === "score") {
        const n = Number(c.value);
        if (Number.isNaN(n)) return { ...c, kind: "text" as const };
      }
      return c;
    }),
);

const tableRow = z.preprocess((v) => {
  let row = v;
  if (
    row &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    Array.isArray((row as { cells?: unknown }).cells)
  )
    row = (row as { cells: unknown[] }).cells;
  if (Array.isArray(row) && row.length === 1 && Array.isArray(row[0]))
    row = row[0];
  if (Array.isArray(row)) return row;
  if (row && typeof row === "object") return Object.values(row);
  return row;
}, z.array(tableCell));

// ── chrome (present on every slide) ──────────────────────────────────────────
// `key`/`title`/`headline` are always populated by the engine (reshape supplies
// fallbacks); eyebrow/annotation/methodology/sources are optional.
const chrome = {
  key: z.coerce.string(),
  title: z.coerce.string(),
  eyebrow: z.coerce.string().optional(),
  headline: z.coerce.string(),
  annotation: z.coerce.string().optional(),
  methodology: z.coerce.string().optional(),
  sources: z
    .array(z.object({ name: z.coerce.string(), logoUrl: z.coerce.string() }))
    .optional(),
};

// ── per-template body (discriminated on the nested `template` literal) ────────
const body = z.discriminatedUnion("template", [
  // cover / cta: body fields all optional (components default them).
  z.object({
    template: z.literal("cover"),
    score: z
      .object({
        value: z.coerce.number(),
        max: z.coerce.number().optional(),
        grade: z.coerce.string().optional(),
        label: z.coerce.string().optional(),
      })
      .optional(),
    brandImage: z.coerce.string().optional(),
    screenshot: z.coerce.string().optional(),
    mobileScreenshot: z.coerce.string().optional(),
  }),
  z.object({
    template: z.literal("cta"),
    ctaUrl: z.coerce.string().optional(),
    ctaLabel: z.coerce.string().optional(),
    bullets: z.array(z.coerce.string()).optional(),
  }),
  // series: needs ≥2 points, ≥1 label, and a numeric-indexed callout.
  z.object({
    template: z.literal("series"),
    points: z.array(z.coerce.number()).min(2),
    xLabels: z.array(z.coerce.string()).min(1),
    unit: z.coerce.string().optional(),
    callout: z.object({
      index: z.coerce.number(),
      value: z.coerce.string(),
      tone: tone.optional(),
    }),
  }),
  // threshold: needs a numeric ratio; value/thresholdLabel default to "".
  z.object({
    template: z.literal("threshold"),
    value: z.coerce.string().default(""),
    metricLabel: z.coerce.string().optional(),
    ratio: z.coerce.number(),
    thresholdRatio: z.coerce.number().optional(),
    thresholdLabel: z.coerce.string().default(""),
    tone: tone.optional(),
  }),
  z.object({
    template: z.literal("stats"),
    stats: z
      .array(
        z.object({
          value: z.coerce.string(),
          label: z.coerce.string(),
          tone: tone.optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    template: z.literal("bars"),
    items: z
      .array(
        z.object({
          value: z.coerce.string(),
          label: z.coerce.string(),
          ratio: z.coerce.number(),
          tone: tone.optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    template: z.literal("gauges"),
    gauges: z
      .array(
        z.object({
          label: z.coerce.string(),
          value: z.coerce.string(),
          status: z.enum(["good", "warn", "bad"]).catch("warn"),
          caption: z.coerce.string().optional(),
          ratio: z.coerce.number().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    template: z.literal("checklist"),
    checks: z
      .array(
        z.object({
          label: z.coerce.string(),
          status: z.enum(["pass", "fail", "warn"]).catch("fail"),
          value: z.coerce.string().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    template: z.literal("table"),
    columns: z
      .array(
        z.object({
          label: z.coerce.string(),
          align: z.enum(["left", "right"]).optional(),
        }),
      )
      .min(1),
    rows: z.array(tableRow).min(1),
    highlightRow: z.coerce.number().optional(),
  }),
  z.object({
    template: z.literal("products"),
    products: z
      .array(
        z.object({
          name: z.coerce.string(),
          price: z.coerce.string().optional(),
          image: z.coerce.string().optional(),
          url: z.coerce.string().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    template: z.literal("list"),
    entries: z
      .array(
        z.object({
          label: z.coerce.string(),
          severity: z.enum(["error", "warning", "notice"]).catch("notice"),
        }),
      )
      .min(1),
    moreCount: z.coerce.number().optional(),
  }),
  z.object({
    template: z.literal("keywords"),
    volumeLabel: z.coerce.string().optional(),
    keywords: z
      .array(
        z.object({
          term: z.coerce.string(),
          volume: z.coerce.string(),
          position: z.coerce.number().catch(0),
        }),
      )
      .min(1),
  }),
  z.object({
    template: z.literal("competitor"),
    metricLabel: z.coerce.string().optional(),
    competitors: z
      .array(
        z.object({
          name: z.coerce.string(),
          value: z.coerce.string(),
          tone: tone.optional(),
          isYou: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    template: z.literal("scorecard"),
    rivalLabel: z.coerce.string().optional(),
    dimensions: z
      .array(
        z.object({
          label: z.coerce.string(),
          you: z.coerce.string(),
          rival: z.coerce.string().optional(),
          rivalName: z.coerce.string().optional(),
          tone: tone.optional(),
        }),
      )
      .min(1),
  }),
]);

/** A single persisted deck slide (chrome + one discriminated template body). */
export const DeckSlideContract = z.object({ ...chrome, template: body });

export type DeckSlide = z.infer<typeof DeckSlideContract>;
