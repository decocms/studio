// ─────────────────────────────────────────────────────────────────────────────
// Signal Deck — template contract
//
// This is the shape the report builder (and, later, the LLM) emits. A deck is a
// list of slides; each slide names ONE `template` and carries only the data that
// template needs. Adding a new way to show data = add a variant to `SlideTemplate`
// + a renderer in registry.tsx. See DECK-MODEL.md for the selection pipeline.
//
// Today's templates:
//   • cover   — opening verdict + health score
//   • series  — a trend line chart with one highlighted callout  ← "the simple graph one"
//
// (delta · list · grid · gauge · bignum come next; the union is the extension point.)
// ─────────────────────────────────────────────────────────────────────────────

/** Tone of a callout / metric — drives line, fill and number colour. */
export type Tone = "good" | "bad" | "neutral";

/** Opening slide: the verdict + the headline health score. */
export interface CoverTemplate {
  template: "cover";
  /** Optional overall health score footnote (e.g. 67 / 100 · grade D). */
  score?: { value: number; max?: number; grade?: string; label?: string };
  /** Optional brand wordmark/logo rendered under the headline. */
  brandImage?: string;
  /** Optional desktop homepage screenshot shown in the device cluster. */
  screenshot?: string;
  /** Optional mobile homepage screenshot for the overlapping phone. */
  mobileScreenshot?: string;
  /** Top findings shown as clickable rows on the cover. `slideKey` must match a `DeckSlide.key`. */
  findings?: { title: string; slideKey: string }[];
}

/**
 * Trend line chart with one highlighted point and a big callout number.
 * Chosen when the evidence is a time series (latency, traffic, CR over time…).
 */
export interface SeriesTemplate {
  template: "series";
  /** y-values, evenly distributed left→right across the chart width. */
  points: number[];
  /** x-axis tick labels, spaced across the full width (e.g. Mar / Abr / Mai / Jun). */
  xLabels: string[];
  /** Optional unit appended to values in the hover tooltip (e.g. "ms", "visits"). */
  unit?: string;
  /** The highlighted data point and its oversized callout. */
  callout: {
    /** Index into `points` where the indicator + dot sit. */
    index: number;
    /** The big number/word, e.g. "3x" or "3.7s". */
    value: string;
    tone?: Tone;
  };
}

/**
 * One metric measured against a "good" threshold, shown as a segmented bar
 * (à la Core Web Vitals). Chosen when the evidence is a single value vs a limit.
 */
export interface ThresholdTemplate {
  template: "threshold";
  /** The big metric, e.g. "3.7s". */
  value: string;
  /** Small label under the value, e.g. "LCP". */
  metricLabel?: string;
  /** How far the metric fills the bar, 0..1. */
  ratio: number;
  /** Where the "good" marker line sits, 0..1. Defaults to `ratio`. */
  thresholdRatio?: number;
  /** Label under the marker, e.g. "good ≤ 2.5s". */
  thresholdLabel: string;
  /** Colour of the filled cells (bad = red). */
  tone?: Tone;
}

/** A grid of headline metrics — several big values, each with a label. */
export interface StatsTemplate {
  template: "stats";
  /** `sub` is an optional context line under the label (e.g. "meta: ≤ 2,5s"). */
  stats: { value: string; label: string; tone?: Tone; sub?: string }[];
}

/** Compares a few values as proportional vertical bars (height ∝ `ratio`). */
export interface BarsTemplate {
  template: "bars";
  items: { value: string; label: string; ratio: number; tone?: Tone }[];
}

/** Several metrics vs good/needs-work/poor bands — each a segmented track with
 *  the value marked in place. For Core Web Vitals + similar threshold sets. */
export interface GaugesTemplate {
  template: "gauges";
  /** `ratio` (0–1) positions the marker; defaults from `status` if omitted.
   *  `caption` is the threshold note, e.g. "bom ≤ 2,5s". */
  gauges: {
    label: string;
    value: string;
    status: "good" | "warn" | "bad";
    caption?: string;
    ratio?: number;
  }[];
}

