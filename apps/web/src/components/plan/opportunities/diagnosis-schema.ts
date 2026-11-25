/**
 * Zod mirror of the store-diagnosis engine's tool output (its `contract.ts`),
 * for the Plan page. The engine is an external connection: every answer goes
 * through these schemas, and an unexpected shape becomes `{ ok: false }`,
 * never a cast. Unknown extra fields are dropped, so engine additions do not
 * break the page; a new `lifecycle` or `verdict` reads as `"unknown"`.
 */

import { z } from "zod";

const PAGE_TYPES = [
  "home",
  "categoria",
  "busca",
  "pdp",
  "carrinho_checkout",
] as const;
const PageTypeSchema = z.enum(PAGE_TYPES);
export type PageType = z.infer<typeof PageTypeSchema>;

const DeviceSchema = z.enum(["mobile", "desktop"]);
const OpportunityDeviceSchema = z.enum(["mobile", "desktop", "ambos"]);
const DiagnosisStatusSchema = z.enum(["running", "done", "error"]);
const HypothesisStatusSchema = z.enum(["pending", "approved", "dismissed"]);

const LifecycleSchema = z
  .enum([
    "gerada",
    "em_investigacao",
    "condicao_confirmada",
    "relevancia_avaliada",
    "pronta_para_experimento",
    "refutada",
    "inconclusiva",
    "bloqueada",
    "sem_relevancia",
    "unknown",
  ])
  .catch("unknown");
export type Lifecycle = z.infer<typeof LifecycleSchema>;

const VerdictSchema = z
  .enum(["confirmada", "desmentida", "reescrita", "inconclusiva", "unknown"])
  .catch("unknown");
export type Verdict = z.infer<typeof VerdictSchema>;

const MoneyEstimateSchema = z.object({
  assumption: z.string(),
  base: z.number(),
  base_label: z.string(),
  delta_pp: z.number(),
  value_per_event: z.number(),
  value_label: z.string(),
  monthly_value: z.number(),
  ceiling_monthly: z.number().nullable(),
  channel_share: z.number(),
});
export type MoneyEstimate = z.infer<typeof MoneyEstimateSchema>;

/** `source`, `area` and the store sources are labels the UI shows, so a new
 *  value from the engine reads as text instead of failing the whole view. */
const SourceRefSchema = z.object({
  source: z.string(),
  metric: z.string(),
  value: z.string(),
  window: z.string().nullable(),
  label: z.string().nullable().optional(),
});

const MetricSampleSchema = z.object({
  device: DeviceSchema,
  n: z.number(),
  hits: z.number(),
  rate: z.number(),
});

const MeasuredMetricSchema = MetricSampleSchema.extend({
  key: z.string(),
  label: z.string(),
  source: z.string(),
  window_days: z.number(),
  comp: MetricSampleSchema.nullable(),
  gap_pp: z.number().nullable(),
  fallback: z.boolean().nullable().optional(),
});

const MetricRefSchema = z.object({
  key: z.string(),
  device: DeviceSchema,
  compare_to: DeviceSchema.nullable(),
  control: z.string().nullable().optional(),
});

const ReliabilitySchema = z.object({
  level: z.enum(["alta", "media", "baixa"]),
  checks: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["ok", "info", "atencao", "bloqueia"]),
      label: z.string(),
      text: z.string(),
    }),
  ),
});

const OutcomeSchema = z.object({
  stop: z.string(),
  retired: z.boolean(),
  note: z.string(),
});

const OpportunitySchema = z.object({
  id: z.string(),
  diagnosis_id: z.string(),
  rank: z.number(),
  area: z.string(),
  title: z.string(),
  summary: z.string(),
  device: OpportunityDeviceSchema,
  sources: z.array(SourceRefSchema),
  money: MoneyEstimateSchema.nullable(),
  confidence: z.number(),
  metric: MetricRefSchema.nullable().optional(),
  measured: MeasuredMetricSchema.nullable().optional(),
  reliability: ReliabilitySchema.nullable().optional(),
  outcome: OutcomeSchema.nullable().optional(),
  observations: z
    .array(z.object({ text: z.string(), facts: z.array(z.string()) }))
    .nullable()
    .optional(),
  updated_at: z.string(),
  page_type: PageTypeSchema,
});

// ── get_ux_store_view ────────────────────────────────────────────────────────

const StoreOpportunityHypothesisSchema = z.object({
  id: z.string(),
  title: z.string(),
  lifecycle: LifecycleSchema,
  verification: z
    .object({ verdict: VerdictSchema, summary: z.string() })
    .nullable(),
  status: HypothesisStatusSchema,
});
export type StoreOpportunityHypothesis = z.infer<
  typeof StoreOpportunityHypothesisSchema
>;

const StoreOpportunitySchema = OpportunitySchema.extend({
  hypotheses: z.array(StoreOpportunityHypothesisSchema),
});
export type StoreOpportunity = z.infer<typeof StoreOpportunitySchema>;

