/**
 * Synthetic store-diagnosis payloads, shaped like the engine's tool output.
 * Every name, domain and number is made up.
 */

const MEDIA = "https://diagnosis.loja.example/api/media/org_example/ux";

const money = {
  assumption: "1 point more from product to cart on mobile",
  base: 120_000,
  base_label: "mobile product views per month",
  delta_pp: 1,
  value_per_event: 160,
  value_label: "average order value",
  monthly_value: 67_200,
  ceiling_monthly: 268_800,
  channel_share: 0.35,
};

const measured = {
  device: "mobile",
  n: 30_000,
  hits: 2_400,
  rate: 0.08,
  key: "produto_carrinho",
  label: "product to cart",
  source: "ga4",
  window_days: 7,
  comp: { device: "desktop", n: 9_000, hits: 1_080, rate: 0.12 },
  gap_pp: 4,
};

export const storeViewFixture = {
  pages: [
    {
      page_type: "home",
      diagnosis_id: "diag_home",
      analysed_at: "2026-11-20T12:00:00.000Z",
      status: "done",
      stage: null,
      progress_note: null,
      funnel: [
        { device: "mobile", people_week: 52_000, advance_rate: 0.41 },
        { device: "desktop", people_week: 14_000, advance_rate: 0.55 },
      ],
      capture_url: `${MEDIA}/diag_home/fold-mobile.png?exp=1&sig=abc`,
      observations: ["The hero takes the whole first screen on mobile."],
      gaps: [],
    },
    {
      page_type: "pdp",
      diagnosis_id: "diag_pdp",
      analysed_at: "2026-11-20T12:05:00.000Z",
      status: "done",
      stage: null,
      progress_note: null,
      funnel: [{ device: "mobile", people_week: 30_000, advance_rate: 0.08 }],
      capture_url: null,
      observations: [],
      gaps: [],
    },
  ],
  top: [
    {
      id: "opp_size",
      diagnosis_id: "diag_pdp",
      rank: 1,
      area: "tamanho",
      title: "On mobile, 92% of people who open a product do not add it",
      summary: "The size picker sits below the first screen.",
      device: "mobile",
      sources: [
        {
          source: "ga4",
          metric: "product to cart, mobile",
          value: "8%",
          window: "7 days",
          label: "fato_observado",
        },
      ],
      money,
      confidence: 0.7,
      metric: {
        key: "produto_carrinho",
        device: "mobile",
        compare_to: "desktop",
      },
      measured,
      reliability: {
        level: "alta",
        checks: [
          {
            code: "amostra",
            severity: "ok",
            label: "Sample",
            text: "30,000 people",
          },
        ],
      },
      outcome: null,
      observations: [{ text: "Size chips start at 900 px.", facts: ["F3"] }],
      updated_at: "2026-11-20T12:05:00.000Z",
      page_type: "pdp",
      hypotheses: [
        {
          id: "hyp_sticky",
          title: "A sticky buy bar on mobile",
          lifecycle: "pronta_para_experimento",
          verification: { verdict: "confirmada", summary: "c1 confirmed" },
          status: "pending",
        },
        {
          id: "hyp_photos",
          title: "Fewer photos before the size picker",
          lifecycle: "refutada",
          verification: { verdict: "desmentida", summary: "c2 refuted" },
          status: "pending",
        },
      ],
    },
    {
      id: "opp_hero",
      diagnosis_id: "diag_home",
      rank: 1,
      area: "home_destaque",
      title: "On mobile, 59% of people who land on home open no product",
      summary: "The first shelf starts below the first screen.",
      device: "mobile",
      sources: [],
      money: {
        ...money,
        assumption: "1 point more from home to product on mobile",
        base: 400_000,
        base_label: "mobile home visits per month",
        monthly_value: 224_000,
        ceiling_monthly: null,
      },
      confidence: 0.5,
      updated_at: "2026-11-20T12:00:00.000Z",
      page_type: "home",
      hypotheses: [
        {
          id: "hyp_shelf",
          title: "Move the first shelf above the fold",
          lifecycle: "em_investigacao",
          verification: null,
          status: "pending",
        },
      ],
    },
  ],
  others: [
    {
      id: "opp_shipping",
      diagnosis_id: "diag_pdp",
      rank: 2,
      area: "frete_entrega",
      title: "On desktop, shipping is computed by 3% of product visitors",
      summary: "The shipping field is hidden behind a link.",
      device: "desktop",
      sources: [],
      money: null,
      confidence: 0.3,
      updated_at: "2026-11-20T12:05:00.000Z",
      page_type: "pdp",
      hypotheses: [],
    },
  ],
  sources: ["GA4", "Deco Analytics", "Página ao vivo"],
  running: false,
};

