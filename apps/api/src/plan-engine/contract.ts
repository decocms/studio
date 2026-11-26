/**
 * The contract of the tools Studio's Plan consumes. Studio mirrors these types
 * in Zod and treats any other shape as an error, so changing a field here
 * changes the contract. Every tool may also return `ToolError` (`{ error }`);
 * org image URLs are signed and valid for 1 h (api/services/media-signing.ts).
 */

import type { ExperimentDesign } from "./experiment.ts";
import type { KnowledgeEntry } from "./knowledge/types.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { HypothesisRelevance } from "./relevance.ts";
import type { HypothesisReview } from "./review.ts";
import type {
  DiagnosisStatus,
  GapOwner,
  HypothesisStatus,
  SetupKey,
  SourceGap,
  UxDevice,
  UxHypothesis,
  UxOpportunity,
  UxPageType,
} from "./types.ts";
import type { Verdict } from "./verify/types.ts";

export interface ToolError {
  error: string;
}

// ── What the client must provide (setup.ts) ──────────────────────────────────

export type { GapOwner, SetupKey };

export interface SetupNeed {
  key: SetupKey;
  /** Only the domain stops the analysis from starting. */
  blocking: boolean;
  /** Competitors: the list the engine checked, for the client to confirm. */
  suggested?: string[] | null;
}

export interface StoreSetup {
  needs: SetupNeed[];
  current: { domain: string | null; competitors: string[] };
}

/** A gap with an owner; `message` is the same text as the line in `gaps`. */
export interface GapDetail {
  source: SourceGap["source"];
  owner: GapOwner;
  key?: SetupKey;
  message: string;
}

// ── start_ux_diagnosis ───────────────────────────────────────────────────────

export interface StartedDiagnosis {
  page_type: UxPageType;
  diagnosis_id: string;
  /** The page already had an analysis running in the org: it is that one, not a new one. */
  already_running: boolean;
}

export type StartUxDiagnosisOutput =
  | {
      status: "started";
      site_run_id: string;
      diagnoses: StartedDiagnosis[];
    }
  | {
      status: "error";
      error: string;
      needs_domain?: true;
      /** With `needs_domain`: what is missing, in `StoreSetup.needs` format. */
      needs?: SetupNeed[];
    };

// ── list_ux_site_runs ────────────────────────────────────────────────────────

export interface SiteRunSummary {
  site_run_id: string;
  /** The goal the run started with (unchanged if the goal is changed later). */
  goal_id: string | null;
  objective_statement: string | null;
  started_at: string;
  /** running: some page runs; done: some finished; error: all failed. */
  status: DiagnosisStatus;
  pages: UxPageType[];
}

export interface ListUxSiteRunsOutput {
  /** Newest to oldest. */
  runs: SiteRunSummary[];
}

// ── get_ux_store_view ────────────────────────────────────────────────────────

/** The sources the screen names, in this order. */
export const STORE_SOURCES = [
  "GA4",
  "Deco Analytics",
  "VTEX",
  "Página ao vivo",
  "Código",
] as const;
export type StoreSource = (typeof STORE_SOURCES)[number];

export interface StoreFunnelPoint {
  device: UxDevice;
  /** Who reaches the page's step, per week. */
  people_week: number;
  /** 0-1: of those who arrive, how many move on to the next step. */
  advance_rate: number;
}

export interface StorePage {
  page_type: UxPageType;
  /** The page's newest analysis (the one `status` describes). */
  diagnosis_id: string;
  /** When the analysis whose results are shown finished. */
  analysed_at: string;
  status: DiagnosisStatus;
  /** Stage of the newest analysis; null when it finished. */
  stage: string | null;
  /** Progress if running; the error message if failed; null if finished. */
  progress_note: string | null;
  /** [] when the analysis has no funnel for this page (and `gaps` says why). */
  funnel: StoreFunnelPoint[];
  /** Signed first-screen screenshot (mobile, or desktop). */
  capture_url: string | null;
  observations: string[];
  /** Sources that did not answer, named ("GA4: ..."). */
  gaps: string[];
  /** The same gaps as `gaps`, same order, with an owner. */
  gap_details: GapDetail[];
}

export interface StoreOpportunityHypothesis {
  id: string;
  title: string;
  lifecycle: Lifecycle;
  verification: { verdict: Verdict; summary: string } | null;
  status: HypothesisStatus;
}

export interface StoreOpportunity extends UxOpportunity {
  page_type: UxPageType;
  hypotheses: StoreOpportunityHypothesis[];
}

export interface StoreView {
  pages: StorePage[];
  /** Up to 2, by money.monthly_value desc then confidence desc. */
  top: StoreOpportunity[];
  /** The rest, in the same order. */
  others: StoreOpportunity[];
  /** Sources that brought data on at least one page. */
  sources: StoreSource[];
  running: boolean;
  /** What the client must provide: from the profile and the pages' gaps above. */
  setup: StoreSetup;
}

export type GetUxStoreViewOutput = StoreView;

// ── get_ux_opportunity ───────────────────────────────────────────────────────

export interface KnowledgeCitation {
  id: string;
  fonte: string;
  fonte_url: string | null;
  trecho: string | null;
}

export interface OpportunityHypothesisDetail extends UxHypothesis {
  lifecycle: Lifecycle;
  experiment: ExperimentDesign | null;
  review: HypothesisReview | null;
  relevance: HypothesisRelevance | null;
  citations: KnowledgeCitation[];
}

export interface OpportunityDetail extends UxOpportunity {
  page_type: UxPageType;
  hypotheses: OpportunityHypothesisDetail[];
}

export interface GetUxOpportunityOutput {
  opportunity: OpportunityDetail;
}

// ── update_ux_hypothesis_status ──────────────────────────────────────────────

export interface UpdateUxHypothesisStatusOutput {
  hypothesis: UxHypothesis;
}

/** The cited knowledge entry, in the contract's format. */
export function citationOf(e: KnowledgeEntry): KnowledgeCitation {
  return {
    id: e.id,
    fonte: e.fonte,
    fonte_url: e.fonte_url ?? null,
    trecho: e.trecho ?? null,
  };
}