export interface TableColumn {
  label: string;
  /** Numeric columns should be right-aligned. Defaults to "left". */
  align?: "left" | "right";
}

export interface TextCell {
  kind: "text";
  value: string;
  tone?: Tone;
  muted?: boolean;
}

export interface NumberCell {
  kind: "number";
  value: string;
  /** E.g. "+12%" or "−0.3s". */
  delta?: string;
  /** Which direction the delta points — drives colour and arrow. */
  deltaDir?: "up" | "down" | "neutral";
  tone?: Tone;
  muted?: boolean;
}

export interface SparklineCell {
  kind: "sparkline";
  /** Normalised 0–1 values rendered as a tiny inline bar chart. */
  points: number[];
  tone?: Tone;
}

export interface BadgeCell {
  kind: "badge";
  label: string;
  tone?: Tone;
}

export interface ScoreCell {
  kind: "score";
  /** 0–100. */
  value: number;
  tone?: Tone;
}

export type TableCell =
  | TextCell
  | NumberCell
  | SparklineCell
  | BadgeCell
  | ScoreCell;
/** A data table — ranked rows of cells. Chosen for ranked collections. */
export interface TableTemplate {
  template: "table";
  columns: TableColumn[];
  /** Each row is a list of cells, aligned to `columns` by index. */
  rows: TableCell[][];
  /** Optional row index to emphasise. */
  highlightRow?: number;
}

/** A pass/fail probe set — one check per row with a status icon + observed value.
 *  For presence/absence findings (security headers, cache, schema, robots). */
export interface ChecklistTemplate {
  template: "checklist";
  checks: { label: string; status: "pass" | "fail" | "warn"; value?: string }[];
}

/** Closing "minor signals" list — one client-language claim per row + severity.
 *  Replaces the old multi-column table for the SILVER+ZINC round-up. */
export interface ListTemplate {
  template: "list";
  entries: { label: string; severity: "error" | "warning" | "notice" }[];
  /** Count of further signals surfaced only in the full report — drives the
   *  anxious "+XX" tally. Injected by the engine from the scan totals. */
  moreCount?: number;
}

/** A ranked table of the store's organic keywords: term, monthly search volume,
 *  and current SERP position. For "where do you actually rank" slides — replaces
 *  cramming a couple of keyword ranks into big stat tiles. */
export interface KeywordsTemplate {
  template: "keywords";
  /** Header label for the volume column. Defaults to "Buscas/mês". */
  volumeLabel?: string;
  /** Rows, ordered highest-volume first. `position` is the SERP rank (0/absent = not ranking). */
  keywords: { term: string; volume: string; position: number }[];
}

/** Best-sellers showcase — the store's top products as a thumbnail gallery.
 *  Replaces the plain text `table` for the merchandising/assortment read. */
export interface ProductsTemplate {
  template: "products";
  /** Ordered best→worst. `image`/`url` are optional; a missing/broken image
   *  falls back to a neutral placeholder tile. */
  products: { name: string; price?: string; image?: string; url?: string }[];
}

/** Consolidated competitive posture — one row per discovery dimension, each
 *  with your value vs the leading rival's, and a tone for where you stand. */
export interface ScorecardTemplate {
  template: "scorecard";
  /** Header for the rival column. Defaults to "Concorrente líder". */
  rivalLabel?: string;
  /** `rival`/`rivalName` omitted → the UI shows "—" (never a fabricated number).
   *  `tone`: bad = rival leads you, good = you lead, neutral otherwise. */
  dimensions: {
    label: string;
    you: string;
    rival?: string;
    rivalName?: string;
    tone?: Tone;
  }[];
}

/** Ranks the scanned store against named competitors on ONE metric. */
export interface CompetitorTemplate {
  template: "competitor";
  /** The metric being compared, e.g. "Visibilidade em IA". */
  metricLabel?: string;
  /** Rows ordered best→worst; the scanned store carries `isYou`. */
  competitors: { name: string; value: string; tone?: Tone; isYou?: boolean }[];
}