/** A store whose analytics sources did not answer: no funnel, named gaps. */
export const storeViewWithGapsFixture = {
  pages: [
    {
      page_type: "pdp",
      diagnosis_id: "diag_gaps",
      analysed_at: "2026-11-21T09:00:00.000Z",
      status: "done",
      stage: null,
      progress_note: null,
      funnel: [],
      capture_url: `${MEDIA}/diag_gaps/fold-mobile.png?exp=1&sig=def`,
      observations: [],
      gaps: [
        "GA4: no dataset connected",
        "Deco Analytics: site not found",
        "Funil: esta análise não tem dado de funil da página",
      ],
    },
  ],
  top: [],
  others: [],
  sources: ["Página ao vivo"],
  running: false,
};

export const opportunityDetailFixture = {
  opportunity: {
    ...storeViewFixture.top[0],
    hypotheses: [
      {
        id: "hyp_sticky",
        diagnosis_id: "diag_pdp",
        opportunity_id: "opp_size",
        rank: 1,
        kind: "proposta",
        title: "A sticky buy bar on mobile",
        device: "mobile",
        evidence_md: "- 8% of mobile visitors add to cart",
        idea: "Keep size and buy button visible while scrolling",
        why: "The picker is out of view for most visitors",
        where: "Product/ProductDetails",
        money,
        confidence: 0.7,
        benchmark_refs: [],
        benchmark: [
          {
            domain: "outra-loja.example",
            url: null,
            what_they_do: "A fixed bar with size and buy",
          },
        ],
        before_url: `${MEDIA}/diag_pdp/before.png?exp=1&sig=ghi`,
        after_url: null,
        after_patch: null,
        mockup_error: null,
        status: "pending",
        status_note: null,
        code_status: null,
        verification: {
          verdict: "confirmada",
          summary: "c1 confirmed",
          runs: [
            {
              check: {
                id: "c1",
                claim: "The size picker starts below the fold",
                stage: "live",
                device: "mobile",
              },
              outcome: "confirma",
              observed: "Size chips at 900 px, fold at 740 px",
              screenshot_url: null,
              source_ref: null,
            },
          ],
          rewritten_from: null,
          verified_at: "2026-11-20T12:04:00.000Z",
        },
        lifecycle: "pronta_para_experimento",
        experiment: {
          controle: "Current page",
          variante: "Sticky buy bar",
          metrica_primaria: {
            key: "produto_carrinho",
            label: "product to cart",
            device: "mobile",
          },
          secundarias: [],
          guardrails: ["checkout rate"],
          metodo: "50/50 split",
          baseline: 0.08,
          weekly_at_step: 30_000,
          exposure: 0.9,
          weekly_eligible: 27_000,
          mde_pp: 0.5,
          direction: "sobe",
          n_per_group: 48_000,
          weeks: 4,
          measurable: true,
          mde_4_weeks_pp: 0.4,
          limitacoes: [],
        },
        review: {
          explica_o_gap: "parcial",
          resposta: "Explains part of the loss",
          falhas: [],
          reviewed_at: "2026-11-20T12:04:30.000Z",
        },
        relevance: {
          level: "alta",
          device: "mobile",
          views_week: 30_000,
          reach_pct: null,
          affected_pct: 90,
          affected_week: 27_000,
          basis: "Every mobile product view",
          signals: [],
          computed_at: "2026-11-20T12:04:00.000Z",
        },
        citations: [
          {
            id: "k_sticky",
            fonte: "Synthetic usability study",
            fonte_url: "https://research.loja.example/sticky",
            trecho: null,
          },
        ],
        updated_at: "2026-11-20T12:05:00.000Z",
      },
    ],
  },
};
