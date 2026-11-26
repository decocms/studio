/**
 * Contract of the UI/UX diagnosis ("PDP Optimizer"). Snake_case because these
 * types are persisted, passed between Workflow steps and read by the SPA.
 */

import type { UxClaimLabel } from "./claims.ts";
import type { ExperimentDesign } from "./experiment.ts";
import type { UxFact } from "./facts.ts";
import type {
  HypothesisValidation,
  Lifecycle,
  LifecycleEntry,
  OpportunityOutcome,
} from "./lifecycle.ts";
import type { MeasuredMetric, UxMetricRef } from "./metrics.ts";
import type { HypothesisPriority } from "./priority.ts";
import type { ProbeResult } from "./probes.ts";
import type { HypothesisRelevance } from "./relevance.ts";
import type { DataReliability } from "./reliability.ts";
import type { HypothesisReview } from "./review.ts";
import type { Drilldown } from "./segments.ts";
import type {
  DiscardedCategory,
  HypothesisCategory,
  HypothesisTree,
} from "./tree.ts";
import type { HypothesisVerification } from "./verify/types.ts";

/** The page type a diagnosis analyzes (page-types.ts). */
export type UxPageType =
  | "home"
  | "categoria"
  | "busca"
  | "pdp"
  | "carrinho_checkout";

/** A part measured on the real page, for any page type (page-types.ts). */
export type UxPart =
  // PDP
  | "price"
  | "size_selector"
  | "buy_button"
  | "shipping"
  | "first_recommendation"
  // home
  | "hero"
  | "first_shelf"
  | "first_product"
  | "search_entry"
  | "menu_button"
  // category and search
  | "page_title"
  | "filter_button"
  | "sort_button"
  | "first_card"
  | "load_more"
  | "results_count"
  | "search_field";

/** Analytics routes per page type (the heatmap `page`), read from `hmPages`. */
export interface PageTemplates {
  home: string | null;
  busca: string | null;
  categoria: string[];
  detected_at: string;
}

export type UxDevice = "mobile" | "desktop";

// ── Store profile ────────────────────────────────────────────────────────────

/** Configuration of the analyzed store; nothing store-specific lives in code. */
export interface SiteProfile {
  /** Public domain of the store, without protocol (`www.loja.example`). */
  domain: string;
  /** Site slug in Deco Analytics. NULL = use the org slug. */
  studio_site: string | null;
  /** PDP route template in Deco Analytics (`/:product/p` on a VTEX store). */
  pdp_path_template: string;
  /** Home, search and category routes. NULL = not detected yet. */
  page_templates?: PageTemplates | null;
  /** Benchmark competitors; empty means the next analysis picks them again. */
  competitors: string[];
  /** When the customer confirmed the list; once set, the engine neither rewrites nor completes it. */
  competitors_confirmed_at: string | null;
  design_system: DesignSystem | null;
  design_system_at: string | null;
  /** Theme as named by the store's code; kept apart from `design_system`. */
  code_tokens: CodeTokens | null;
  /** Where each field came from (Studio, binding…). NULL = old manual profile. */
  sources: SiteSources | null;
  /** Repo for "view in code" ("owner/name") when the detected one is not in production. */
  code_repo: string | null;
  /** Studio site project where "view in code" opens the sandbox. NULL = off. */
  code_project_id: string | null;
  /** Volume of the repo mirror in the org-fs. NULL = no mirror. */
  code_volume: string | null;
  updated_at: string;
}

/** What the diagnosis found on its own in Studio; nothing here was typed by a person. */
export interface SiteSources {
  detected_at: string;
  /** The site's Virtual MCP in Studio (metadata.siteSlug). */
  studio_project: {
    id: string;
    title: string;
    site_slug: string;
    domain: string | null;
    runtime: string | null;
  } | null;
  /** The site project's repository (`metadata.repository`); no provider and host means GitHub. */
  repository: {
    owner: string;
    name: string;
    /** The project's `mcp-github` connection, when there is one. */
    connection_id: string | null;
    provider?: "github" | "gitlab" | "bitbucket";
    host?: string;
    /** The repository id in Studio (`repositoryId`), when the project has one. */
    repository_id?: string;
  } | null;
  /** Source read errors, so the screen can say what was missing. */
  errors: string[];
}