/** Closing call-to-action slide — always the last slide in the deck. */
export interface CtaTemplate {
  template: "cta";
  /** Where the primary button links. */
  ctaUrl?: string;
  /** Override the default button label. */
  ctaLabel?: string;
  /** Short benefit bullets shown under the headline. */
  bullets?: string[];
}

/** Discriminated union of every slide template the deck can render. */
export type SlideTemplate =
  | CoverTemplate
  | SeriesTemplate
  | ThresholdTemplate
  | StatsTemplate
  | BarsTemplate
  | GaugesTemplate
  | ChecklistTemplate
  | TableTemplate
  | ListTemplate
  | KeywordsTemplate
  | ProductsTemplate
  | ScorecardTemplate
  | CompetitorTemplate
  | CtaTemplate;

/** Slide-level chrome passed into every content template. */
export interface CommonSlideProps {
  /** Small label above the headline (usually the scanned url). */
  eyebrow?: string;
  /** The big line(s). `\n` splits into stacked lines. */
  headline: string;
  /** Optional text anchored to the right side of the headline row. */
  annotation?: string;
  /** True while this slide is the one on screen — gates entrance animations. */
  active?: boolean;
}

// Each template renders from its OWN typed props (the template data + the
// shared chrome), so a template can be used directly — not only via the deck.
// Derived from the data contracts above, so there's a single source of truth.
export type SeriesProps = Omit<SeriesTemplate, "template"> & CommonSlideProps;
export type ThresholdProps = Omit<ThresholdTemplate, "template"> &
  CommonSlideProps;
export type StatsProps = Omit<StatsTemplate, "template"> & CommonSlideProps;
export type BarsProps = Omit<BarsTemplate, "template"> & CommonSlideProps;
export type GaugesProps = Omit<GaugesTemplate, "template"> & CommonSlideProps;
export type TableProps = Omit<TableTemplate, "template"> & CommonSlideProps;
export type CoverProps = Omit<CoverTemplate, "template" | "findings"> &
  CommonSlideProps & {
    /** The report's chapters, as clickable rows. `locked` marks a chapter the
     *  current visitor can't reach yet (the deck was truncated for logged-out
     *  callers) — it still shows, it just prompts sign-in. */
    findings?: { title: string; slideKey: string; locked?: boolean }[];
    faviconUrl: string;
    domain: string;
    brand: string;
    /** Single-char favicon fallback. */
    initial: string;
    /** The report's macro themes (from deck.meta.scores.categories) — the
     *  breakdown under the headline score. */
    areas?: DeckScores["categories"];
    /** ISO scan timestamp, from deck.meta.scannedAt. */
    scannedAt?: string | null;
    /** True while on screen — gates the score count-up. */
    active?: boolean;
    /** Jump to the slide with the given key. Wired by the deck shell. */
    onFindingClick?: (slideKey: string) => void;
    /** Open the report at its first chapter (or prompt sign-in when gated). */
    onStart?: () => void;
  };

export type ChecklistProps = Omit<ChecklistTemplate, "template"> &
  CommonSlideProps;

export type ListProps = Omit<ListTemplate, "template"> &
  CommonSlideProps & {
    /** Scanned store domain — fallback onboarding link when `onNext` is absent. */
    domain: string;
    /** Advance to the next slide — the list fades out and this CTA continues. */
    onNext?: () => void;
  };

export type KeywordsProps = Omit<KeywordsTemplate, "template"> &
  CommonSlideProps;

export type ProductsProps = Omit<ProductsTemplate, "template"> &
  CommonSlideProps;

export type ScorecardProps = Omit<ScorecardTemplate, "template"> &
  CommonSlideProps & {
    /** Scanned store favicon, shown on the "você" side of each head-to-head. */
    faviconUrl: string;
  };