/** A date the page formats; one that does not parse fails the view instead
 *  of throwing while it renders. */
const DateStringSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Expected a date");

const GapDetailSchema = z.object({
  source: z.string(),
  owner: z.string(),
  key: z.string().optional(),
  message: z.string(),
});
export type GapDetail = z.infer<typeof GapDetailSchema>;

const StorePageSchema = z.object({
  page_type: PageTypeSchema,
  diagnosis_id: z.string(),
  analysed_at: DateStringSchema,
  status: DiagnosisStatusSchema,
  stage: z.string().nullable(),
  progress_note: z.string().nullable(),
  funnel: z.array(
    z.object({
      device: DeviceSchema,
      people_week: z.number(),
      advance_rate: z.number(),
    }),
  ),
  capture_url: z.string().nullable(),
  observations: z.array(z.string()),
  gaps: z.array(z.string()),
  gap_details: z.array(GapDetailSchema).optional(),
});
export type StorePage = z.infer<typeof StorePageSchema>;

const SETUP_KEYS = [
  "domain",
  "competitors",
  "analytics_install",
  "bigquery",
  "orders",
] as const;
export const SetupKeySchema = z.enum(SETUP_KEYS);
export type SetupKey = z.infer<typeof SetupKeySchema>;

/** A key this Studio does not know stays a string, so a new engine need does
 *  not fail the view; callers narrow it with `isSetupKey`. */
export function isSetupKey(key: string): key is SetupKey {
  return SetupKeySchema.safeParse(key).success;
}

const SetupNeedSchema = z.object({
  key: z.string(),
  blocking: z.boolean(),
  suggested: z.array(z.string()).nullable().optional(),
});
export type SetupNeed = z.infer<typeof SetupNeedSchema>;

const SetupSchema = z.object({
  needs: z.array(SetupNeedSchema),
  current: z.object({
    domain: z.string().nullable(),
    competitors: z.array(z.string()),
  }),
});

export const StoreViewSchema = z.object({
  pages: z.array(StorePageSchema),
  top: z.array(StoreOpportunitySchema),
  others: z.array(StoreOpportunitySchema),
  sources: z.array(z.string()),
  running: z.boolean(),
  setup: SetupSchema.optional(),
});
export type StoreView = z.infer<typeof StoreViewSchema>;

// ── get_ux_opportunity ───────────────────────────────────────────────────────

const VerificationSchema = z.object({
  verdict: VerdictSchema,
  summary: z.string(),
  runs: z.array(
    z.object({
      check: z.object({
        id: z.string(),
        claim: z.string(),
        stage: z.string(),
        device: DeviceSchema,
      }),
      outcome: z.string(),
      observed: z.string(),
      screenshot_url: z.string().nullable(),
      source_ref: z.string().nullable(),
      measures_cause: z.boolean().nullable().optional(),
    }),
  ),
  rewritten_from: z.object({ title: z.string(), why: z.string() }).nullable(),
  verified_at: z.string(),
});

const ExperimentSchema = z.object({
  controle: z.string(),
  variante: z.string(),
  metrica_primaria: z.object({
    key: z.string(),
    label: z.string(),
    device: DeviceSchema,
  }),
  secundarias: z.array(z.string()),
  guardrails: z.array(z.string()),
  metodo: z.string(),
  baseline: z.number(),
  weekly_at_step: z.number(),
  exposure: z.number(),
  weekly_eligible: z.number(),
  mde_pp: z.number(),
  direction: z.enum(["sobe", "desce"]),
  n_per_group: z.number(),
  weeks: z.number(),
  measurable: z.boolean(),
  mde_4_weeks_pp: z.number().nullable(),
  limitacoes: z.array(z.string()),
});

const ReviewSchema = z.object({
  explica_o_gap: z.enum(["sim", "parcial", "nao"]),
  resposta: z.string(),
  falhas: z.array(z.string()),
  reviewed_at: z.string(),
});

const RelevanceSchema = z.object({
  level: z.enum(["alta", "media", "baixa", "sem_relevancia"]),
  device: DeviceSchema,
  views_week: z.number(),
  reach_pct: z.number().nullable(),
  affected_pct: z.number(),
  affected_week: z.number(),
  basis: z.string(),
  signals: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      ratio: z.number().nullable(),
    }),
  ),
  computed_at: z.string(),
});

const CitationSchema = z.object({
  id: z.string(),
  fonte: z.string(),
  fonte_url: z.string().nullable(),
  trecho: z.string().nullable(),
});

/** The engine's `UxHypothesis` has many more fields; these are the ones the
 *  Plan renders. */