export interface TextStyle {
  font_family: string;
  font_size: string;
  font_weight: string;
  line_height: string;
  letter_spacing: string;
  text_transform: string;
  color: string;
}

export interface BoxStyle extends TextStyle {
  background: string;
  border: string;
  border_radius: string;
  padding: string;
  height: string;
  /** CSS selector of the element the style was read from (to reproduce it). */
  selector: string;
  /** Visible text of the element, so a person can recognize what it is. */
  sample_text: string;
}

/** The store's design system, read from the live site so the mockup uses only real tokens. */
export interface DesignSystem {
  source_url: string;
  captured_at: string;
  /** Custom properties of `:root`, most used first. */
  css_variables: Record<string, string>;
  /** Colors by frequency of use in text, background and border. */
  palette: Array<{ color: string; uses: number }>;
  fonts: string[];
  typography: {
    body: TextStyle | null;
    heading: TextStyle | null;
    price: TextStyle | null;
    link: TextStyle | null;
  };
  components: {
    primary_button: BoxStyle | null;
    secondary_button: BoxStyle | null;
    size_chip: BoxStyle | null;
    badge: BoxStyle | null;
    input: BoxStyle | null;
  };
  radii: string[];
  spacing: string[];
  /** Screenshot of the purchase block (price, size, button), in R2. */
  buy_box_url: string | null;
}