export type CompetitorProps = Omit<CompetitorTemplate, "template"> &
  CommonSlideProps & {
    faviconUrl: string;
    domain: string;
  };

export type CtaProps = Omit<CtaTemplate, "template"> &
  CommonSlideProps & {
    faviconUrl: string;
    domain: string;
    brand: string;
    initial: string;
    /** Coverage from the engine (checks probed / total). Absent on cached
     *  reports that predate deterministic scores — the count pill hides then. */
    checksProbed?: number;
    checksTotal?: number;
  };

/** A data source credited on a slide (logo + name). Rendered as a pill in the
 *  slide's attribution footer, next to "Como medimos" / "A IA errou?". Supplied
 *  by the engine per finding (e.g. Chrome DevTools, CrUX, SEMrush). */
export interface SlideSource {
  name: string;
  logoUrl: string;
}

/** A single slide: deck-level chrome (eyebrow/headline) + one template body. */
export interface DeckSlide {
  /** Stable id — used for nav, share anchors and analytics labels. */
  key: string;
  /** Short label for the progress rail tooltip + analytics. */
  title: string;
  /** Small label above the headline (usually the scanned url). */
  eyebrow?: string;
  /** The big line(s). `\n` splits into stacked lines. */
  headline: string;
  /** Optional text anchored to the right side of the headline row. */
  annotation?: string;
  /** Short explanation of the data source shown in the "Como medimos" footer tooltip. */
  methodology?: string;
  /** Data sources credited for this slide's finding — shown as pills in the footer. */
  sources?: SlideSource[];
  template: SlideTemplate;
}

/** Deterministic scores computed by the engine aggregate (severity-weighted cover
 *  ring, per-domain scores, and coverage honesty). Optional — cached reports
 *  predate the field. */
export interface DeckScores {
  cover: number;
  by_domain: { domain: string; score: number }[];
  /** Per-macro-theme health: the engine's aggregate categories. `score` is
   *  severity-weighted from the verdicts in the theme (NOT an average of
   *  `by_domain`), and pass/fail/blocked are its coverage. Absent on cached
   *  reports that predate the field. `key` is stable and localizable; `label`
   *  is the engine's own reader-facing wording, baked at generation time. */
  categories?: {
    key: string;
    label: string;
    score: number;
    pass: number;
    fail: number;
    blocked: number;
  }[];
  coverage: {
    checks_probed: number;
    checks_total: number;
    by_value_driver: {
      value_driver: string;
      probed: number;
      blocked: number;
      total: number;
    }[];
  };
}

/** Deck-level metadata shared by the chrome (header / footer / share). */
export interface DeckMeta {
  url: string;
  domain: string;
  brand: string;
  /** Single-char fallback when the favicon fails to load. */
  initial: string;
  faviconUrl: string;
  /** Brand palette hexes (up to 6), from brand_identity.visual.colors. */
  colors?: string[];
  /** Deterministic scores (cover ring, coverage honesty) for cover chips + footer. */
  scores?: DeckScores;
  /** When the scan behind this deck ran (ISO). Dated reports read as evidence. */
  scannedAt?: string | null;
  /** Every content chapter in the report, in order (cover + closing cta
   *  excluded). Lives on `meta`, not derived from `slides`, so it survives the
   *  unauthenticated truncation to a single slide — the cover's table of
   *  contents is the whole reason a visitor signs in, so it must never vanish
   *  exactly when they're logged out. */
  toc?: { key: string; title: string }[];
}

export interface TemplateDeck {
  meta: DeckMeta;
  slides: DeckSlide[];
}

/** Props every template body receives from the deck shell. */
export interface TemplateProps {
  slide: DeckSlide;
  deck: TemplateDeck;
  /** True while this slide is the one on screen — gates entrance animations. */
  active: boolean;
  /** Navigate to the slide with the given key. Provided by the deck shell. */
  onNavigate?: (slideKey: string) => void;
}
