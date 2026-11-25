/**
 * Storage for the store-analysis engine (migration 272): the site profile,
 * diagnoses, their opportunities and hypotheses, and the competitor page
 * cache. Every method takes the organization and keeps to it.
 *
 * Rows come back in the engine's own shapes, snake_case, with timestamps as
 * ISO strings: the tools return them as they are.
 */

import { type Kysely, type RawBuilder, sql, type Transaction } from "kysely";
import type { SiteRunSummary } from "../plan-engine/contract.ts";
import { sameStore } from "../plan-engine/domain-check.ts";
import type { ExperimentDesign } from "../plan-engine/experiment.ts";
import {
  type HypothesisValidation,
  type Lifecycle,
  type LifecycleEntry,
  lifecycleOf,
  type OpportunityOutcome,
  validationOf,
} from "../plan-engine/lifecycle.ts";
import type { MeasuredMetric, UxMetricRef } from "../plan-engine/metrics.ts";
import { asPageType, PAGE_TYPE_ORDER } from "../plan-engine/page-types.ts";
import type { HypothesisPriority } from "../plan-engine/priority.ts";
import type { HypothesisRelevance } from "../plan-engine/relevance.ts";
import type { DataReliability } from "../plan-engine/reliability.ts";
import type { HypothesisReview } from "../plan-engine/review.ts";
import type { Drilldown } from "../plan-engine/segments.ts";
import type {
  DiscardedCategory,
  HypothesisCategory,
  HypothesisTree,
} from "../plan-engine/tree.ts";
import type {
  BenchmarkPdp,
  CodeMockupStatus,
  CodeTokens,
  DesignSystem,
  DiagnosisEvidence,
  DiagnosisStage,
  DiagnosisStatus,
  DiagnosisSummary,
  HypothesisBenchmark,
  HypothesisKind,
  HypothesisStatus,
  MoneyEstimate,
  OpportunityDraft,
  PageTemplates,
  SiteProfile,
  SiteSources,
  UxArea,
  UxDevice,
  UxDiagnosis,
  UxDiagnosisListItem,
  UxHypothesis,
  UxObservation,
  UxOpportunity,
  UxPageType,
  UxSourceRef,
} from "../plan-engine/types.ts";
import {
  decodeVerification,
  encodeVerification,
  type HypothesisVerification,
} from "../plan-engine/verify/types.ts";
import type { Database } from "./types";

type Db = Kysely<Database> | Transaction<Database>;
type Row = Record<string, unknown>;

/** After this long a `running` diagnosis counts as abandoned. */
const STALE_DIAGNOSIS_MINUTES = 90;

/** Rows per multi-row INSERT. */
const INSERT_CHUNK = 50;

export const nowIso = (): string => new Date().toISOString();

const newId = (): string => crypto.randomUUID();

export const str = (v: unknown): string =>
  v == null ? "" : v instanceof Date ? v.toISOString() : String(v);

export const strOrNull = (v: unknown): string | null =>
  v == null ? null : str(v);