/** Theme read from the store's repository (code-tokens.ts). */
export interface CodeTokens {
  /** `owner/repo` (Studio repository path) or `<volume>@<org>` (org-fs mirror). */
  repo: string;
  /** The read time (neither path exposes the commit). */
  commit: string | null;
  read_at: string;
  files: string[];
  /** `--var: value` declarations from the entry CSS files, no model. */
  css_variables: Record<string, string>;
  /** Props of the `site.json` Theme sections (deco), `group.key → value`. */
  theme: Record<string, string>;
  colors: Array<{ name: string; value: string; usage: string }>;
  fonts: Array<{ name: string; family: string }>;
  radii: Array<{ name: string; value: string }>;
  /** Stack and how button/chip/price are written with the store's classes. */
  conventions: string | null;
  /** The model failed: only the deterministic part came out. */
  model_error?: string;
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/** A source that did not respond. It goes into the report: a named hole. */
export interface SourceGap {
  source:
    | "lake"
    | "heatmap"
    | "bigquery"
    | "vtex"
    | "browser"
    | "benchmark"
    | "studio"
    | "github";
  error: string;
  /** What the customer must provide to close the gap (with `owner: "customer"`). */
  key?: SetupKey;
  /** Who closes the gap. Absent = us. */
  owner?: GapOwner;
}

/** What Plan asks of the customer, in this order. */
export type SetupKey =
  | "domain"
  | "competitors"
  | "analytics_install"
  | "bigquery"
  | "orders"
  /** Link the site repository in Studio, or reconnect its provider. */
  | "repository";

/** The customer, us, or a third party (site that blocks bots, public VTEX). */
export type GapOwner = "customer" | "ours" | "external";

/** GA4 funnel per platform (web, iOS, Android), event counts. */
export interface PlatformFunnel {
  platform: string;
  steps: Array<{ event: string; count: number }>;
}

/** How the GA4 funnel is sliced. */
export type SegmentDim = "canal" | "visitante" | "dia";

/** A platform's funnel within a slice (channel, new vs returning users, or a day). */
export interface FunnelSegment {
  dim: SegmentDim;
  key: string;
  platform: string;
  steps: Array<{ event: string; count: number }>;
}

/** A route's GA4 funnel, per device (distinct users). */
export interface Ga4PageFunnel {
  route: string;
  by_device: Array<{
    device: UxDevice;
    visitors: number;
    viewed: number;
    carted: number;
  }>;
}

/** PDP slice on a device, read from Deco Analytics. */
export interface DevicePdpBehaviour {
  device: UxDevice;
  views: number;
  /** Average scroll, % of page height. */
  avg_depth_pct: number;
  /** How much of the page fits in the first screen, %. */
  avg_fold_pct: number;
  active_seconds: number;
  clicks: number;
  dead_clicks: number;
  /** % of visitors who reach 25/50/75% of the page. */
  reach: { p25: number; p50: number; p75: number };
  /** % of visitors who reach each depth, in 5% steps (0, 5, …, 100). */
  scroll_curve?: Array<{ depth: number; reach_pct: number }>;
  /** Page funnel: entered → saw product → added to cart. */
  funnel: { visitors: number; viewed: number; carted: number } | null;
  /** Visual sections of the page with reach, time and click. */
  sections: Array<{
    section: string;
    reach_pct: number;
    avg_seconds: number;
    ctr_pct: number;
    clicks: number;
  }>;
  /** Elements concentrating the most clicks or dead clicks. */
  elements?: PdpElementStat[];
}

/** A clicked PDP element from Deco Analytics; `root` + `el` is the collector's identity. */
export interface PdpElementStat {
  root: string;
  /** Hash of the element, in decimal (the way Studio returns it). */
  el: string;
  /** The section, without prefix or extension ("Product/ProductDetails"). */
  section: string;
  clicks: number;
  /** Clicks with no page reaction within 1 s. */
  dead: number;
  /** Of the dead clicks, those that landed on a clickable element (button, link). */
  dead_interactive: number;
  /** Who clicked here and how many of them added to cart. NULL = no funnel. */
  funnel: { visitors: number; carted: number } | null;
}

export interface RevenueBase {
  window_days: number;
  /** By sales channel (VTEX sales channel). */
  by_channel: Array<{
    channel: string;
    orders: number;
    revenue: number;
    avg_ticket: number;
  }>;
  currency: string | null;
}

/** A product that draws traffic and does not sell — the input of the PDP queue. */
export interface ProductSignal {
  product_id: string;
  name: string;
  url: string | null;
  views: number;
  orders: number;
  /** Orders per thousand views. */
  orders_per_1k_views: number;
  availability: "alive" | "sold_out" | "broken_grid" | "unknown";
  available_skus: number;
  total_skus: number;
  reason:
    | "esgotado_com_trafego"
    | "grade_quebrada"
    | "nao_convence"
    | "converte_e_ninguem_ve";
}

/** Measures of a real page on a device, taken in the browser. */
export interface PageCapture {
  device: UxDevice;
  /** Type of the captured page. Absent = PDP. */
  page_type?: UxPageType;
  url: string;
  product_id: string | null;
  viewport: { width: number; height: number };
  page_height: number;
  fold_url: string | null;
  full_url: string | null;
  /** Position (px from the top) of the parts that matter for this page type. NULL = not found. */
  positions: Partial<Record<UxPart, number | null>>;
  /** Is there a purchase bar that stays fixed on scroll? */
  has_sticky_buy: boolean;
  /** The page mentions sold out/unavailable/notify-me. */
  sold_out_signal: boolean;
  /** Textual sketch of what shows in the first screen. */
  above_fold_outline: string[];
  /** CSS selectors of the measured elements — the mockup uses them to know where to change. */
  selectors: Partial<Record<UxPart, string | null>>;
  /** Non-PDP page facts as numbers or yes/no (cards per row, total results…). */
  facts?: Record<string, number | boolean | string | null>;
  /** Summarized HTML of the page body, with the store's real classes. */
  dom_excerpt: string;
  /** Stock of the captured product; a sold-out PDP renders differently. NULL = unknown. */
  stock?: ProductSignal["availability"] | null;
  /**
  /** `root|el` → what that element is on this page. */
  element_labels?: Record<string, ElementLabel>;
}

export interface ElementLabel {
  /** `button "comprar"`, `label "PP"`, `img "Vestido..."`. */
  label: string;
  /** Top of the element, px from the top of the document. */
  y: number;
  /** Where the click leads, if it changes page; a dead click here is usually a slow navigation. */
  navigates?: string;
  /** Not visible on load: it sits in a panel another click opens. The y does not apply. */
  hidden?: boolean;
}

/** A competitor page read for the benchmark, of the same type as the analyzed one. */
export interface BenchmarkPdp {
  domain: string;
  /** Type of the captured page. Absent = PDP. */
  page_type?: UxPageType;
  url: string;
  screenshot_url: string | null;
  /** Full page on mobile (cut at the model's ceiling). NULL = old cache. */
  full_url: string | null;
  anatomy: {
    sticky_buy: boolean | null;
    size_above_fold: boolean | null;
    price_above_fold: boolean | null;
    shipping_estimate: boolean | null;
    wishlist: boolean | null;
    recommendation_position: string | null;
    notes: string;
    /** What the PDP does in each part, in one sentence read from the screenshot. */
    by_area?: Partial<Record<UxArea, string>>;
  };
  captured_at: string;
}

export interface DiagnosisEvidence {
  window_days: number;
  platform_funnel: PlatformFunnel[];
  /** GA4 funnel slices. Absent = the query failed or this predates them. */
  segments?: FunnelSegment[];
  /** Behaviour of the analyzed page in Deco Analytics. Empty on cart/checkout. */
  pdp_behaviour: DevicePdpBehaviour[];
  /** Type of the analyzed page. Absent = PDP. */
  page_type?: UxPageType;
  /** The heatmap route read (`/buscar`, `/produtos/vestido`). */
  page_route?: string | null;
  /** This page type's routes with views and scroll (the most viewed categories). */
  routes?: Array<{ page: string; views: number; avg_depth: number }>;
  /** Search: the term the capture searched. */
  search_term?: string;
  /** The analyzed page's GA4 funnel, for stores that do not send these events to Deco Analytics. */
  ga4_page_funnel?: Ga4PageFunnel;
  revenue: RevenueBase | null;
  products: ProductSignal[];
  captures: PageCapture[];
  benchmark: BenchmarkPdp[];
  gaps: SourceGap[];
  /** R2 key of the repo snapshot (`<org>/private/ux/<id>/repo.json`); absent = not read. */
  repo_snapshot_key?: string | null;
  /** The facts ledger (facts.ts), stored so a hypothesis's F12 is the same fact everywhere. */
  facts?: UxFact[];
  /** Probes (probes.ts): overlays over the first screen and taps on dead-click elements. */
  probes?: ProbeResult[];
}

// ── Opportunities ────────────────────────────────────────────────────────────

/** Where the opportunity lives: a part of the analyzed page, the whole page or another page. */
export type UxArea =
  // home
  | "home_destaque"
  | "home_vitrines"
  | "menu_busca"
  // category
  | "topo_categoria"
  | "card_produto"
  | "filtros_ordenacao"
  | "paginacao"
  // search
  | "campo_busca"
  | "resultados_busca"
  | "busca_sem_resultado"
  // cart and checkout (data only)
  | "carrinho"
  | "checkout"
  // PDP
  | "galeria"
  | "titulo_preco"
  | "tamanho"
  | "botao_compra"
  | "frete_entrega"
  | "descricao"
  | "leve_o_look"
  | "recomendacoes"
  | "confianca"
  | "pagina_geral"
  | "navegacao"
  | "carrinho_checkout";

/** Source of a cited number. Only a source that responded in this analysis counts. */
export type UxSourceKind =
  | "ga4"
  | "deco_analytics"
  | "vtex"
  | "pagina"
  | "benchmark";

/** A data point of the "based on": GA4 · view→cart on mobile · 11.1% · 7 days. */
export interface UxSourceRef {
  source: UxSourceKind;
  metric: string;
  /** Always with a number. */
  value: string;
  window: string | null;
  /** Observed fact or indirect evidence (claims.ts). Absent = older evidence. */
  label?: UxClaimLabel;
}

/** An observation of the opportunity and the facts it cites (F12…). */
export interface UxObservation {
  text: string;
  facts: string[];
}

/** A PDP opportunity: the problem, named as a conclusion, and the data that shows it. */
export interface UxOpportunity {
  id: string;
  diagnosis_id: string;
  rank: number;
  area: UxArea;
  /** The measured loss in one sentence, assembled in code (losses.ts). Never the cause. */
  title: string;
  /** One or two sentences. */
  summary: string;
  device: UxDevice | "ambos";
  sources: UxSourceRef[];
  /** NULL = no valid calculation; the opportunity stays, just without value. */
  money: MoneyEstimate | null;
  confidence: number;
  /** The funnel stage the problem affects (the model chooses). NULL = none. */
  metric?: UxMetricRef | null;
  /** The stage measured in code from this analysis's data. NULL = could not. */
  measured?: MeasuredMetric | null;
  /** "Can this data be trusted?" (reliability.ts). NULL = older evidence. */
  reliability?: DataReliability | null;
  /** "Does the gap repeat?" across GA4 slices (segments.ts). NULL = no slice. */
  drilldown?: Drilldown | null;
  /** The tree categories that did not become a hypothesis, and why. */
  tree_notes?: DiscardedCategory[] | null;
  /** Why the investigation stopped (lifecycle.ts). NULL = still running or old. */
  outcome?: OpportunityOutcome | null;
  /** What the model saw that may explain the loss; each cites the facts (facts.ts) supporting it. */
  observations?: UxObservation[] | null;
  updated_at: string;
}

/** An opportunity before it is saved: the id comes from its diagnosis and rank. */
export type OpportunityDraft = Omit<
  UxOpportunity,
  "id" | "diagnosis_id" | "updated_at"
>;

/** A store captured in the benchmark that already does what the hypothesis proposes. */
export interface HypothesisBenchmark {
  domain: string;
  url: string | null;
  what_they_do: string;
}

// ── Hypotheses ───────────────────────────────────────────────────────────────

/** The money calculation: the total gap is only a ceiling; the promise is a small, named delta. */
export interface MoneyEstimate {
  /** In words: "1 more point in view→cart on mobile". */
  assumption: string;
  /** Base (people or events per month) the delta acts on. */
  base: number;
  base_label: string;
  /** Delta in percentage points. */
  delta_pp: number;
  /** Value of each extra event, in currency. */
  value_per_event: number;
  value_label: string;
  /** base × delta × value, per month. */
  monthly_value: number;
  /** Ceiling: the whole gap, if the change closed everything. Reference only. */
  ceiling_monthly: number | null;
  /** Fraction of the channel where the change applies (site ≈ 1/3 in a fashion store). */
  channel_share: number;
}

export type HypothesisStatus = "pending" | "approved" | "dismissed";

export type HypothesisKind = "proposta" | "nao_faria";

/** A hypothesis of the WHY of an opportunity: cause (`title` + `why`), signals, idea and benchmark. */
export interface UxHypothesis {
  id: string;
  diagnosis_id: string;
  /** NULL = v1, or "what I would not do now". */
  opportunity_id: string | null;
  rank: number;
  kind: HypothesisKind;
  /** The title is the conclusion ("Fixed purchase bar on mobile"). */
  title: string;
  device: UxDevice | "ambos";
  /** What the data shows — short markdown, with numbers. */
  evidence_md: string;
  idea: string;
  why: string;
  /** Where to change: component/section of the page. */
  where: string;
  money: MoneyEstimate | null;
  /** 0–1: how strong the evidence is. */
  confidence: number;
  /** Benchmark domains that already do this (v1). */
  benchmark_refs: string[];
  /** Captured stores that already do this, and how (v2). */
  benchmark: HypothesisBenchmark[];
  before_url: string | null;
  after_url: string | null;
  /** HTML/CSS injected into the real page to generate the "After". */
  after_patch: string | null;
  mockup_error: string | null;
  status: HypothesisStatus;
  status_note: string | null;
  /** "View in code" (off in this engine). NULL = never requested. */
  code_status: CodeMockupStatus | null;
  code_note: string | null;
  code_before_url: string | null;
  code_after_url: string | null;
  /** `git diff` of the change in the store's repo that produced the After. */
  code_diff: string | null;
  code_error: string | null;
  code_started_at: string | null;
  /** Verifier result. NULL = never verified. */
  verification: HypothesisVerification | null;
  /** Category in the tree (tree.ts). Absent = older evidence. */
  category?: HypothesisCategory | null;
  /** "If…, then…, because…", for/against, how to refute. Absent = older evidence. */
  tree?: HypothesisTree | null;
  /** Where the evidence got to (lifecycle.ts). Read from the verdict on old ones. */
  lifecycle?: Lifecycle;
  lifecycle_log?: LifecycleEntry[];
  /** The four levels: it exists, it is in the code, it matters, it is the cause. */
  validation?: HypothesisValidation | null;
  /** How many people the change reaches (relevance.ts). NULL = not evaluated. */
  relevance?: HypothesisRelevance | null;
  /** The recommended A/B (experiment.ts). NULL = no relevance or no baseline. */
  experiment?: ExperimentDesign | null;
  /** Investigation and test priority (priority.ts). */
  priority?: HypothesisPriority | null;
  /** Independent review (review.ts). NULL = not reviewed. */
  review?: HypothesisReview | null;
  updated_at: string;
}

export type CodeMockupStatus = "running" | "done" | "error";

// ── Diagnosis ────────────────────────────────────────────────────────────────

export type DiagnosisStatus = "running" | "done" | "error";

export type DiagnosisStage =
  | "queued"
  | "collect"
  | "capture"
  | "benchmark"
  | "opportunities"
  | "hypotheses"
  | "verify"
  /** How many people each change reaches (relevance.ts). */
  | "relevance"
  /** v1 only: old diagnoses stopped here. */
  | "mockups"
  | "done";

export interface DiagnosisSummary {
  /** Two or three sentences: where the money is. */
  headline: string;
  /** Limits of the analysis (association ≠ cause, sources that were missing). */
  limits: string[];
  /** opportunity id → why its hypotheses did not come out. */
  hypothesis_notes?: Record<string, string>;
  /** Hypotheses the verification disproved, kept with the proof. */
  refuted?: RefutedHypothesis[];
}

export interface RefutedHypothesis {
  opportunity_title: string;
  hypothesis_title: string;
  /** The cause the hypothesis claimed. */
  why: string;
  verification: HypothesisVerification;
}

export interface UxDiagnosis {
  id: string;
  page_type: UxPageType;
  /** Round this diagnosis belongs to. NULL = predates rounds. */
  site_run_id?: string | null;
  /** The goal the round started with (kept even if the goal changes). */
  goal_id?: string | null;
  /** The goal text: goes into the hypotheses prompt and the dossier. */
  objective_statement?: string | null;
  status: DiagnosisStatus;
  stage: DiagnosisStage;
  /** "3 of 5 mockups" etc. — only for the progress screen. */
  progress_note: string | null;
  domain: string;
  summary: DiagnosisSummary | null;
  evidence: DiagnosisEvidence | null;
  error: string | null;
  cost_usd: number | null;
  started_at: string;
  finished_at: string | null;
}

/** List row (without the evidence, which is large). */
export type UxDiagnosisListItem = Omit<UxDiagnosis, "evidence"> & {
  opportunities_total: number;
  hypotheses_total: number;
  hypotheses_approved: number;
};