const OpportunityHypothesisSchema = z.object({
  id: z.string(),
  diagnosis_id: z.string(),
  opportunity_id: z.string().nullable(),
  rank: z.number(),
  kind: z.enum(["proposta", "nao_faria"]),
  title: z.string(),
  device: OpportunityDeviceSchema,
  evidence_md: z.string(),
  idea: z.string(),
  why: z.string(),
  where: z.string(),
  money: MoneyEstimateSchema.nullable(),
  confidence: z.number(),
  benchmark: z.array(
    z.object({
      domain: z.string(),
      url: z.string().nullable(),
      what_they_do: z.string(),
    }),
  ),
  before_url: z.string().nullable(),
  after_url: z.string().nullable(),
  status: HypothesisStatusSchema,
  status_note: z.string().nullable(),
  verification: VerificationSchema.nullable(),
  lifecycle: LifecycleSchema,
  experiment: ExperimentSchema.nullable(),
  review: ReviewSchema.nullable(),
  relevance: RelevanceSchema.nullable(),
  citations: z.array(CitationSchema),
  updated_at: z.string(),
});
export type OpportunityHypothesis = z.infer<typeof OpportunityHypothesisSchema>;

const OpportunityDetailSchema = OpportunitySchema.extend({
  hypotheses: z.array(OpportunityHypothesisSchema),
});
export type OpportunityDetail = z.infer<typeof OpportunityDetailSchema>;

export const GetOpportunitySchema = z.object({
  opportunity: OpportunityDetailSchema,
});

// ── start_ux_diagnosis / update_ux_hypothesis_status ─────────────────────────

/** The `{ status: "error", error }` branch is read by `parseToolResult`. */
export const StartRunSchema = z.object({
  status: z.literal("started"),
  site_run_id: z.string(),
  diagnoses: z.array(
    z.object({
      page_type: PageTypeSchema,
      diagnosis_id: z.string(),
      already_running: z.boolean(),
    }),
  ),
});
export type StartRunResult = z.infer<typeof StartRunSchema>;

/** What `start_ux_diagnosis` takes: the whole site or the chosen pages. */
export interface StartRunInput {
  todas?: true;
  pages?: PageType[];
  goal_id?: string;
  objective_statement?: string;
}

export const DecideHypothesisSchema = z.object({
  hypothesis: z.object({
    id: z.string(),
    opportunity_id: z.string().nullable(),
    status: HypothesisStatusSchema,
  }),
});

// ── get_ux_site_profile / update_ux_site_profile ─────────────────────────────

const CompetitorRejectionSchema = z.object({
  domain: z.string(),
  reason: z.string(),
});
export type CompetitorRejection = z.infer<typeof CompetitorRejectionSchema>;

/** The store the engine analyses. Only the domain and competitors are read
 *  here; null until someone sets it or the engine finds the store's site in
 *  Studio. */
export const SiteProfileSchema = z.object({
  profile: z
    .object({
      domain: z.string(),
      competitors: z.array(z.string()).optional(),
    })
    .nullable(),
});

/** `update_ux_site_profile`: `warnings` are competitors kept but unchecked. */
export const UpdateProfileSchema = SiteProfileSchema.extend({
  warnings: z.array(CompetitorRejectionSchema).optional(),
});

// ── Reading a tool result ────────────────────────────────────────────────────

export type ParsedToolResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      needs_domain?: true;
      needs: SetupNeed[];
      rejected: CompetitorRejection[];
    };

/** `needs_domain`: `start_ux_diagnosis` refused because the store has no
 *  domain. `rejected`: competitors that did not answer. */
const ToolErrorSchema = z.object({
  error: z.string(),
  needs_domain: z.boolean().optional(),
  needs: z.array(SetupNeedSchema).optional(),
  rejected: z.array(CompetitorRejectionSchema).optional(),
});

const CallToolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ text: z.string().optional() })).optional(),
});

/** Why a call failed when neither the engine nor the schema named it. */
const UNNAMED_TOOL_ERROR = "The store diagnosis call failed";

/**
 * The tool's answer inside an MCP `callTool` result: `structuredContent`, else
 * the JSON in the text content. `isError` becomes the engine's `{ error }`.
 */
export function toolPayload(result: unknown): unknown {
  const parsed = CallToolResultSchema.safeParse(result);
  if (!parsed.success) return result;
  const { isError, structuredContent, content } = parsed.data;
  const text = content?.find((c) => c.text !== undefined)?.text;
  if (isError) return { error: text || UNNAMED_TOOL_ERROR };
  if (structuredContent !== undefined) return structuredContent;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The engine's `{ error }` keeps its message; any other unexpected shape
 *  becomes an error naming what did not match. */
export function parseToolResult<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): ParsedToolResult<T> {
  const engineError = ToolErrorSchema.safeParse(raw);
  if (engineError.success) {
    const { error, needs_domain, needs = [], rejected = [] } = engineError.data;
    const blocksOnDomain = needs.some((n) => n.key === "domain" && n.blocking);
    return {
      ok: false,
      error: error || UNNAMED_TOOL_ERROR,
      ...(needs_domain || blocksOnDomain
        ? { needs_domain: true as const }
        : {}),
      needs,
      rejected,
    };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: z.prettifyError(parsed.error),
    needs: [],
    rejected: [],
  };
}
