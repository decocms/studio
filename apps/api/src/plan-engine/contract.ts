/**
 * O contrato das tools que o Plan do Studio consome. O Studio espelha estes
 * tipos em Zod e trata qualquer outro formato como erro, então mudar um campo
 * aqui é mudar o contrato: o lado do Studio tem que mudar junto.
 *
 * Toda tool também pode devolver `ToolError` (`{ error }`); a de começar a
 * análise devolve `{ status: "error", error }`. URLs de imagem de uma org
 * (`capture_url`, `before_url`, `after_url`, `screenshot_url`…) saem assinadas
 * e valem 1 h (api/services/media-signing.ts).
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

// ── O que o cliente tem que dar (setup.ts) ───────────────────────────────────

export type { GapOwner, SetupKey };

export interface SetupNeed {
  key: SetupKey;
  /** Só o domínio impede a análise de começar. */
  blocking: boolean;
  /** Concorrentes: a lista que o motor checou, pro cliente confirmar. */
  suggested?: string[] | null;
}

export interface StoreSetup {
  needs: SetupNeed[];
  current: { domain: string | null; competitors: string[] };
}

/** Uma lacuna com dono; `message` é o mesmo texto da linha em `gaps`. */
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
  /** A página já tinha uma análise rodando na org: é ela, não uma nova. */
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
      /** Junto com `needs_domain`: o que falta, no formato de `StoreSetup.needs`. */
      needs?: SetupNeed[];
    };

// ── list_ux_site_runs ────────────────────────────────────────────────────────

export interface SiteRunSummary {
  site_run_id: string;
  /** A meta com que a rodada começou (não muda se a meta for trocada depois). */
  goal_id: string | null;
  objective_statement: string | null;
  started_at: string;
  /** running: alguma página roda; done: alguma terminou; error: todas falharam. */
  status: DiagnosisStatus;
  pages: UxPageType[];
}

export interface ListUxSiteRunsOutput {
  /** Da mais nova para a mais antiga. */
  runs: SiteRunSummary[];
}

// ── get_ux_store_view ────────────────────────────────────────────────────────

/** As fontes que a tela nomeia, nesta ordem. */
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
  /** Quem chega à etapa da página, por semana. */
  people_week: number;
  /** 0–1: de quem chega, quantos passam para a etapa seguinte. */
  advance_rate: number;
}

export interface StorePage {
  page_type: UxPageType;
  /** A análise mais nova da página (a que `status` descreve). */
  diagnosis_id: string;
  /** Quando terminou a análise cujos resultados aparecem. */
  analysed_at: string;
  status: DiagnosisStatus;
  /** Etapa da análise mais nova; null quando ela terminou. */
  stage: string | null;
  /** Progresso se roda; a mensagem de erro se falhou; null se terminou. */
  progress_note: string | null;
  /** [] quando a análise não tem funil desta página (e `gaps` diz o porquê). */
  funnel: StoreFunnelPoint[];
  /** Print da primeira tela (celular, ou computador), assinado. */
  capture_url: string | null;
  observations: string[];
  /** Fontes que não responderam, nomeadas ("GA4: …"). */
  gaps: string[];
  /** As mesmas lacunas de `gaps`, na mesma ordem, com dono. */
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
  /** Até 2, por money.monthly_value desc e depois confidence desc. */
  top: StoreOpportunity[];
  /** As demais, na mesma ordem. */
  others: StoreOpportunity[];
  /** Fontes que trouxeram dado em ao menos uma página. */
  sources: StoreSource[];
  running: boolean;
  /** O que o cliente tem que dar: do perfil e das lacunas das páginas acima. */
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

/** A entrada de conhecimento citada, no formato do contrato. */
export function citationOf(e: KnowledgeEntry): KnowledgeCitation {
  return {
    id: e.id,
    fonte: e.fonte,
    fonte_url: e.fonte_url ?? null,
    trecho: e.trecho ?? null,
  };
}
