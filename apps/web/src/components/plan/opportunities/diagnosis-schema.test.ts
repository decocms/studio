import { describe, expect, it } from "bun:test";
import {
  DecideHypothesisSchema,
  GetOpportunitySchema,
  ListSiteRunsSchema,
  StartRunSchema,
  StoreViewSchema,
  parseToolResult,
  storeViewRefetchInterval,
  toolPayload,
} from "./diagnosis-schema.ts";
import {
  opportunityDetailFixture,
  siteRunsFixture,
  storeViewFixture,
  storeViewWithGapsFixture,
} from "./fixtures.ts";

function parsedView(raw: unknown) {
  const result = parseToolResult(StoreViewSchema, raw);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

describe("parseToolResult", () => {
  it("parses a full store view fixture", () => {
    const view = parsedView(storeViewFixture);
    expect(view.pages.map((p) => p.page_type)).toEqual(["home", "pdp"]);
    expect(view.top.map((o) => o.id)).toEqual(["opp_size", "opp_hero"]);
    expect(view.others.map((o) => o.id)).toEqual(["opp_shipping"]);
    expect(view.sources).toEqual(["GA4", "Deco Analytics", "Página ao vivo"]);
    expect(view.running).toBe(false);

    const [size] = view.top;
    expect(size?.money?.monthly_value).toBe(1_900_000);
    expect(size?.measured?.comp?.device).toBe("desktop");
    expect(size?.reliability?.level).toBe("alta");
    expect(size?.hypotheses.map((h) => h.lifecycle)).toEqual([
      "pronta_para_experimento",
      "refutada",
    ]);
    expect(size?.hypotheses[1]?.verification?.verdict).toBe("desmentida");
  });

  it("missing optional fields parse", () => {
    const view = parsedView(storeViewFixture);
    const hero = view.top[1];
    expect(hero?.metric).toBeUndefined();
    expect(hero?.measured).toBeUndefined();
    expect(hero?.reliability).toBeUndefined();
    expect(hero?.observations).toBeUndefined();
    expect(hero?.hypotheses[0]?.verification).toBeNull();
    expect(view.others[0]?.money).toBeNull();
    expect(view.pages[1]?.capture_url).toBeNull();

    const [first] = storeViewFixture.top;
    const { sources: _sources, ...withoutLabel } = first ?? {};
    const bare = {
      ...withoutLabel,
      sources: [{ source: "ga4", metric: "m", value: "1%", window: null }],
    };
    const result = parseToolResult(StoreViewSchema, {
      ...storeViewFixture,
      top: [bare],
    });
    expect(result.ok).toBe(true);
  });

  it("unknown lifecycle falls back to unknown", () => {
    const [size] = storeViewFixture.top;
    const view = parsedView({
      ...storeViewFixture,
      top: [
        {
          ...size,
          hypotheses: [
            {
              id: "hyp_new",
              title: "A state the engine added later",
              lifecycle: "em_revisao_humana",
              verification: { verdict: "parcialmente", summary: "?" },
              status: "pending",
            },
            {
              id: "hyp_missing",
              title: "No lifecycle at all",
              verification: null,
              status: "pending",
            },
          ],
        },
      ],
    });
    const hypotheses = view.top[0]?.hypotheses ?? [];
    expect(hypotheses.map((h) => h.lifecycle)).toEqual(["unknown", "unknown"]);
    expect(hypotheses[0]?.verification?.verdict).toBe("unknown");

    const detail = parseToolResult(GetOpportunitySchema, {
      opportunity: {
        ...opportunityDetailFixture.opportunity,
        hypotheses: opportunityDetailFixture.opportunity.hypotheses.map(
          (h) => ({ ...h, lifecycle: "nova_fase" }),
        ),
      },
    });
    expect(detail.ok && detail.value.opportunity.hypotheses[0]?.lifecycle).toBe(
      "unknown",
    );
  });

  it("motor {error} becomes ok:false with the message", () => {
    expect(
      parseToolResult(StoreViewSchema, {
        error: "oportunidade não encontrada",
      }),
    ).toEqual({ ok: false, error: "oportunidade não encontrada" });
    // start_ux_diagnosis answers errors as { status: "error", error }.
    expect(
      parseToolResult(StartRunSchema, {
        status: "error",
        error: "configure o domínio da loja",
        needs_domain: true,
      }),
    ).toEqual({ ok: false, error: "configure o domínio da loja" });
    // A tool-level error in the MCP result carries the message as text.
    expect(
      parseToolResult(
        StoreViewSchema,
        toolPayload({
          isError: true,
          content: [{ type: "text", text: "engine unavailable" }],
        }),
      ),
    ).toEqual({ ok: false, error: "engine unavailable" });
  });

  it("garbage payload becomes ok:false", () => {
    for (const raw of [
      null,
      undefined,
      "<html>502</html>",
      42,
      [],
      { pages: "home" },
      { ...storeViewFixture, running: "yes" },
      { ...storeViewFixture, pages: [{ page_type: "checkout_v9" }] },
      { error: 500 },
    ]) {
      const result = parseToolResult(StoreViewSchema, raw);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.length > 0).toBe(true);
    }
  });

  it("view with gaps keeps them", () => {
    const view = parsedView(storeViewWithGapsFixture);
    const [page] = view.pages;
    expect(page?.funnel).toEqual([]);
    expect(page?.gaps).toEqual([
      "GA4: no dataset connected",
      "Deco Analytics: site not found",
      "Funil: esta análise não tem dado de funil da página",
    ]);
    expect(view.sources).toEqual(["Página ao vivo"]);
    expect(view.top).toEqual([]);
  });

  it("parses an opportunity detail with experiment, review and citations", () => {
    const result = parseToolResult(
      GetOpportunitySchema,
      opportunityDetailFixture,
    );
    if (!result.ok) throw new Error(result.error);
    const [hypothesis] = result.value.opportunity.hypotheses;
    expect(result.value.opportunity.page_type).toBe("pdp");
    expect(hypothesis?.experiment?.weeks).toBe(4);
    expect(hypothesis?.review?.explica_o_gap).toBe("parcial");
    expect(hypothesis?.relevance?.reach_pct).toBeNull();
    expect(hypothesis?.citations[0]?.fonte_url).toBe(
      "https://research.loja.example/sticky",
    );
    expect(hypothesis?.verification?.runs[0]?.outcome).toBe("confirma");
  });

  it("parses site runs and a started run", () => {
    const runs = parseToolResult(ListSiteRunsSchema, siteRunsFixture);
    expect(runs.ok && runs.value.runs.map((r) => r.goal_id)).toEqual([
      "goal_a",
      null,
    ]);
    const started = parseToolResult(StartRunSchema, {
      status: "started",
      site_run_id: "run_3",
      diagnoses: [
        { page_type: "pdp", diagnosis_id: "diag_pdp", already_running: true },
      ],
    });
    expect(started.ok && started.value.diagnoses[0]?.already_running).toBe(
      true,
    );
  });

  it("reads a decided hypothesis and the engine's refusal to approve", () => {
    const [hypothesis] = opportunityDetailFixture.opportunity.hypotheses;
    const decided = parseToolResult(DecideHypothesisSchema, {
      hypothesis: { ...hypothesis, status: "dismissed" },
    });
    expect(decided.ok && decided.value.hypothesis).toEqual({
      id: "hyp_sticky",
      opportunity_id: "opp_size",
      status: "dismissed",
    });
    expect(
      parseToolResult(DecideHypothesisSchema, {
        error: "Só dá pra aprovar pra teste a hipótese pronta",
      }),
    ).toEqual({
      ok: false,
      error: "Só dá pra aprovar pra teste a hipótese pronta",
    });
  });
});