/** A jsonb cell, or `fallback` when it is null. */
export function fromJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  if (value === "") return fallback;
  try {
    return (JSON.parse(value) ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** A jsonb parameter; null and undefined are SQL NULL. */
export function jsonb(value: unknown): RawBuilder<unknown> {
  return value === undefined || value === null
    ? sql`NULL`
    : sql`${JSON.stringify(value)}::jsonb`;
}

/** An ISO timestamp parameter; null is SQL NULL. */
export const ts = (iso: string | null | undefined): RawBuilder<unknown> =>
  iso == null ? sql`NULL` : sql`${iso}::timestamptz`;

export function chunk<T>(items: readonly T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function rethrow(prefix: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`${prefix}: ${message}`);
}

const isUniqueViolation = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "23505";

/** The `SET a = …, b = …` of a partial patch; null when nothing is set. */
function setClause(
  patch: Record<string, RawBuilder<unknown> | undefined>,
): RawBuilder<unknown> | null {
  const parts = Object.entries(patch).flatMap(([column, value]) =>
    value === undefined ? [] : [sql`${sql.ref(column)} = ${value}`],
  );
  return parts.length === 0 ? null : sql.join(parts, sql`, `);
}

const val = (v: unknown): RawBuilder<unknown> | undefined =>
  v === undefined ? undefined : sql`${v}`;

/** Observations were plain strings before they cited facts; those read with none. */
export function decodeObservations(raw: unknown): UxObservation[] | null {
  const list = fromJson<unknown[] | null>(raw, null);
  if (!Array.isArray(list)) return null;
  return list.flatMap((x): UxObservation[] => {
    if (typeof x === "string") return x.trim() ? [{ text: x, facts: [] }] : [];
    const o = (x ?? {}) as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    if (!text) return [];
    const facts = Array.isArray(o.facts) ? o.facts.map(String) : [];
    return [{ text, facts }];
  });
}

const verificationOf = (raw: unknown): HypothesisVerification | null =>
  decodeVerification(raw == null ? null : JSON.stringify(raw));

const verificationParam = (
  v: HypothesisVerification | null,
): RawBuilder<unknown> => {
  const encoded = encodeVerification(v);
  return encoded === null ? sql`NULL` : sql`${encoded}::jsonb`;
};

// ── Profile ──────────────────────────────────────────────────────────────────

function rowToProfile(row: Row): SiteProfile {
  const competitors = fromJson<string[]>(row.competitors, []);
  return {
    domain: str(row.domain),
    studio_site: strOrNull(row.studio_site),
    pdp_path_template: str(row.pdp_path_template) || "/:product/p",
    page_templates: fromJson<PageTemplates | null>(row.page_templates, null),
    competitors: Array.isArray(competitors) ? competitors.map(String) : [],
    competitors_confirmed_at: strOrNull(row.competitors_confirmed_at),
    design_system: fromJson<DesignSystem | null>(row.design_system, null),
    design_system_at: strOrNull(row.design_system_at),
    code_tokens: fromJson<CodeTokens | null>(row.code_tokens, null),
    sources: fromJson<SiteSources | null>(row.sources, null),
    code_repo: strOrNull(row.code_repo),
    code_project_id: strOrNull(row.code_project_id),
    code_volume: strOrNull(row.code_volume),
    updated_at: str(row.updated_at),
  };
}

export interface SiteProfilePatch {
  domain?: string;
  studio_site?: string | null;
  pdp_path_template?: string;
  /** Home/search/category routes; null clears them for the next run to detect. */
  page_templates?: PageTemplates | null;
  competitors?: string[];
  /** true stamps now; false clears. Moving to another store clears it too. */
  competitors_confirmed?: boolean;
  /** "owner/name"; null clears. */
  code_repo?: string | null;
  /** `vir_…`; null clears. */
  code_project_id?: string | null;
  /** org-fs volume; null clears. */
  code_volume?: string | null;
}

// ── Diagnoses ────────────────────────────────────────────────────────────────

const LIST_COLUMNS = [
  "id",
  "page_type",
  "site_run_id",
  "goal_id",
  "objective_statement",
  "status",
  "stage",
  "progress_note",
  "domain",
  "summary",
  "error",
  "cost_usd",
  "started_at",
  "finished_at",
] as const;

const listColumns = (alias?: string) =>
  sql.join(
    LIST_COLUMNS.map((c) => (alias ? sql.ref(`${alias}.${c}`) : sql.ref(c))),
  );

function rowToDiagnosis(row: Row): UxDiagnosis {
  return {
    id: str(row.id),
    page_type: asPageType(row.page_type),
    site_run_id: strOrNull(row.site_run_id),
    goal_id: strOrNull(row.goal_id),
    objective_statement: strOrNull(row.objective_statement),
    status: (str(row.status) || "running") as DiagnosisStatus,
    stage: (str(row.stage) || "queued") as DiagnosisStage,
    progress_note: strOrNull(row.progress_note),
    domain: str(row.domain),
    summary: fromJson<DiagnosisSummary | null>(row.summary, null),
    evidence: fromJson<DiagnosisEvidence | null>(row.evidence, null),
    error: strOrNull(row.error),
    cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
    started_at: str(row.started_at),
    finished_at: strOrNull(row.finished_at),
  };
}

export interface NewDiagnosis {
  domain: string;
  page_type?: UxPageType;
  site_run_id?: string | null;
  /** The goal the run started with; kept if the goal changes later. */
  goal_id?: string | null;
  objective_statement?: string | null;
}

export interface DiagnosisPatch {
  status?: DiagnosisStatus;
  stage?: DiagnosisStage;
  progress_note?: string | null;
  summary?: DiagnosisSummary | null;
  evidence?: DiagnosisEvidence | null;
  error?: string | null;
  cost_usd?: number | null;
  finished?: boolean;
}

// ── Hypotheses ───────────────────────────────────────────────────────────────

/** Rows written before the lifecycle read their state from the verdict. */
function lifecycleFields(row: Row) {
  const verification = verificationOf(row.verification);
  const stored = strOrNull(row.lifecycle) as Lifecycle | null;
  return {
    lifecycle: lifecycleOf({ lifecycle: stored, verification }),
    lifecycle_log: fromJson<LifecycleEntry[]>(row.lifecycle_log, []),
    validation:
      fromJson<HypothesisValidation | null>(row.validation, null) ??
      (verification ? validationOf(verification) : null),
  };
}

function rowToHypothesis(row: Row): UxHypothesis {
  const refs = fromJson<string[]>(row.benchmark_refs, []);
  return {
    id: str(row.id),
    diagnosis_id: str(row.diagnosis_id),
    opportunity_id: strOrNull(row.opportunity_id),
    rank: Number(row.rank ?? 0),
    kind: (str(row.kind) || "proposta") as HypothesisKind,
    title: str(row.title),
    device: (str(row.device) || "mobile") as UxDevice | "ambos",
    evidence_md: str(row.evidence_md),
    idea: str(row.idea),
    why: str(row.why),
    where: str(row.where),
    money: fromJson<MoneyEstimate | null>(row.money, null),
    confidence: Number(row.confidence ?? 0.5),
    benchmark_refs: Array.isArray(refs) ? refs.map(String) : [],
    benchmark: fromJson<HypothesisBenchmark[]>(row.benchmark, []),
    before_url: strOrNull(row.before_url),
    after_url: strOrNull(row.after_url),
    after_patch: strOrNull(row.after_patch),
    mockup_error: strOrNull(row.mockup_error),
    status: (str(row.status) || "pending") as HypothesisStatus,
    status_note: strOrNull(row.status_note),
    code_status:
      (strOrNull(row.code_status) as CodeMockupStatus | null) ?? null,
    code_note: strOrNull(row.code_note),
    code_before_url: strOrNull(row.code_before_url),
    code_after_url: strOrNull(row.code_after_url),
    code_diff: strOrNull(row.code_diff),
    code_error: strOrNull(row.code_error),
    code_started_at: strOrNull(row.code_started_at),
    verification: verificationOf(row.verification),
    category: (strOrNull(row.category) as HypothesisCategory | null) ?? null,
    tree: fromJson<HypothesisTree | null>(row.tree, null),
    ...lifecycleFields(row),
    relevance: fromJson<HypothesisRelevance | null>(row.relevance, null),
    experiment: fromJson<ExperimentDesign | null>(row.experiment, null),
    priority: fromJson<HypothesisPriority | null>(row.priority, null),
    review: fromJson<HypothesisReview | null>(row.review, null),
    updated_at: str(row.updated_at),
  };
}

export type HypothesisDraft = Omit<
  UxHypothesis,
  | "id"
  | "diagnosis_id"
  | "after_url"
  | "after_patch"
  | "mockup_error"
  | "status"
  | "status_note"
  | "code_status"
  | "code_note"
  | "code_before_url"
  | "code_after_url"
  | "code_diff"
  | "code_error"
  | "code_started_at"
  | "verification"
  | "updated_at"
  | "lifecycle"
  | "lifecycle_log"
  | "validation"
  | "relevance"
  | "experiment"
  | "priority"
  | "review"
>;

/** Stable per (diagnosis, kind, rank), so a replayed step finds the row. */
export function hypothesisId(
  diagnosisId: string,
  rank: number,
  kind: HypothesisKind,
): string {
  return `${diagnosisId}:${kind === "nao_faria" ? "n" : "h"}${rank}`;
}

// ── Opportunities ────────────────────────────────────────────────────────────

function rowToOpportunity(row: Row): UxOpportunity {
  return {
    id: str(row.id),
    diagnosis_id: str(row.diagnosis_id),
    rank: Number(row.rank ?? 0),
    area: (str(row.area) || "pagina_geral") as UxArea,
    title: str(row.title),
    summary: str(row.summary),
    device: (str(row.device) || "ambos") as UxDevice | "ambos",
    sources: fromJson<UxSourceRef[]>(row.sources, []),
    money: fromJson<MoneyEstimate | null>(row.money, null),
    confidence: Number(row.confidence ?? 0.5),
    metric: fromJson<UxMetricRef | null>(row.metric, null),
    measured: fromJson<MeasuredMetric | null>(row.measured, null),
    reliability: fromJson<DataReliability | null>(row.reliability, null),
    drilldown: fromJson<Drilldown | null>(row.drilldown, null),
    tree_notes: fromJson<DiscardedCategory[] | null>(row.tree_notes, null),
    outcome: fromJson<OpportunityOutcome | null>(row.outcome, null),
    observations: decodeObservations(row.observations),
    updated_at: str(row.updated_at),
  };
}

/** Stable per (diagnosis, rank): the hypotheses step finds the row by it. */
export function opportunityId(diagnosisId: string, rank: number): string {
  return `${diagnosisId}:o${rank}`;
}

/** `<id>:sem-causa` for the one that fell; `-<n>` for a reserve that fell in its place. */
export const retiredId = (id: string, attempt = 0) =>
  attempt > 0 ? `${id}:sem-causa-${attempt}` : `${id}:sem-causa`;

/**
 * A v1 diagnosis (hypotheses without an opportunity) in the v2 shape: each
 * old proposal becomes its own opportunity.
 */
export function legacyOpportunities(hypotheses: UxHypothesis[]): {
  opportunities: UxOpportunity[];
  hypotheses: UxHypothesis[];
} {
  const opportunities: UxOpportunity[] = [];
  const out = hypotheses.map((h) => {
    if (h.kind !== "proposta" || h.opportunity_id) return h;
    const id = `${h.id}:legacy`;
    opportunities.push({
      id,
      diagnosis_id: h.diagnosis_id,
      rank: h.rank,
      area: "pagina_geral",
      title: h.title,
      summary: h.where,
      device: h.device,
      sources: [],
      money: h.money,
      confidence: h.confidence,
      updated_at: h.updated_at,
    });
    return { ...h, opportunity_id: id, rank: 1 };
  });
  opportunities.sort((a, b) => a.rank - b.rank);
  return { opportunities, hypotheses: out };
}

// ── Benchmark ────────────────────────────────────────────────────────────────

/** A competitor's capture is good for 30 days. */
const BENCHMARK_TTL_DAYS = 30;

/** The cache key: the domain for a PDP, `domain#type` for other pages. */
export const benchmarkKey = (domain: string, pageType: UxPageType = "pdp") =>
  pageType === "pdp" ? domain : `${domain}#${pageType}`;

const RETIRED = sql`IN ('true', '1')`;

const OPPORTUNITY_COLUMNS = sql`(id, diagnosis_id, rank, area, title, summary,
  device, sources, money, confidence, metric, measured, reliability, drilldown,
  observations, updated_at, organization_id)`;

function opportunityValues(
  id: string,
  diagnosisId: string,
  o: OpportunityDraft,
  now: string,
  orgId: string,
): RawBuilder<unknown> {
  return sql.join([
    sql`${id}`,
    sql`${diagnosisId}`,
    sql`${o.rank}::int`,
    sql`${o.area}`,
    sql`${o.title}`,
    sql`${o.summary}`,
    sql`${o.device}`,
    jsonb(o.sources),
    jsonb(o.money),
    sql`${o.confidence}::double precision`,
    jsonb(o.metric ?? null),
    jsonb(o.measured ?? null),
    jsonb(o.reliability ?? null),
    jsonb(o.drilldown ?? null),
    jsonb(o.observations ?? null),
    ts(now),
    sql`${orgId}`,
  ]);
}

export class PlanEngineStorage {
  constructor(private readonly db: Kysely<Database>) {}

  // ── Profile ────────────────────────────────────────────────────────────────

  async getSiteProfile(orgId: string): Promise<SiteProfile | null> {
    try {
      const { rows } = await sql<Row>`
        SELECT * FROM plan_ux_site_profiles WHERE organization_id = ${orgId}
      `.execute(this.db);
      return rows[0] ? rowToProfile(rows[0]) : null;
    } catch (err) {
      rethrow("getSiteProfile failed", err);
    }
  }

  /**
   * Creates or updates the profile. `domain` is required only on create.
   * Moving to another store without sending competitors empties the list;
   * changing only the `www.` does not.
   */
  async upsertSiteProfile(
    orgId: string,
    patch: SiteProfilePatch,
  ): Promise<SiteProfile> {
    const existing = await this.getSiteProfile(orgId);
    const now = nowIso();
    try {
      if (!existing) {
        if (!patch.domain) {
          throw new Error("domain is required to create the profile");
        }
        await sql`
          INSERT INTO plan_ux_site_profiles
            (organization_id, domain, studio_site, pdp_path_template,
             competitors, competitors_confirmed_at, code_volume, updated_at)
          VALUES (${orgId}, ${patch.domain}, ${patch.studio_site ?? null},
                  ${patch.pdp_path_template ?? "/:product/p"},
                  ${jsonb(patch.competitors ?? [])},
                  ${ts(patch.competitors_confirmed ? now : null)},
                  ${patch.code_volume ?? null}, ${ts(now)})
        `.execute(this.db);
      } else {
        const otherStore =
          patch.domain !== undefined &&
          !sameStore(patch.domain, existing.domain);
        const set = setClause({
          domain: val(patch.domain),
          studio_site: val(patch.studio_site),
          pdp_path_template: val(patch.pdp_path_template),
          page_templates:
            patch.page_templates === undefined
              ? undefined
              : jsonb(patch.page_templates),
          code_repo: val(patch.code_repo),
          code_project_id: val(patch.code_project_id),
          code_volume: val(patch.code_volume),
          // Another store's competitors don't serve this one.
          competitors:
            patch.competitors !== undefined
              ? jsonb(patch.competitors)
              : otherStore
                ? jsonb([])
                : undefined,
          competitors_confirmed_at:
            patch.competitors_confirmed !== undefined
              ? ts(patch.competitors_confirmed ? now : null)
              : otherStore
                ? sql`NULL`
                : undefined,
          updated_at: ts(now),
        });
        if (set) {
          await sql`
            UPDATE plan_ux_site_profiles SET ${set}
             WHERE organization_id = ${orgId}
          `.execute(this.db);
        }
      }
    } catch (err) {
      rethrow("upsertSiteProfile failed", err);
    }
    const saved = await this.getSiteProfile(orgId);
    if (!saved) {
      throw new Error("upsertSiteProfile: profile vanished after write");
    }
    return saved;
  }

  /** A run swaps the suggested list for the stores that opened, unless the customer confirmed theirs. */
  async replaceSuggestedCompetitors(
    orgId: string,
    competitors: string[],
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_site_profiles
           SET competitors = ${jsonb(competitors)}, updated_at = ${ts(nowIso())}
         WHERE organization_id = ${orgId} AND competitors_confirmed_at IS NULL
      `.execute(this.db);
    } catch (err) {
      rethrow("replaceSuggestedCompetitors failed", err);
    }
  }

  /** Saves what detection found in Studio, leaving the rest of the profile. */
  async saveSiteSources(orgId: string, sources: SiteSources): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_site_profiles
           SET sources = ${jsonb(sources)}, updated_at = ${ts(nowIso())}
         WHERE organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveSiteSources failed", err);
    }
  }

  async saveCodeTokens(orgId: string, tokens: CodeTokens): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_site_profiles
           SET code_tokens = ${jsonb(tokens)}, updated_at = ${ts(nowIso())}
         WHERE organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveCodeTokens failed", err);
    }
  }

  async saveDesignSystem(
    orgId: string,
    designSystem: DesignSystem,
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_site_profiles
           SET design_system = ${jsonb(designSystem)},
               design_system_at = ${ts(designSystem.captured_at)},
               updated_at = ${ts(nowIso())}
         WHERE organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveDesignSystem failed", err);
    }
  }

  // ── Diagnoses ──────────────────────────────────────────────────────────────

  async insertDiagnosis(
    orgId: string,
    input: NewDiagnosis,
  ): Promise<UxDiagnosis> {
    try {
      const { rows } = await sql<Row>`
        INSERT INTO plan_ux_diagnoses
          (id, page_type, site_run_id, goal_id, objective_statement, status,
           stage, domain, started_at, organization_id)
        VALUES (${newId()}, ${input.page_type ?? "pdp"},
                ${input.site_run_id ?? null}, ${input.goal_id ?? null},
                ${input.objective_statement ?? null}, 'running', 'queued',
                ${input.domain}, ${ts(nowIso())}, ${orgId})
        RETURNING *
      `.execute(this.db);
      if (!rows[0]) throw new Error("insert returned no row");
      return rowToDiagnosis(rows[0]);
    } catch (err) {
      rethrow("insertDiagnosis failed", err);
    }
  }

  /**
   * Starts a page's diagnosis only if none of that page is running in the
   * org; null when one already was.
   */
  async insertDiagnosisIfIdle(
    orgId: string,
    input: NewDiagnosis,
  ): Promise<UxDiagnosis | null> {
    const pageType = input.page_type ?? "pdp";
    try {
      const { rows } = await sql<Row>`
        INSERT INTO plan_ux_diagnoses
          (id, page_type, site_run_id, goal_id, objective_statement, status,
           stage, domain, started_at, organization_id)
        SELECT ${newId()}, ${pageType}, ${input.site_run_id ?? null},
               ${input.goal_id ?? null}, ${input.objective_statement ?? null},
               'running', 'queued', ${input.domain}, ${ts(nowIso())}, ${orgId}
         WHERE NOT EXISTS (
           SELECT 1 FROM plan_ux_diagnoses
            WHERE organization_id = ${orgId} AND status = 'running'
              AND page_type = ${pageType})
        ON CONFLICT (organization_id, page_type) WHERE status = 'running'
        DO NOTHING
        RETURNING *
      `.execute(this.db);
      return rows[0] ? rowToDiagnosis(rows[0]) : null;
    } catch (err) {
      rethrow("insertDiagnosisIfIdle failed", err);
    }
  }

  async updateDiagnosis(
    orgId: string,
    id: string,
    patch: DiagnosisPatch,
  ): Promise<void> {
    const set = setClause({
      status: val(patch.status),
      stage: val(patch.stage),
      progress_note: val(patch.progress_note),
      summary: patch.summary === undefined ? undefined : jsonb(patch.summary),
      evidence:
        patch.evidence === undefined ? undefined : jsonb(patch.evidence),
      error: val(patch.error),
      cost_usd: val(patch.cost_usd),
      finished_at: patch.finished ? ts(nowIso()) : undefined,
    });
    if (!set) return;
    try {
      await sql`
        UPDATE plan_ux_diagnoses SET ${set}
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("updateDiagnosis failed", err);
    }
  }

  async getDiagnosis(orgId: string, id: string): Promise<UxDiagnosis | null> {
    try {
      const { rows } = await sql<Row>`
        SELECT * FROM plan_ux_diagnoses
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
      return rows[0] ? rowToDiagnosis(rows[0]) : null;
    } catch (err) {
      rethrow("getDiagnosis failed", err);
    }
  }

  /**
   * Newest first, without the evidence. A retired opportunity ("investigated,
   * no cause") and its hypotheses stay out of the counts, as they stay off
   * the screen.
   */
  async listDiagnoses(
    orgId: string,
    limit = 20,
    /** Only this whole-site run's diagnoses. */
    siteRunId?: string,
  ): Promise<UxDiagnosisListItem[]> {
    const run = siteRunId ?? null;
    try {
      const { rows } = await sql<Row>`
        SELECT ${listColumns("d")},
               (SELECT COUNT(*) FROM plan_ux_opportunities o
                 WHERE o.diagnosis_id = d.id
                   AND o.organization_id = d.organization_id
                   AND COALESCE(o.outcome->>'retired', '') NOT ${RETIRED}
               ) AS opportunities_total,
               COUNT(h.id) AS hypotheses_total,
               SUM(CASE WHEN h.status = 'approved' THEN 1 ELSE 0 END)
                 AS hypotheses_approved
          FROM plan_ux_diagnoses d
          LEFT JOIN plan_ux_hypotheses h
            ON h.diagnosis_id = d.id AND h.kind = 'proposta'
           AND h.organization_id = d.organization_id
           AND NOT EXISTS (
                 SELECT 1 FROM plan_ux_opportunities ro
                  WHERE ro.id = h.opportunity_id
                    AND ro.organization_id = d.organization_id
                    AND ro.outcome->>'retired' ${RETIRED})
         WHERE d.organization_id = ${orgId}
           AND (${run}::text IS NULL OR d.site_run_id = ${run})
         GROUP BY d.id
         ORDER BY d.started_at DESC
         LIMIT ${limit}
      `.execute(this.db);
      return rows.map((row) => {
        const { evidence: _evidence, ...rest } = rowToDiagnosis(row);
        return {
          ...rest,
          opportunities_total: Number(row.opportunities_total ?? 0),
          hypotheses_total: Number(row.hypotheses_total ?? 0),
          hypotheses_approved: Number(row.hypotheses_approved ?? 0),
        };
      });
    } catch (err) {
      rethrow("listDiagnoses failed", err);
    }
  }

  /**
   * The running diagnosis of this page type; any page when omitted. The lock
   * is per page: a whole-site run runs one of each at once.
   */
  async fetchRunningDiagnosis(
    orgId: string,
    pageType?: UxPageType,
  ): Promise<UxDiagnosis | null> {
    const page = pageType ?? null;
    try {
      const { rows } = await sql<Row>`
        SELECT ${listColumns()} FROM plan_ux_diagnoses
         WHERE organization_id = ${orgId} AND status = 'running'
           AND (${page}::text IS NULL OR page_type = ${page})
         ORDER BY started_at DESC LIMIT 1
      `.execute(this.db);
      return rows[0] ? rowToDiagnosis(rows[0]) : null;
    } catch (err) {
      rethrow("fetchRunningDiagnosis failed", err);
    }
  }

  /** Diagnoses the org started since `sinceIso`: what the daily cap counts. */
  async countDiagnosesStartedSince(
    orgId: string,
    sinceIso: string,
  ): Promise<number> {
    try {
      const { rows } = await sql<{ n: string | number }>`
        SELECT COUNT(*) AS n FROM plan_ux_diagnoses
         WHERE organization_id = ${orgId} AND started_at >= ${ts(sinceIso)}
      `.execute(this.db);
      return Number(rows[0]?.n ?? 0);
    } catch (err) {
      rethrow("countDiagnosesStartedSince failed", err);
    }
  }

  /**
   * The org's runs, newest first; with `goalId`, only those started toward
   * it. A diagnosis without `site_run_id` is a run of its own.
   */
  async listSiteRuns(
    orgId: string,
    opts: { goalId?: string | null; limit?: number } = {},
  ): Promise<SiteRunSummary[]> {
    const goalId = opts.goalId ?? null;
    try {
      const { rows } = await sql<Row>`
        SELECT COALESCE(site_run_id, id) AS run_id,
               MAX(goal_id) AS goal_id,
               MAX(objective_statement) AS objective_statement,
               MIN(started_at) AS started_at,
               SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
               SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
               string_agg(page_type, ',') AS pages,
               MAX(seq) AS seq
          FROM plan_ux_diagnoses
         WHERE organization_id = ${orgId}
           AND (${goalId}::text IS NULL OR goal_id = ${goalId})
         GROUP BY COALESCE(site_run_id, id)
         ORDER BY started_at DESC, seq DESC
         LIMIT ${opts.limit ?? 20}
      `.execute(this.db);
      return rows.map((row) => {
        const pages = new Set(
          str(row.pages)
            .split(",")
            .filter(Boolean)
            .map((p) => asPageType(p)),
        );
        return {
          site_run_id: str(row.run_id),
          goal_id: strOrNull(row.goal_id),
          objective_statement: strOrNull(row.objective_statement),
          started_at: str(row.started_at),
          status:
            Number(row.running ?? 0) > 0
              ? "running"
              : Number(row.done ?? 0) > 0
                ? "done"
                : "error",
          pages: PAGE_TYPE_ORDER.filter((p) => pages.has(p)),
        };
      });
    } catch (err) {
      rethrow("listSiteRuns failed", err);
    }
  }

  /** Newest first, without the evidence; with `goalId`, only the goal's. */
  async listDiagnosesForGoal(
    orgId: string,
    goalId: string | null,
    limit = 200,
  ): Promise<UxDiagnosis[]> {
    try {
      const { rows } = await sql<Row>`
        SELECT ${listColumns()} FROM plan_ux_diagnoses
         WHERE organization_id = ${orgId}
           AND (${goalId}::text IS NULL OR goal_id = ${goalId})
         ORDER BY started_at DESC, seq DESC LIMIT ${limit}
      `.execute(this.db);
      return rows.map(rowToDiagnosis);
    } catch (err) {
      rethrow("listDiagnosesForGoal failed", err);
    }
  }

  /** Closes the org's diagnoses left `running` past the deadline, or the lock stays held. */
  async reapStaleDiagnoses(orgId: string): Promise<void> {
    const cutoff = new Date(
      Date.now() - STALE_DIAGNOSIS_MINUTES * 60_000,
    ).toISOString();
    try {
      await sql`
        UPDATE plan_ux_diagnoses
           SET status = 'error',
               error = ${`diagnóstico abandonado (ainda "running" depois de ${STALE_DIAGNOSIS_MINUTES} min — provavelmente um deploy derrubou a instância)`},
               finished_at = ${ts(nowIso())}
         WHERE organization_id = ${orgId} AND status = 'running'
           AND COALESCE(restarted_at, started_at) < ${ts(cutoff)}
      `.execute(this.db);
    } catch (err) {
      rethrow("reapStaleDiagnoses failed", err);
    }
  }

  /**
   * "Verify again": puts the diagnosis back in `running`/`verify` and dates
   * the restart. Refused (false) while any diagnosis of the same page runs,
   * this one included.
   */
  async claimDiagnosisForVerify(orgId: string, id: string): Promise<boolean> {
    try {
      const result = await sql`
        UPDATE plan_ux_diagnoses
           SET status = 'running', stage = 'verify',
               progress_note = ${"começando a verificação"},
               error = NULL, restarted_at = ${ts(nowIso())}
         WHERE id = ${id} AND organization_id = ${orgId}
           AND status <> 'running'
           AND NOT EXISTS (
             SELECT 1 FROM plan_ux_diagnoses r
              WHERE r.organization_id = ${orgId}
                AND r.status = 'running'
                AND r.page_type = (
                  SELECT page_type FROM plan_ux_diagnoses
                   WHERE id = ${id} AND organization_id = ${orgId}))
      `.execute(this.db);
      return Number(result.numAffectedRows ?? 0) > 0;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      rethrow("claimDiagnosisForVerify failed", err);
    }
  }

  // ── Hypotheses ─────────────────────────────────────────────────────────────

  private async insertHypotheses(
    db: Db,
    orgId: string,
    diagnosisId: string,
    rows: Array<{ id: string; draft: HypothesisDraft }>,
  ): Promise<void> {
    const now = nowIso();
    const log = [{ state: "gerada", at: now, reason: "escrita na análise" }];
    for (const batch of chunk(rows)) {
      const values = batch.map(
        ({ id, draft: h }) => sql`(
          ${id}, ${diagnosisId}, ${h.opportunity_id}, ${h.rank}::int, ${h.kind},
          ${h.title}, ${h.device}, ${h.evidence_md}, ${h.idea}, ${h.why},
          ${h.where}, ${jsonb(h.money)}, ${h.confidence}::double precision,
          ${jsonb(h.benchmark_refs)}, ${jsonb(h.benchmark)}, ${h.before_url},
          ${h.category ?? null}, ${jsonb(h.tree ?? null)}, 'gerada',
          ${jsonb(log)}, 'pending', ${ts(now)}, ${orgId})`,
      );
      await sql`
        INSERT INTO plan_ux_hypotheses
          (id, diagnosis_id, opportunity_id, rank, kind, title, device,
           evidence_md, idea, why, "where", money, confidence, benchmark_refs,
           benchmark, before_url, category, tree, lifecycle, lifecycle_log,
           status, updated_at, organization_id)
        VALUES ${sql.join(values)}
      `.execute(db);
    }
  }

  private async replaceHypothesesIn(
    db: Db,
    orgId: string,
    diagnosisId: string,
    drafts: HypothesisDraft[],
  ): Promise<void> {
    await sql`
      DELETE FROM plan_ux_hypotheses
       WHERE diagnosis_id = ${diagnosisId} AND organization_id = ${orgId}
    `.execute(db);
    await this.insertHypotheses(
      db,
      orgId,
      diagnosisId,
      drafts.map((h) => ({
        id: hypothesisId(diagnosisId, h.rank, h.kind),
        draft: h,
      })),
    );
  }

  /**
   * Writes a diagnosis' hypotheses, REPLACING any it had, so a replayed step
   * does not duplicate the list.
   */
  async replaceHypotheses(
    orgId: string,
    diagnosisId: string,
    drafts: HypothesisDraft[],
  ): Promise<UxHypothesis[]> {
    try {
      await this.db
        .transaction()
        .execute((trx) =>
          this.replaceHypothesesIn(trx, orgId, diagnosisId, drafts),
        );
    } catch (err) {
      rethrow("replaceHypotheses failed", err);
    }
    return this.listHypotheses(orgId, diagnosisId);
  }

  async listHypotheses(
    orgId: string,
    diagnosisId: string,
  ): Promise<UxHypothesis[]> {
    try {
      const { rows } = await sql<Row>`
        SELECT * FROM plan_ux_hypotheses
         WHERE diagnosis_id = ${diagnosisId} AND organization_id = ${orgId}
         ORDER BY kind ASC, rank ASC
      `.execute(this.db);
      return rows.map(rowToHypothesis);
    } catch (err) {
      rethrow("listHypotheses failed", err);
    }
  }

  async saveHypothesisMockup(
    orgId: string,
    id: string,
    mockup: {
      before_url?: string | null;
      after_url: string | null;
      after_patch: string | null;
      mockup_error: string | null;
    },
  ): Promise<void> {
    const set = setClause({
      before_url: val(mockup.before_url),
      after_url: val(mockup.after_url),
      after_patch: val(mockup.after_patch),
      mockup_error: val(mockup.mockup_error),
      updated_at: ts(nowIso()),
    });
    if (!set) return;
    try {
      await sql`
        UPDATE plan_ux_hypotheses SET ${set}
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveHypothesisMockup failed", err);
    }
  }

  async saveHypothesisVerification(
    orgId: string,
    hypothesisId: string,
    v: HypothesisVerification,
    confidence: number,
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_hypotheses
           SET verification = ${verificationParam(v)},
               confidence = ${confidence}, updated_at = ${ts(nowIso())}
         WHERE id = ${hypothesisId} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveHypothesisVerification failed", err);
    }
  }

  /**
   * Swaps the hypothesis text for the rewrite. The "after" belonged to the old
   * idea and goes; an approval or a code "after" did too, so it returns to
   * pending without them.
   */
  async rewriteHypothesis(
    orgId: string,
    hypothesisId: string,
    draft: Pick<
      HypothesisDraft,
      "title" | "why" | "evidence_md" | "idea" | "where" | "confidence"
    >,
    v: HypothesisVerification,
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_hypotheses
           SET title = ${draft.title}, why = ${draft.why},
               evidence_md = ${draft.evidence_md}, idea = ${draft.idea},
               "where" = ${draft.where}, confidence = ${draft.confidence},
               verification = ${verificationParam(v)}, after_url = NULL,
               after_patch = NULL, mockup_error = NULL, status = 'pending',
               code_status = NULL, code_note = NULL, code_before_url = NULL,
               code_after_url = NULL, code_diff = NULL, code_error = NULL,
               code_started_at = NULL, updated_at = ${ts(nowIso())}
         WHERE id = ${hypothesisId} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("rewriteHypothesis failed", err);
    }
  }

  async deleteHypothesis(orgId: string, hypothesisId: string): Promise<void> {
    try {
      await sql`
        DELETE FROM plan_ux_hypotheses
         WHERE id = ${hypothesisId} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("deleteHypothesis failed", err);
    }
  }

  async getHypothesis(orgId: string, id: string): Promise<UxHypothesis | null> {
    try {
      const { rows } = await sql<Row>`
        SELECT * FROM plan_ux_hypotheses
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
      return rows[0] ? rowToHypothesis(rows[0]) : null;
    } catch (err) {
      rethrow("getHypothesis failed", err);
    }
  }

  async setHypothesisStatus(
    orgId: string,
    id: string,
    status: HypothesisStatus,
    note: string | null,
  ): Promise<UxHypothesis | null> {
    try {
      const { rows } = await sql<Row>`
        UPDATE plan_ux_hypotheses
           SET status = ${status}, status_note = ${note},
               updated_at = ${ts(nowIso())}
         WHERE id = ${id} AND organization_id = ${orgId}
        RETURNING *
      `.execute(this.db);
      return rows[0] ? rowToHypothesis(rows[0]) : null;
    } catch (err) {
      rethrow("setHypothesisStatus failed", err);
    }
  }

  /** Saves the lifecycle state, and the validation levels when given. */
  async saveHypothesisLifecycle(
    orgId: string,
    id: string,
    patch: {
      lifecycle: Lifecycle;
      lifecycle_log: LifecycleEntry[];
      validation?: HypothesisValidation;
    },
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_hypotheses
           SET lifecycle = ${patch.lifecycle},
               lifecycle_log = ${jsonb(patch.lifecycle_log)},
               validation = COALESCE(${jsonb(patch.validation ?? null)}, validation),
               updated_at = ${ts(nowIso())}
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveHypothesisLifecycle failed", err);
    }
  }

  /** The measured relevance, with the lifecycle and validation it moves. */
  async saveHypothesisRelevance(
    orgId: string,
    id: string,
    relevance: HypothesisRelevance,
    patch: {
      lifecycle: Lifecycle;
      lifecycle_log: LifecycleEntry[];
      validation: HypothesisValidation;
    },
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_hypotheses
           SET relevance = ${jsonb(relevance)}, lifecycle = ${patch.lifecycle},
               lifecycle_log = ${jsonb(patch.lifecycle_log)},
               validation = ${jsonb(patch.validation)},
               updated_at = ${ts(nowIso())}
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveHypothesisRelevance failed", err);
    }
  }

  /** The recommended test, the priorities and, if it changed, the lifecycle. */
  async saveHypothesisPlan(
    orgId: string,
    id: string,
    plan: {
      experiment: ExperimentDesign | null;
      priority: HypothesisPriority;
      lifecycle?: { lifecycle: Lifecycle; lifecycle_log: LifecycleEntry[] };
    },
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_hypotheses
           SET experiment = ${jsonb(plan.experiment)},
               priority = ${jsonb(plan.priority)},
               priority_test = ${plan.priority.teste}::double precision,
               lifecycle = COALESCE(${plan.lifecycle?.lifecycle ?? null}::text, lifecycle),
               lifecycle_log = COALESCE(${jsonb(plan.lifecycle?.lifecycle_log ?? null)}, lifecycle_log),
               updated_at = ${ts(nowIso())}
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveHypothesisPlan failed", err);
    }
  }

  /** The independent review and what it lowered (priority, lifecycle). */
  async saveHypothesisReview(
    orgId: string,
    id: string,
    review: HypothesisReview,
    patch: {
      priority: HypothesisPriority | null;
      lifecycle?: { lifecycle: Lifecycle; lifecycle_log: LifecycleEntry[] };
    },
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_hypotheses
           SET review = ${jsonb(review)},
               priority = COALESCE(${jsonb(patch.priority)}, priority),
               priority_test = ${patch.priority?.teste ?? null}::double precision,
               lifecycle = COALESCE(${patch.lifecycle?.lifecycle ?? null}::text, lifecycle),
               lifecycle_log = COALESCE(${jsonb(patch.lifecycle?.lifecycle_log ?? null)}, lifecycle_log),
               updated_at = ${ts(nowIso())}
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveHypothesisReview failed", err);
    }
  }

  // ── Opportunities ──────────────────────────────────────────────────────────

  /**
   * Writes a diagnosis' opportunities and its "would not do now" list,
   * deleting every opportunity and hypothesis it had first.
   */
  async replaceOpportunities(
    orgId: string,
    diagnosisId: string,
    drafts: OpportunityDraft[],
    notNow: HypothesisDraft[],
  ): Promise<UxOpportunity[]> {
    const now = nowIso();
    try {
      await this.db.transaction().execute(async (trx) => {
        await this.replaceHypothesesIn(trx, orgId, diagnosisId, notNow);
        await sql`
          DELETE FROM plan_ux_opportunities
           WHERE diagnosis_id = ${diagnosisId} AND organization_id = ${orgId}
        `.execute(trx);
        for (const batch of chunk(drafts)) {
          const values = batch.map(
            (o) =>
              sql`(${opportunityValues(opportunityId(diagnosisId, o.rank), diagnosisId, o, now, orgId)})`,
          );
          await sql`
            INSERT INTO plan_ux_opportunities ${OPPORTUNITY_COLUMNS}
            VALUES ${sql.join(values)}
          `.execute(trx);
        }
      });
    } catch (err) {
      rethrow("replaceOpportunities failed", err);
    }
    return this.listOpportunities(orgId, diagnosisId);
  }

  /**
   * Puts `draft` at its rank, in place of the opportunity that was there (same
   * id), and deletes the previous one's hypotheses. Never replaces another
   * org's row with the same id.
   */
  async putOpportunityAt(
    orgId: string,
    diagnosisId: string,
    draft: OpportunityDraft,
  ): Promise<UxOpportunity> {
    const id = opportunityId(diagnosisId, draft.rank);
    try {
      await this.db.transaction().execute(async (trx) => {
        await sql`
          DELETE FROM plan_ux_hypotheses
           WHERE opportunity_id = ${id} AND organization_id = ${orgId}
        `.execute(trx);
        await sql`
          INSERT INTO plan_ux_opportunities ${OPPORTUNITY_COLUMNS}
          SELECT ${opportunityValues(id, diagnosisId, draft, nowIso(), orgId)}
           WHERE NOT EXISTS (
             SELECT 1 FROM plan_ux_opportunities
              WHERE id = ${id} AND organization_id <> ${orgId})
          ON CONFLICT (id) DO UPDATE SET
            diagnosis_id = excluded.diagnosis_id, rank = excluded.rank,
            area = excluded.area, title = excluded.title,
            summary = excluded.summary, device = excluded.device,
            sources = excluded.sources, money = excluded.money,
            confidence = excluded.confidence, metric = excluded.metric,
            measured = excluded.measured, reliability = excluded.reliability,
            drilldown = excluded.drilldown, tree_notes = NULL, outcome = NULL,
            observations = excluded.observations,
            updated_at = excluded.updated_at
          WHERE plan_ux_opportunities.organization_id = excluded.organization_id
        `.execute(trx);
      });
    } catch (err) {
      rethrow("putOpportunityAt failed", err);
    }
    const saved = (await this.listOpportunities(orgId, diagnosisId)).find(
      (o) => o.id === id,
    );
    if (!saved) throw new Error(`oportunidade ${id} não gravou`);
    return saved;
  }

  /** Why the investigation of an opportunity stopped. */
  async saveOpportunityOutcome(
    orgId: string,
    id: string,
    outcome: OpportunityOutcome,
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_opportunities
           SET outcome = ${jsonb(outcome)}, updated_at = ${ts(nowIso())}
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveOpportunityOutcome failed", err);
    }
  }

  /**
   * Takes an opportunity off the main list WITHOUT deleting what was
   * investigated: the row becomes `<id>:sem-causa` (rank 100+), its
   * hypotheses move with it, and the original id is free for a reserve. Only
   * retires while the row is still the one that fell (same title), so a
   * replay does not retire the reserve.
   */
  async retireOpportunity(
    orgId: string,
    fallen: { id: string; title: string },
    outcome: OpportunityOutcome,
    to = retiredId(fallen.id),
  ): Promise<boolean> {
    try {
      const { rows } = await sql<{ title: string }>`
        SELECT title FROM plan_ux_opportunities
         WHERE id = ${fallen.id} AND organization_id = ${orgId}
      `.execute(this.db);
      if (!rows[0] || rows[0].title !== fallen.title) return false;
      await this.db.transaction().execute(async (trx) => {
        const moved = await sql`
          INSERT INTO plan_ux_opportunities
            (id, diagnosis_id, rank, area, title, summary, device, sources,
             money, confidence, metric, measured, reliability, drilldown,
             tree_notes, observations, outcome, updated_at, organization_id)
          SELECT ${to}, diagnosis_id, 100 + rank, area, title, summary, device,
                 sources, money, confidence, metric, measured, reliability,
                 drilldown, tree_notes, observations, ${jsonb(outcome)},
                 ${ts(nowIso())}, organization_id
            FROM plan_ux_opportunities
           WHERE id = ${fallen.id} AND organization_id = ${orgId}
             AND NOT EXISTS (
               SELECT 1 FROM plan_ux_opportunities
                WHERE id = ${to} AND organization_id <> ${orgId})
          ON CONFLICT (id) DO UPDATE SET
            diagnosis_id = excluded.diagnosis_id, rank = excluded.rank,
            area = excluded.area, title = excluded.title,
            summary = excluded.summary, device = excluded.device,
            sources = excluded.sources, money = excluded.money,
            confidence = excluded.confidence, metric = excluded.metric,
            measured = excluded.measured, reliability = excluded.reliability,
            drilldown = excluded.drilldown, tree_notes = excluded.tree_notes,
            observations = excluded.observations, outcome = excluded.outcome,
            updated_at = excluded.updated_at
          WHERE plan_ux_opportunities.organization_id = excluded.organization_id
        `.execute(trx);
        if (!Number(moved.numAffectedRows ?? 0)) {
          throw new Error(`oportunidade ${to} não gravou`);
        }
        // Hypothesis ids carry the opportunity id as prefix, so they move too.
        await sql`
          UPDATE plan_ux_hypotheses
             SET id = ${to}::text || substr(id, ${fallen.id.length + 1}::int),
                 opportunity_id = ${to}
           WHERE opportunity_id = ${fallen.id} AND organization_id = ${orgId}
        `.execute(trx);
        await sql`
          DELETE FROM plan_ux_opportunities
           WHERE id = ${fallen.id} AND organization_id = ${orgId}
        `.execute(trx);
      });
      return true;
    } catch (err) {
      rethrow("retireOpportunity failed", err);
    }
  }

  /** The tree categories that did not become a hypothesis here. */
  async saveOpportunityTreeNotes(
    orgId: string,
    id: string,
    notes: DiscardedCategory[],
  ): Promise<void> {
    try {
      await sql`
        UPDATE plan_ux_opportunities
           SET tree_notes = ${jsonb(notes)}, updated_at = ${ts(nowIso())}
         WHERE id = ${id} AND organization_id = ${orgId}
      `.execute(this.db);
    } catch (err) {
      rethrow("saveOpportunityTreeNotes failed", err);
    }
  }

  /** Takes an opportunity off the screen, with its hypotheses. */
  async deleteOpportunity(orgId: string, id: string): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        await sql`
          DELETE FROM plan_ux_hypotheses
           WHERE opportunity_id = ${id} AND organization_id = ${orgId}
        `.execute(trx);
        await sql`
          DELETE FROM plan_ux_opportunities
           WHERE id = ${id} AND organization_id = ${orgId}
        `.execute(trx);
      });
    } catch (err) {
      rethrow("deleteOpportunity failed", err);
    }
  }

  async listOpportunities(
    orgId: string,
    diagnosisId: string,
  ): Promise<UxOpportunity[]> {
    try {
      const { rows } = await sql<Row>`
        SELECT * FROM plan_ux_opportunities
         WHERE diagnosis_id = ${diagnosisId} AND organization_id = ${orgId}
         ORDER BY rank ASC
      `.execute(this.db);
      return rows.map(rowToOpportunity);
    } catch (err) {
      rethrow("listOpportunities failed", err);
    }
  }

  /** One of the org's opportunities, with its analysis' page type. */
  async getOpportunity(
    orgId: string,
    id: string,
  ): Promise<(UxOpportunity & { page_type: UxPageType }) | null> {
    try {
      const { rows } = await sql<Row>`
        SELECT o.*, d.page_type AS diagnosis_page_type
          FROM plan_ux_opportunities o
          JOIN plan_ux_diagnoses d
            ON d.id = o.diagnosis_id AND d.organization_id = o.organization_id
         WHERE o.id = ${id} AND o.organization_id = ${orgId}
      `.execute(this.db);
      const row = rows[0];
      return row
        ? {
            ...rowToOpportunity(row),
            page_type: asPageType(row.diagnosis_page_type),
          }
        : null;
    } catch (err) {
      rethrow("getOpportunity failed", err);
    }
  }

  /** ONE opportunity's hypotheses, replacing any it had. Id = opportunity + rank. */
  async replaceOpportunityHypotheses(
    orgId: string,
    diagnosisId: string,
    opportunity: string,
    drafts: HypothesisDraft[],
  ): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        await sql`
          DELETE FROM plan_ux_hypotheses
           WHERE opportunity_id = ${opportunity} AND organization_id = ${orgId}
        `.execute(trx);
        await this.insertHypotheses(
          trx,
          orgId,
          diagnosisId,
          drafts.map((h) => ({
            id: `${opportunity}:h${h.rank}`,
            draft: { ...h, opportunity_id: opportunity },
          })),
        );
      });
    } catch (err) {
      rethrow("replaceOpportunityHypotheses failed", err);
    }
  }

  /**
   * New hypotheses at the end of an opportunity's list, keeping the ones there
   * (a refuted one keeps its proof). Ranks continue; returns the ids written.
   */
  async appendOpportunityHypotheses(
    orgId: string,
    diagnosisId: string,
    opportunity: string,
    drafts: HypothesisDraft[],
  ): Promise<string[]> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const { rows } = await sql<{ last: number | string }>`
          SELECT COALESCE(MAX(rank), 0) AS last FROM plan_ux_hypotheses
           WHERE opportunity_id = ${opportunity} AND organization_id = ${orgId}
        `.execute(trx);
        const last = Number(rows[0]?.last ?? 0);
        const out = drafts.map((h, i) => {
          const rank = last + i + 1;
          // The run's relations point at ranks inside it (1, 2…).
          const tree = h.tree
            ? {
                ...h.tree,
                relacoes: h.tree.relacoes.map((r) => ({
                  ...r,
                  rank: r.rank + last,
                })),
              }
            : h.tree;
          return {
            id: `${opportunity}:h${rank}`,
            draft: { ...h, rank, tree, opportunity_id: opportunity },
          };
        });
        await this.insertHypotheses(trx, orgId, diagnosisId, out);
        return out.map((r) => r.id);
      });
    } catch (err) {
      rethrow("appendOpportunityHypotheses failed", err);
    }
  }

  // ── Benchmark ──────────────────────────────────────────────────────────────

  async getFreshBenchmark(
    orgId: string,
    domain: string,
    pageType: UxPageType = "pdp",
  ): Promise<BenchmarkPdp | null> {
    const cutoff = new Date(
      Date.now() - BENCHMARK_TTL_DAYS * 86_400_000,
    ).toISOString();
    try {
      const { rows } = await sql<Row>`
        SELECT * FROM plan_ux_benchmark_pdps
         WHERE organization_id = ${orgId}
           AND domain = ${benchmarkKey(domain, pageType)}
           AND captured_at >= ${ts(cutoff)}
      `.execute(this.db);
      const row = rows[0];
      if (!row) return null;
      const anatomy = fromJson<BenchmarkPdp["anatomy"] | null>(
        row.anatomy,
        null,
      );
      // A capture from before v2 has no per-area reading to cite: recapture.
      if (!anatomy?.by_area) return null;
      return {
        domain: str(row.domain).split("#")[0] ?? "",
        ...(pageType === "pdp" ? {} : { page_type: pageType }),
        url: str(row.url),
        screenshot_url: strOrNull(row.screenshot_url),
        full_url: strOrNull(row.full_url),
        anatomy,
        captured_at: str(row.captured_at),
      };
    } catch (err) {
      rethrow("getFreshBenchmark failed", err);
    }
  }

  async upsertBenchmark(orgId: string, b: BenchmarkPdp): Promise<void> {
    try {
      await sql`
        INSERT INTO plan_ux_benchmark_pdps
          (organization_id, domain, url, screenshot_url, full_url, anatomy,
           captured_at)
        VALUES (${orgId}, ${benchmarkKey(b.domain, b.page_type ?? "pdp")},
                ${b.url}, ${b.screenshot_url}, ${b.full_url},
                ${jsonb(b.anatomy)}, ${ts(b.captured_at)})
        ON CONFLICT (organization_id, domain) DO UPDATE SET
          url = excluded.url,
          screenshot_url = excluded.screenshot_url,
          full_url = excluded.full_url,
          anatomy = excluded.anatomy,
          captured_at = excluded.captured_at
      `.execute(this.db);
    } catch (err) {
      rethrow("upsertBenchmark failed", err);
    }
  }
}
