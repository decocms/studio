import { describe, expect, test } from "bun:test";
import { buildStoreView } from "./store-view.ts";
import type {
  DiagnosisEvidence,
  SiteProfile,
  UxDiagnosis,
  UxHypothesis,
  UxOpportunity,
  UxPageType,
} from "./types.ts";

const evidence = (
  over: Partial<DiagnosisEvidence> = {},
): DiagnosisEvidence => ({
  window_days: 7,
  platform_funnel: [],
  pdp_behaviour: [],
  revenue: null,
  products: [],
  captures: [],
  benchmark: [],
  gaps: [],
  ...over,
});

let clock = 0;
const diagnosis = (
  id: string,
  page_type: UxPageType,
  over: Partial<UxDiagnosis> = {},
): UxDiagnosis => {
  clock++;
  const at = new Date(Date.UTC(2026, 10, 1, 0, clock)).toISOString();
  return {
    id,
    page_type,
    site_run_id: `run-${id}`,
    goal_id: null,
    objective_statement: null,
    status: "done",
    stage: "done",
    progress_note: null,
    domain: "loja.example",
    summary: null,
    evidence: evidence(),
    error: null,
    cost_usd: null,
    started_at: at,
    finished_at: at,
    ...over,
  };
};

const opportunity = (
  id: string,
  diagnosis_id: string,
  monthly: number | null,
  over: Partial<UxOpportunity> = {},
): UxOpportunity => ({
  id,
  diagnosis_id,
  rank: 1,
  area: "tamanho",
  title: `perda ${id}`,
  summary: "",
  device: "mobile",
  sources: [],
  money:
    monthly === null
      ? null
      : {
          assumption: "",
          base: 1,
          base_label: "",
          delta_pp: 1,
          value_per_event: 1,
          value_label: "",
          monthly_value: monthly,
          ceiling_monthly: null,
          channel_share: 1,
        },
  confidence: 0.5,
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

const hypothesis = (
  id: string,
  o: UxOpportunity,
  over: Partial<UxHypothesis> = {},
): UxHypothesis => ({
  id,
  diagnosis_id: o.diagnosis_id,
  opportunity_id: o.id,
  rank: 1,
  kind: "proposta",
  title: `hipótese ${id}`,
  device: "mobile",
  evidence_md: "",
  idea: "",
  why: "",
  where: "",
  money: null,
  confidence: 0.5,
  benchmark_refs: [],
  benchmark: [],
  before_url: null,
  after_url: null,
  after_patch: null,
  mockup_error: null,
  status: "pending",
  status_note: null,
  code_status: null,
  code_note: null,
  code_before_url: null,
  code_after_url: null,
  code_diff: null,
  code_error: null,
  code_started_at: null,
  verification: null,
  lifecycle: "gerada",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe("buildStoreView", () => {
  test("uses the latest analysis of each page", () => {
    const old = diagnosis("d-old", "pdp");
    const fresh = diagnosis("d-new", "pdp");
    const view = buildStoreView({
      profile: null,
      diagnoses: [old, fresh],
      opportunities: [
        opportunity("o-old", old.id, 9_000),
        opportunity("o-new", fresh.id, 1_000),
      ],
      hypotheses: [],
    });
    expect(view.pages).toHaveLength(1);
    expect(view.pages[0]!.diagnosis_id).toBe("d-new");
    expect(view.pages[0]!.status).toBe("done");
    expect(ids([...view.top, ...view.others])).toEqual(["o-new"]);
    expect(view.running).toBe(false);
  });

  test("top 2 by monthly value, retired excluded", () => {
    const pdp = diagnosis("d-pdp", "pdp");
    const home = diagnosis("d-home", "home");
    const retired = opportunity("o-retired", pdp.id, 99_000, {
      outcome: { retired: true } as UxOpportunity["outcome"],
    });
    const a = opportunity("o-a", pdp.id, 5_000);
    const b = opportunity("o-b", home.id, 8_000, { area: "home_destaque" });
    const c = opportunity("o-c", pdp.id, 5_000, { confidence: 0.9 });
    const d = opportunity("o-d", home.id, null, { area: "home_vitrines" });
    const view = buildStoreView({
      profile: null,
      diagnoses: [pdp, home],
      opportunities: [retired, a, b, c, d],
      hypotheses: [
        hypothesis("h-a", a, {
          lifecycle: "condicao_confirmada",
          verification: {
            verdict: "confirmada",
            summary: "o teste viu",
            runs: [],
            rewritten_from: null,
            verified_at: "2026-11-01T00:00:00Z",
          },
        }),
        hypothesis("h-nao", a, { kind: "nao_faria", opportunity_id: null }),
      ],
    });
    expect(ids(view.top)).toEqual(["o-b", "o-c"]);
    expect(ids(view.others)).toEqual(["o-a", "o-d"]);
    expect(view.top[0]!.page_type).toBe("home");
    const withHyp = view.others[0];
    expect(withHyp!.hypotheses).toEqual([
      {
        id: "h-a",
        title: "hipótese h-a",
        lifecycle: "condicao_confirmada",
        verification: { verdict: "confirmada", summary: "o teste viu" },
        status: "pending",
      },
    ]);
  });

  test("filters by goal_id", () => {
    const forGoal = diagnosis("d-goal", "pdp", { goal_id: "goal-1" });
    const otherGoal = diagnosis("d-other", "pdp", { goal_id: "goal-2" });
    const noGoal = diagnosis("d-none", "home");
    const view = buildStoreView({
      profile: null,
      diagnoses: [forGoal, otherGoal, noGoal],
      opportunities: [
        opportunity("o-goal", forGoal.id, 1),
        opportunity("o-other", otherGoal.id, 2),
        opportunity("o-none", noGoal.id, 3, { area: "home_destaque" }),
      ],
      hypotheses: [],
      goalId: "goal-1",
    });
    expect(view.pages.map((p) => p.diagnosis_id)).toEqual(["d-goal"]);
    expect(ids(view.top)).toEqual(["o-goal"]);
    // Without a goal, the newest of each page applies, from any goal.
    const all = buildStoreView({
      profile: null,
      diagnoses: [forGoal, otherGoal, noGoal],
      opportunities: [],
      hypotheses: [],
    });
    expect(all.pages.map((p) => p.diagnosis_id)).toEqual(["d-none", "d-other"]);
  });

  test("running page keeps previous done results and marks running", () => {
    const done = diagnosis("d-done", "pdp", {
      evidence: evidence({
        captures: [
          {
            device: "mobile",
            url: "https://loja.example/p",
            product_id: null,
            viewport: { width: 390, height: 844 },
            page_height: 3000,
            fold_url: "https://app.example/api/media/org-a/ux/d-done/pdp-main",
            full_url: null,
            positions: {},
            has_sticky_buy: false,
            sold_out_signal: false,
            above_fold_outline: [],
            selectors: {},
            dom_excerpt: "",
          },
        ],
      }),
    });
    const running = diagnosis("d-running", "pdp", {
      status: "running",
      stage: "capture",
      progress_note: "abrindo a página",
      evidence: null,
      finished_at: null,
    });
    const view = buildStoreView({
      profile: null,
      diagnoses: [done, running],
      opportunities: [opportunity("o-done", done.id, 1_000)],
      hypotheses: [],
    });
    expect(view.running).toBe(true);
    const [page] = view.pages;
    expect(page!.diagnosis_id).toBe("d-running");
    expect(page!.status).toBe("running");
    expect(page!.stage).toBe("capture");
    expect(page!.progress_note).toBe("abrindo a página");
    expect(page!.analysed_at).toBe(done.finished_at as string);
    expect(page!.capture_url).toBe(
      "https://app.example/api/media/org-a/ux/d-done/pdp-main",
    );
    expect(ids(view.top)).toEqual(["o-done"]);
  });

  test("gaps are surfaced per page", () => {
    const pdp = diagnosis("d-pdp", "pdp", {
      evidence: evidence({
        gaps: [
          { source: "bigquery", error: "BigQuery não configurado na app" },
          { source: "heatmap", error: "sem coleta" },
        ],
      }),
    });
    const home = diagnosis("d-home", "home", {
      evidence: evidence({
        pdp_behaviour: [
          {
            device: "mobile",
            views: 1_400,
            avg_depth_pct: 40,
            avg_fold_pct: 20,
            active_seconds: 30,
            clicks: 10,
            dead_clicks: 1,
            reach: { p25: 80, p50: 50, p75: 20 },
            funnel: { visitors: 1_000, viewed: 400, carted: 50 },
            sections: [],
          },
        ],
      }),
    });
    const view = buildStoreView({
      profile: null,
      diagnoses: [pdp, home],
      opportunities: [],
      hypotheses: [],
    });
    const byPage = new Map(view.pages.map((p) => [p.page_type, p]));
    expect(byPage.get("pdp")?.gaps).toEqual([
      "GA4: BigQuery não configurado na app",
      "Deco Analytics: sem coleta",
    ]);
    expect(byPage.get("pdp")?.funnel).toEqual([]);
    expect(byPage.get("home")?.gaps).toEqual([]);
    expect(byPage.get("home")?.funnel).toEqual([
      { device: "mobile", people_week: 1_000, advance_rate: 0.4 },
    ]);
    expect(view.sources).toEqual(["Deco Analytics"]);
  });

  test("gap_details carry an owner and the same text as gaps", () => {
    const pdp = diagnosis("d-pdp", "pdp", {
      evidence: evidence({
        gaps: [
          {
            source: "heatmap",
            error: 'o site "loja" não está registrado no Deco Analytics',
            key: "analytics_install",
            owner: "customer",
          },
          { source: "vtex", error: "produtos: 503", owner: "external" },
        ],
      }),
    });
    const home = diagnosis("d-home", "home", {
      evidence: evidence({
        gaps: [{ source: "browser", error: "captura mobile: timeout" }],
      }),
    });
    const view = buildStoreView({
      profile: null,
      diagnoses: [pdp, home],
      opportunities: [],
      hypotheses: [],
    });
    const byPage = new Map(view.pages.map((p) => [p.page_type, p]));
    const page = byPage.get("pdp");
    expect(page?.gap_details).toEqual([
      {
        source: "heatmap",
        owner: "customer",
        key: "analytics_install",
        message:
          'Deco Analytics: o site "loja" não está registrado no Deco Analytics',
      },
      { source: "vtex", owner: "external", message: "VTEX: produtos: 503" },
    ]);
    expect(page?.gap_details.map((g) => g.message)).toEqual(page?.gaps);
    // The funnel row is not a source gap: it goes as ours, from GA4.
    expect(byPage.get("home")?.gap_details).toEqual([
      {
        source: "browser",
        owner: "ours",
        message: "Página ao vivo: captura mobile: timeout",
      },
      {
        source: "bigquery",
        owner: "ours",
        message: "Funil: esta análise não tem dado de funil da página",
      },
    ]);
    expect(byPage.get("home")?.gaps).toEqual(
      byPage.get("home")?.gap_details.map((g) => g.message),
    );
  });

  test("setup asks for what the chosen pages' customer gaps need", () => {
    const customerGap = {
      source: "heatmap" as const,
      error: "não registrado",
      key: "analytics_install" as const,
      owner: "customer" as const,
    };
    const old = diagnosis("d-old", "pdp", {
      evidence: evidence({
        gaps: [
          {
            source: "lake",
            error: "receita por canal: x",
            key: "orders",
            owner: "customer",
          },
        ],
      }),
    });
    const pdp = diagnosis("d-pdp", "pdp", {
      evidence: evidence({ gaps: [customerGap] }),
    });
    const home = diagnosis("d-home", "home", {
      evidence: evidence({ gaps: [customerGap] }),
    });
    const profile: SiteProfile = {
      domain: "www.loja.example",
      studio_site: null,
      pdp_path_template: "/:slug/p",
      competitors: ["concorrente.example"],
      competitors_confirmed_at: null,
      design_system: null,
      design_system_at: null,
      code_tokens: null,
      sources: null,
      code_repo: null,
      code_project_id: null,
      code_volume: null,
      updated_at: "2026-11-20T00:00:00.000Z",
    };
    const view = buildStoreView({
      profile,
      diagnoses: [old, pdp, home],
      opportunities: [],
      hypotheses: [],
    });
    // The old PDP analysis is not the chosen one: its gap asks for nothing.
    expect(view.setup).toEqual({
      needs: [
        {
          key: "competitors",
          blocking: false,
          suggested: ["concorrente.example"],
        },
        { key: "analytics_install", blocking: false },
      ],
      current: {
        domain: "www.loja.example",
        competitors: ["concorrente.example"],
      },
    });
    expect(
      buildStoreView({
        profile: null,
        diagnoses: [],
        opportunities: [],
        hypotheses: [],
      }).setup.needs,
    ).toEqual([{ key: "domain", blocking: true, suggested: null }]);
  });
});