describe("toolPayload", () => {
  it("prefers structuredContent", () => {
    expect(
      toolPayload({
        structuredContent: { running: true },
        content: [{ type: "text", text: '{"running":false}' }],
      }),
    ).toEqual({ running: true });
  });

  it("reads JSON from the text content when there is no structuredContent", () => {
    expect(
      toolPayload({ content: [{ type: "text", text: '{"runs":[]}' }] }),
    ).toEqual({ runs: [] });
  });

  it("keeps non-JSON text so the schema rejects it", () => {
    const raw = toolPayload({ content: [{ type: "text", text: "oops" }] });
    expect(parseToolResult(ListSiteRunsSchema, raw).ok).toBe(false);
  });

  it("names an error result that has no text", () => {
    const raw = toolPayload({ isError: true, content: [] });
    const result = parseToolResult(StoreViewSchema, raw);
    expect(!result.ok && result.error.length > 0).toBe(true);
  });
});

describe("storeViewRefetchInterval", () => {
  it("polls every 5s only while the view is running", () => {
    const view = parsedView(storeViewFixture);
    expect(
      storeViewRefetchInterval({ ok: true, value: { ...view, running: true } }),
    ).toBe(5000);
    expect(storeViewRefetchInterval({ ok: true, value: view })).toBe(false);
    expect(storeViewRefetchInterval({ ok: false, error: "down" })).toBe(false);
    expect(storeViewRefetchInterval(undefined)).toBe(false);
  });
});
