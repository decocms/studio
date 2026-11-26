import { describe, expect, it } from "bun:test";
import {
  GetOpportunitySchema,
  type Lifecycle,
  StartRunSchema,
  type OpportunityHypothesis,
  StoreViewSchema,
  parseToolResult,
  type StoreOpportunity,
  type StoreOpportunityHypothesis,
  type StorePage,
  type StoreView,
  type StartRunResult,
} from "./diagnosis-schema.ts";
import { DiagnosisEngineError, unwrapEngineResult } from "./diagnosis-state.ts";
import {
  opportunityDetailFixture,
  storeViewFixture,
  storeViewWithGapsFixture,
  storeViewWithSetupFixture,
} from "./fixtures.ts";
import {
  canApprove,
  cardState,
  confidenceLevel,
  dataBadge,
  defaultStorePage,
  detailFailure,
  detailHypotheses,
  hypothesisActions,
  formatCount,
  formatMoney,
  formatPercent,
  hypothesesTally,
  hypothesisLine,
  pageLosses,
  parseOpportunityId,
  readyHypothesis,
  runRefusal,
  runRequestedEvent,
  runnablePages,
  runningElsewhere,
  safeHref,
  safeImageSrc,
  sectionPhase,
  showsAnalysedAt,
  stageCards,
  startRunInput,
  summaryNumbers,
  gapGroups,
  setupNeeds,
  viewGaps,
  viewScope,
} from "./opportunity-view.ts";

const view: StoreView = StoreViewSchema.parse(storeViewFixture);
const [sizeLoss, heroLoss] = view.top as [StoreOpportunity, StoreOpportunity];

function hypothesis(
  overrides: Partial<StoreOpportunityHypothesis> & { id: string },
): StoreOpportunityHypothesis {
  return {
    title: `Hypothesis ${overrides.id}`,
    lifecycle: "em_investigacao",
    verification: null,
    status: "pending",
    ...overrides,
  };
}

function withHypotheses(
  hypotheses: StoreOpportunityHypothesis[],
): StoreOpportunity {
  return { ...sizeLoss, hypotheses };
}

/** Intl separates the currency and the unit with no-break spaces. */
const plain = (s: string) => s.replace(/\s/g, " ");

describe("cardState", () => {
  it("is ready when a hypothesis is ready to test", () => {
    expect(cardState(sizeLoss)).toBe("ready");
  });

  it("is investigating without a ready hypothesis", () => {
    expect(cardState(heroLoss)).toBe("investigating");
    expect(cardState(withHypotheses([]))).toBe("investigating");
  });

  it("a dismissed hypothesis does not make the card ready", () => {
    const dismissed = hypothesis({
      id: "h1",
      lifecycle: "pronta_para_experimento",
      status: "dismissed",
    });
    expect(cardState(withHypotheses([dismissed]))).toBe("investigating");
  });
});

describe("dataBadge", () => {
  it("reads the reliability level", () => {
    expect(dataBadge(sizeLoss)).toBe("reliable");
    const low = {
      ...sizeLoss,
      reliability: { level: "baixa" as const, checks: [] },
    };
    expect(dataBadge(low)).toBe("low_sample");
    const mid = {
      ...sizeLoss,
      reliability: { level: "media" as const, checks: [] },
    };
    expect(dataBadge(mid)).toBeNull();
  });

  it("is null without a reliability read", () => {
    expect(dataBadge(heroLoss)).toBeNull();
    expect(dataBadge({ ...sizeLoss, reliability: null })).toBeNull();
  });
});

describe("hypothesisLine", () => {
  it("strikes a refuted hypothesis", () => {
    const refuted = sizeLoss.hypotheses[1];
    if (!refuted) throw new Error("fixture has a refuted hypothesis");
    expect(hypothesisLine(refuted)).toEqual({
      text: "Fewer photos before the size picker",
      verdict: "refuted",
      strike: true,
    });
  });

  it("does not strike the other verdicts", () => {
    const confirmed = hypothesisLine(
      hypothesis({
        id: "c",
        verification: { verdict: "confirmada", summary: "" },
      }),
    );
    expect(confirmed).toMatchObject({ verdict: "confirmed", strike: false });
    const inconclusive = hypothesisLine(
      hypothesis({
        id: "i",
        lifecycle: "inconclusiva",
        verification: { verdict: "inconclusiva", summary: "" },
      }),
    );
    expect(inconclusive).toMatchObject({
      verdict: "inconclusive",
      strike: false,
    });
    expect(hypothesisLine(hypothesis({ id: "p" }))).toMatchObject({
      verdict: "pending",
      strike: false,
    });
  });

  it("a rewritten cause reads as its lifecycle says", () => {
    const rewritten = { verdict: "reescrita" as const, summary: "" };
    expect(
      hypothesisLine(
        hypothesis({
          id: "r1",
          lifecycle: "condicao_confirmada",
          verification: rewritten,
        }),
      ).verdict,
    ).toBe("confirmed");
    expect(
      hypothesisLine(
        hypothesis({
          id: "r2",
          lifecycle: "inconclusiva",
          verification: rewritten,
        }),
      ).verdict,
    ).toBe("inconclusive");
  });

  it("a refuted lifecycle strikes even without the verdict", () => {
    expect(
      hypothesisLine(hypothesis({ id: "x", lifecycle: "refutada" })),
    ).toMatchObject({ verdict: "refuted", strike: true });
  });

  it("an unknown verdict is pending", () => {
    expect(
      hypothesisLine(
        hypothesis({
          id: "u",
          lifecycle: "unknown",
          verification: { verdict: "unknown", summary: "" },
        }),
      ).verdict,
    ).toBe("pending");
  });
});

describe("readyHypothesis", () => {
  it("picks the ready one with the lowest rank", () => {
    const ready = (id: string, rank: number) => ({
      ...hypothesis({ id, lifecycle: "pronta_para_experimento" }),
      rank,
    });
    const pick = readyHypothesis({
      hypotheses: [
        { ...hypothesis({ id: "a" }), rank: 1 },
        ready("b", 3),
        ready("c", 2),
      ],
    });
    expect(pick?.id).toBe("c");
  });

  it("keeps the engine's order when there is no rank", () => {
    const a = hypothesis({ id: "a", lifecycle: "pronta_para_experimento" });
    const b = hypothesis({ id: "b", lifecycle: "pronta_para_experimento" });
    expect(readyHypothesis(withHypotheses([a, b]))?.id).toBe("a");
    expect(readyHypothesis(sizeLoss)?.id).toBe("hyp_sticky");
  });

  it("is null without a ready hypothesis", () => {
    expect(readyHypothesis(heroLoss)).toBeNull();
  });
});

describe("hypothesesTally", () => {
  it("counts ready and confirmed hypotheses", () => {
    expect(hypothesesTally(sizeLoss)).toEqual({
      total: 2,
      ready: 1,
      confirmed: 1,
    });
    expect(hypothesesTally(heroLoss)).toEqual({
      total: 1,
      ready: 0,
      confirmed: 0,
    });
  });
});

describe("summaryNumbers", () => {
  it("reads the fixture", () => {
    expect(summaryNumbers(view)).toEqual({
      measured: 3,
      pages: 2,
      chosen: 2,
      topMonthly: 291_200,
    });
  });

  it("is zero for an empty view", () => {
    const empty = StoreViewSchema.parse(storeViewWithGapsFixture);
    expect(summaryNumbers(empty)).toEqual({
      measured: 0,
      pages: 1,
      chosen: 0,
      topMonthly: 0,
    });
  });

  it("a loss without a money estimate adds nothing", () => {
    const noMoney = { ...view, top: [{ ...sizeLoss, money: null }] };
    expect(summaryNumbers(noMoney).topMonthly).toBe(0);
  });
});

describe("formatMoney", () => {
  it("is compact in pt-BR", () => {
    expect(plain(formatMoney(1_900_000, "pt-BR"))).toBe("R$ 1,9 mi");
    expect(plain(formatMoney(870_000, "pt-BR"))).toBe("R$ 870 mil");
  });

  it("follows the reader's language", () => {
    expect(plain(formatMoney(1_900_000, "en"))).toBe("R$1.9M");
  });
});

describe("sectionPhase", () => {
  it("shows results when the view has losses", () => {
    expect(sectionPhase(view)).toEqual({ phase: "results", refreshing: false });
  });

  it("keeps the results while a new run is going", () => {
    expect(sectionPhase({ ...view, running: true })).toEqual({
      phase: "results",
      refreshing: true,
    });
  });

  it("is running without a previous result", () => {
    const running = { ...view, top: [], others: [], running: true };
    expect(sectionPhase(running)).toEqual({ phase: "running" });
  });

  it("is empty with no losses and nothing running", () => {
    expect(sectionPhase({ ...view, top: [], others: [] })).toEqual({
      phase: "empty",
    });
  });

  it("is no_sources when a finished run found nothing and no source answered", () => {
    const gaps = StoreViewSchema.parse(storeViewWithGapsFixture);
    expect(sectionPhase({ ...gaps, sources: [] })).toEqual({
      phase: "no_sources",
    });
  });

  it("is empty when sources answered, even with named gaps", () => {
    const gaps = StoreViewSchema.parse(storeViewWithGapsFixture);
    expect(sectionPhase(gaps)).toEqual({ phase: "empty" });
    const [pdp] = gaps.pages as [StorePage];
    const vtexGap = {
      ...gaps,
      pages: [{ ...pdp, gaps: ["VTEX: no catalog connection"] }],
      sources: ["GA4"],
    };
    expect(sectionPhase(vtexGap)).toEqual({ phase: "empty" });
  });

  it("is empty for a view that never ran", () => {
    expect(
      sectionPhase({ ...view, pages: [], top: [], others: [], sources: [] }),
    ).toEqual({ phase: "empty" });
  });

  it("is failed when every page stopped with an error, before gaps or sources", () => {
    const gaps = StoreViewSchema.parse(storeViewWithGapsFixture);
    const failed = (v: StoreView): StoreView => ({
      ...v,
      top: [],
      others: [],
      pages: v.pages.map((p) => ({ ...p, status: "error" as const })),
    });
    expect(sectionPhase(failed({ ...gaps, sources: [] }))).toEqual({
      phase: "failed",
    });
    expect(sectionPhase(failed(view))).toEqual({ phase: "failed" });
    const [home, pdp] = view.pages as [StorePage, StorePage];
    const oneFailed = {
      ...view,
      top: [],
      others: [],
      pages: [{ ...home, status: "error" as const }, pdp],
    };
    expect(sectionPhase(oneFailed)).toEqual({ phase: "empty" });
  });

  it("losses win over gaps, and a run going wins over gaps", () => {
    const gaps = StoreViewSchema.parse(storeViewWithGapsFixture);
    expect(sectionPhase({ ...gaps, top: view.top })).toEqual({
      phase: "results",
      refreshing: false,
    });
    expect(sectionPhase({ ...gaps, running: true })).toEqual({
      phase: "running",
    });
  });
});

describe("viewGaps", () => {
  it("lists each named gap once", () => {
    const gaps = StoreViewSchema.parse(storeViewWithGapsFixture);
    const doubled = { ...gaps, pages: [...gaps.pages, ...gaps.pages] };
    expect(viewGaps(doubled)).toEqual([
      "GA4: no dataset connected",
      "Deco Analytics: site not found",
      "Funil: esta análise não tem dado de funil da página",
    ]);
    expect(viewGaps(view)).toEqual([]);
  });
});

describe("viewScope", () => {
  it("is the whole site when every page was analysed", () => {
    const pages = (
      ["home", "categoria", "busca", "pdp", "carrinho_checkout"] as const
    ).map((page_type) => ({ ...view.pages[0], page_type }));
    expect(viewScope({ ...view, pages: pages as StoreView["pages"] })).toEqual({
      whole: true,
      pages: ["home", "categoria", "busca", "pdp", "carrinho_checkout"],
      analysedAt: "2026-11-20T12:00:00.000Z",
    });
  });

  it("names the pages and the latest analysis otherwise", () => {
    expect(viewScope(view)).toEqual({
      whole: false,
      pages: ["home", "pdp"],
      analysedAt: "2026-11-20T12:05:00.000Z",
    });
  });

  it("picks the latest analysis by time across offsets", () => {
    const [home, pdp] = view.pages as [StorePage, StorePage];
    const mixed = {
      ...view,
      pages: [
        // 12:30 UTC, later, though it sorts first as text.
        { ...home, analysed_at: "2026-11-20T09:30:00-03:00" },
        { ...pdp, analysed_at: "2026-11-20T12:05:00.000Z" },
      ],
    };
    expect(viewScope(mixed).analysedAt).toBe("2026-11-20T09:30:00-03:00");
  });

  it("leaves out a page in its first analysis, which has no result yet", () => {
    const [home, pdp] = view.pages as [StorePage, StorePage];
    const first = {
      ...view,
      top: [],
      others: [],
      pages: [
        home,
        {
          ...pdp,
          status: "running" as const,
          analysed_at: "2026-11-21T08:00:00.000Z",
          funnel: [],
          capture_url: null,
        },
      ],
    };
    expect(viewScope(first).analysedAt).toBe(home.analysed_at);
  });

  it("has no date without pages", () => {
    expect(viewScope({ ...view, pages: [] })).toEqual({
      whole: false,
      pages: [],
      analysedAt: null,
    });
  });
});

const detail = GetOpportunitySchema.parse(opportunityDetailFixture).opportunity;
const [sticky] = detail.hypotheses as [OpportunityHypothesis];

const LIFECYCLES: Lifecycle[] = [
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
];

describe("canApprove", () => {
  it("approve is only allowed for ready hypotheses", () => {
    const allowed = LIFECYCLES.filter((lifecycle) => canApprove({ lifecycle }));
    expect(allowed).toEqual(["pronta_para_experimento"]);
  });
});

describe("hypothesisActions", () => {
  it("a pending ready hypothesis can be approved or dismissed", () => {
    expect(hypothesisActions(sticky)).toEqual({
      decision: "pending",
      approve: true,
      dismiss: true,
      undo: false,
    });
  });

  it("a pending hypothesis that is not ready can only be dismissed", () => {
    expect(
      hypothesisActions({ ...sticky, lifecycle: "condicao_confirmada" }),
    ).toEqual({
      decision: "pending",
      approve: false,
      dismiss: true,
      undo: false,
    });
  });

  it("a decided hypothesis can only go back to pending", () => {
    for (const status of ["approved", "dismissed"] as const) {
      expect(hypothesisActions({ ...sticky, status })).toEqual({
        decision: status,
        approve: false,
        dismiss: false,
        undo: true,
      });
    }
  });
});

describe("detailHypotheses", () => {
  it("orders the hypotheses by rank", () => {
    const second = { ...sticky, id: "h2", rank: 2 };
    const first = { ...sticky, id: "h0", rank: 0 };
    const ordered = detailHypotheses({
      hypotheses: [second, sticky, first],
    });
    expect(ordered.map((h) => h.id)).toEqual(["h0", "hyp_sticky", "h2"]);
  });

  it("the detail payload reuses the card's verdict line", () => {
    expect(hypothesisLine(sticky)).toEqual({
      text: "A sticky buy bar on mobile",
      verdict: "confirmed",
      strike: false,
    });
  });
});

describe("safeHref", () => {
  it("keeps http and https links", () => {
    expect(safeHref("https://research.loja.example/sticky")).toBe(
      "https://research.loja.example/sticky",
    );
    expect(safeHref("http://loja.example/a?b=1")).toBe(
      "http://loja.example/a?b=1",
    );
  });

  it("drops every other scheme, relative and malformed values", () => {
    for (const value of [
      null,
      "",
      "   ",
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<b>x</b>",
      "ftp://loja.example/file",
      "/relative/path",
      "loja.example",
      "https://",
    ]) {
      expect(safeHref(value)).toBeNull();
    }
  });
});

describe("safeImageSrc", () => {
  it("keeps https images only", () => {
    expect(safeImageSrc("https://media.loja.example/a.png?sig=1")).toBe(
      "https://media.loja.example/a.png?sig=1",
    );
    for (const value of [
      null,
      "",
      "http://media.loja.example/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "/a.png",
    ]) {
      expect(safeImageSrc(value)).toBeNull();
    }
  });
});

describe("showsAnalysedAt", () => {
  const [home, pdp] = view.pages as [StorePage, StorePage];
  const firstRun: StorePage = {
    ...home,
    status: "running",
    funnel: [],
    capture_url: null,
  };

  it("shows the date of a finished or failed page", () => {
    expect(showsAnalysedAt(view, home)).toBe(true);
    expect(showsAnalysedAt(view, { ...home, status: "error" })).toBe(true);
  });

  it("hides it for a page in its first analysis", () => {
    expect(showsAnalysedAt({ ...view, top: [], others: [] }, firstRun)).toBe(
      false,
    );
  });

  it("shows it for a page running again over an earlier result", () => {
    expect(
      showsAnalysedAt(view, {
        ...pdp,
        status: "running",
        funnel: [],
        capture_url: null,
      }),
    ).toBe(true);
    expect(
      showsAnalysedAt(
        { ...view, top: [], others: [] },
        {
          ...firstRun,
          capture_url: "https://media.loja.example/fold.png",
        },
      ),
    ).toBe(true);
    expect(
      showsAnalysedAt(
        { ...view, top: [], others: [] },
        {
          ...firstRun,
          funnel: [{ device: "mobile", people_week: 10, advance_rate: 0.5 }],
        },
      ),
    ).toBe(true);
  });
});

describe("confidenceLevel", () => {
  it("reads the engine's confidence in three levels", () => {
    expect(confidenceLevel(0.9)).toBe("high");
    expect(confidenceLevel(0.7)).toBe("high");
    expect(confidenceLevel(0.5)).toBe("medium");
    expect(confidenceLevel(0.4)).toBe("medium");
    expect(confidenceLevel(0.1)).toBe("low");
    expect(confidenceLevel(Number.NaN)).toBeNull();
  });
});

describe("parseOpportunityId", () => {
  it("keeps an engine id", () => {
    expect(parseOpportunityId("opp_size")).toBe("opp_size");
    expect(parseOpportunityId("4b0e9a5c-2f7e-4c1a-9a51-0d6f1e1f2a3b")).toBe(
      "4b0e9a5c-2f7e-4c1a-9a51-0d6f1e1f2a3b",
    );
  });

  it("rejects an empty, blank, oversized or missing id", () => {
    for (const value of [undefined, null, 42, "", "   ", "x".repeat(129)]) {
      expect(parseOpportunityId(value)).toBeNull();
    }
    expect(parseOpportunityId("x".repeat(128))).toBe("x".repeat(128));
  });
});

describe("detailFailure", () => {
  it("an id the engine does not know is not found", () => {
    expect(
      detailFailure(new DiagnosisEngineError("oportunidade não encontrada")),
    ).toBe("not_found");
    expect(detailFailure(new DiagnosisEngineError("Not found"))).toBe(
      "not_found",
    );
  });

  it("any other failure is an error to retry", () => {
    expect(detailFailure(new DiagnosisEngineError("D1 timeout"))).toBe("error");
    expect(detailFailure(new Error("fetch failed: not found"))).toBe("error");
    expect(detailFailure(null)).toBe("error");
  });
});

describe("formatPercent and formatCount", () => {
  it("shows a 0–1 rate as a percent in the reader's language", () => {
    expect(formatPercent(0.099, "pt-BR")).toBe("9,9%");
    expect(formatPercent(0.258, "en")).toBe("25.8%");
    expect(formatPercent(0.35, "en", 0)).toBe("35%");
  });

  it("groups whole counts", () => {
    expect(plain(formatCount(48_000, "pt-BR"))).toBe("48.000");
    expect(formatCount(27_000.4, "en")).toBe("27,000");
  });
});

// ── The store, step by step ──────────────────────────────────────────────────

/** The fixture with one page rerunning. */
function withPdpRunning(v: StoreView): StoreView {
  return {
    ...v,
    running: true,
    pages: v.pages.map((p) =>
      p.page_type === "pdp"
        ? {
            ...p,
            status: "running",
            stage: "verify",
            diagnosis_id: "diag_pdp_2",
          }
        : p,
    ),
  };
}

describe("stageCards", () => {
  it("stage cards follow funnel order and mark top/second", () => {
    const cards = stageCards(view, "mobile");
    expect(cards.map((c) => c.page_type)).toEqual([
      "home",
      "categoria",
      "busca",
      "pdp",
      "carrinho_checkout",
    ]);
    const [home, categoria, , pdp] = cards;
    // The engine's top[0] is the size loss on the product page.
    expect(pdp).toEqual({
      page_type: "pdp",
      analysed: true,
      people_week: 30_000,
      advance_rate: 0.08,
      badge: "top",
      at_stake: 67_200,
    });
    expect(home).toEqual({
      page_type: "home",
      analysed: true,
      people_week: 52_000,
      advance_rate: 0.41,
      badge: "second",
      at_stake: 224_000,
    });
    expect(categoria).toEqual({
      page_type: "categoria",
      analysed: false,
      people_week: null,
      advance_rate: null,
      badge: null,
      at_stake: null,
    });
  });

  it("a page with only other losses is at stake; one without money has no badge", () => {
    const [size, hero] = view.top as [StoreOpportunity, StoreOpportunity];
    const onlyOthers: StoreView = { ...view, top: [], others: [hero, size] };
    const cards = stageCards(onlyOthers, "mobile");
    expect(cards[0]?.badge).toBe("at_stake");
    expect(cards[0]?.at_stake).toBe(224_000);
    const noMoney: StoreView = {
      ...view,
      top: [],
      others: [{ ...size, money: null }],
    };
    expect(stageCards(noMoney, "mobile")[3]).toMatchObject({
      badge: null,
      at_stake: null,
    });
  });

  it("the biggest loss on a page is its value at stake", () => {
    const [size] = view.top as [StoreOpportunity];
    const bigger = {
      ...size,
      id: "opp_bigger",
      money: { ...size.money!, monthly_value: 90_000 },
    };
    const v: StoreView = { ...view, others: [bigger, ...view.others] };
    expect(stageCards(v, "mobile")[3]?.at_stake).toBe(90_000);
  });

  it("two top losses on the same page mark it top once", () => {
    const [size, hero] = view.top as [StoreOpportunity, StoreOpportunity];
    const v: StoreView = {
      ...view,
      top: [size, { ...hero, page_type: "pdp" }],
    };
    const cards = stageCards(v, "mobile");
    expect(cards.map((c) => c.badge)).toEqual([null, null, null, "top", null]);
  });

  it("a page running again says so", () => {
    expect(stageCards(withPdpRunning(view), "mobile")[3]?.badge).toBe(
      "running",
    );
  });

  it("desktop selection uses desktop funnel", () => {
    const cards = stageCards(view, "desktop");
    expect(cards[0]).toMatchObject({ people_week: 14_000, advance_rate: 0.55 });
    // The product page measured mobile only.
    expect(cards[3]).toMatchObject({
      analysed: true,
      people_week: null,
      advance_rate: null,
      badge: "top",
    });
  });
});

describe("runnablePages", () => {
  it("running page is not runnable", () => {
    expect(runnablePages(withPdpRunning(view))).toEqual([
      {
        page_type: "home",
        disabled: false,
        analysed_at: "2026-11-20T12:00:00.000Z",
      },
      { page_type: "categoria", disabled: false, analysed_at: null },
      { page_type: "busca", disabled: false, analysed_at: null },
      {
        page_type: "pdp",
        disabled: true,
        analysed_at: "2026-11-20T12:05:00.000Z",
      },
      { page_type: "carrinho_checkout", disabled: false, analysed_at: null },
    ]);
  });

  it("every page is runnable on a store never analysed", () => {
    for (const v of [{ ...view, pages: [] }, undefined]) {
      expect(runnablePages(v).map((p) => p.disabled)).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
    }
  });
});

describe("defaultStorePage", () => {
  it("opens on the page with the biggest loss", () => {
    expect(defaultStorePage(view)).toBe("pdp");
  });

  it("without losses, opens the first page in funnel order with data", () => {
    const v: StoreView = {
      ...view,
      top: [],
      others: [],
      pages: [...view.pages].reverse(),
    };
    expect(defaultStorePage(v)).toBe("home");
    const [home, pdp] = view.pages as [StorePage, StorePage];
    expect(
      defaultStorePage({ ...v, pages: [{ ...home, funnel: [] }, pdp] }),
    ).toBe("pdp");
  });

  it("falls back to any analysed page, and to none", () => {
    const gaps = StoreViewSchema.parse(storeViewWithGapsFixture);
    expect(defaultStorePage(gaps)).toBe("pdp");
    expect(defaultStorePage({ ...view, top: [], pages: [] })).toBeNull();
  });
});

describe("pageLosses", () => {
  it("lists a page's losses, top ones first", () => {
    expect(pageLosses(view, "pdp").map((o) => o.id)).toEqual([
      "opp_size",
      "opp_shipping",
    ]);
    expect(pageLosses(view, "busca")).toEqual([]);
  });
});

describe("startRunInput", () => {
  const goal = { id: "goal_1", statement: "  Sell more on mobile  " };

  it("asks for the whole site or the chosen pages, for the active goal", () => {
    expect(startRunInput(goal, "site")).toEqual({
      todas: true,
      goal_id: "goal_1",
      objective_statement: "Sell more on mobile",
    });
    expect(startRunInput(goal, ["pdp", "home"])).toEqual({
      pages: ["home", "pdp"],
      goal_id: "goal_1",
      objective_statement: "Sell more on mobile",
    });
  });

  it("leaves out a missing goal and repeated pages, and clips the goal to the engine's 280", () => {
    expect(
      startRunInput({ id: null, statement: "   " }, ["pdp", "pdp"]),
    ).toEqual({ pages: ["pdp"] });
    const long = startRunInput({ id: "g", statement: "x".repeat(400) }, "site");
    expect(long.objective_statement).toHaveLength(280);
  });
});

describe("runningElsewhere", () => {
  const started = (diagnoses: StartRunResult["diagnoses"]): StartRunResult => ({
    status: "started",
    site_run_id: "run_1",
    diagnoses,
  });

  it("names pages already running outside this goal's view", () => {
    const result = started([
      { page_type: "home", diagnosis_id: "diag_new", already_running: false },
      { page_type: "busca", diagnosis_id: "diag_other", already_running: true },
    ]);
    expect(runningElsewhere(result, view)).toEqual(["busca"]);
  });

  it("a page already running in this view needs no notice", () => {
    const running = withPdpRunning(view);
    const result = started([
      { page_type: "pdp", diagnosis_id: "diag_pdp_2", already_running: true },
    ]);
    expect(runningElsewhere(result, running)).toEqual([]);
    expect(runningElsewhere(result, undefined)).toEqual(["pdp"]);
  });
});

describe("runRequestedEvent", () => {
  it("counts the pages a request covers", () => {
    const goal = { id: null, statement: null };
    expect(runRequestedEvent(startRunInput(goal, "site"))).toEqual({
      scope: "site",
      count: 5,
    });
    expect(runRequestedEvent(startRunInput(goal, ["pdp", "busca"]))).toEqual({
      scope: "pages",
      count: 2,
    });
  });
});

describe("gapGroups", () => {
  it("old engine: every gap is listed as it is, in legacy mode", () => {
    const old = StoreViewSchema.parse(storeViewWithGapsFixture);
    expect(viewGaps(old).length).toBeGreaterThan(0);
    expect(gapGroups(old)).toEqual({
      legacy: true,
      customer: [],
      limitations: viewGaps(old),
    });
  });

  it("an engine with gap_details is not legacy, even with none on a page", () => {
    const view = StoreViewSchema.parse(storeViewWithSetupFixture);
    expect(gapGroups(view).legacy).toBe(false);
    const noGaps = StoreViewSchema.parse({
      ...storeViewWithSetupFixture,
      pages: [
        { ...storeViewWithSetupFixture.pages[0], gaps: [], gap_details: [] },
      ],
    });
    expect(gapGroups(noGaps)).toEqual({
      legacy: false,
      customer: [],
      limitations: [],
    });
  });

  it("customer gaps are grouped once per key", () => {
    const [page] = storeViewWithSetupFixture.pages;
    const view = StoreViewSchema.parse({
      ...storeViewWithSetupFixture,
      pages: [page, { ...page, page_type: "home", diagnosis_id: "diag_home" }],
    });
    const { customer, limitations } = gapGroups(view);
    expect(customer.map((g) => g.key)).toEqual([
      "bigquery",
      "analytics_install",
    ]);
    expect(customer.map((g) => g.source)).toEqual(["bigquery", "heatmap"]);
    expect(limitations).toEqual([
      "Funil: esta análise não tem dado de funil da página",
    ]);
  });

  it("unknown owners count as limitations", () => {
    const view = StoreViewSchema.parse({
      ...storeViewWithSetupFixture,
      pages: [
        {
          ...storeViewWithSetupFixture.pages[0],
          gap_details: [
            { source: "X", owner: "vendor", key: "domain", message: "a" },
            { source: "Y", owner: "customer", key: "new_key", message: "b" },
            { source: "Z", owner: "customer", message: "b" },
          ],
        },
      ],
    });
    expect(gapGroups(view)).toEqual({
      legacy: false,
      customer: [],
      limitations: ["a", "b"],
    });
  });
});

describe("setupNeeds", () => {
  it("keeps the known keys and drops the rest", () => {
    const view = StoreViewSchema.parse({
      ...storeViewWithSetupFixture,
      setup: {
        needs: [
          { key: "domain", blocking: true },
          { key: "something_new", blocking: false },
        ],
        current: { domain: null, competitors: [] },
      },
    });
    expect(setupNeeds(view).map((n) => n.key)).toEqual(["domain"]);
  });

  it("asks for the site's repository when the engine cannot read the code", () => {
    const view = StoreViewSchema.parse({
      ...storeViewWithSetupFixture,
      setup: {
        needs: [{ key: "repository", blocking: false }],
        current: { domain: "loja.example", competitors: [] },
      },
    });
    expect(setupNeeds(view).map((n) => n.key)).toEqual(["repository"]);
  });

  it("asks for an AI provider right after the domain", () => {
    const view = StoreViewSchema.parse({
      ...storeViewWithSetupFixture,
      setup: {
        needs: [
          { key: "domain", blocking: true, suggested: null },
          { key: "ai_provider", blocking: true },
          { key: "competitors", blocking: false, suggested: [] },
        ],
        current: { domain: null, competitors: [] },
      },
    });
    expect(setupNeeds(view).map((n) => n.key)).toEqual([
      "domain",
      "ai_provider",
      "competitors",
    ]);
  });

  it("is empty for an engine without setup", () => {
    expect(setupNeeds(StoreViewSchema.parse(storeViewFixture))).toEqual([]);
  });
});

describe("runRefusal", () => {
  const refusal = (raw: unknown) => {
    try {
      unwrapEngineResult(parseToolResult(StartRunSchema, raw));
    } catch (err) {
      return runRefusal(err);
    }
    throw new Error("the start was not refused");
  };

  it("asks for an AI provider when the org has no model", () => {
    expect(
      refusal({
        status: "error",
        error: "nenhum modelo de IA conectado: conecte um provedor",
        needs: [{ key: "ai_provider", blocking: true }],
      }),
    ).toBe("ai_provider");
  });

  it("asks for the domain first when both block", () => {
    expect(
      refusal({
        status: "error",
        error: "sem domínio",
        needs: [
          { key: "domain", blocking: true, suggested: null },
          { key: "ai_provider", blocking: true },
        ],
      }),
    ).toBe("domain");
  });

  it("asks for the domain from an engine that only flags it", () => {
    expect(
      refusal({ status: "error", error: "sem domínio", needs_domain: true }),
    ).toBe("domain");
  });

  it("names nothing for another error, a non-blocking need or a transport failure", () => {
    expect(refusal({ status: "error", error: "D1 timeout" })).toBeNull();
    expect(
      refusal({
        status: "error",
        error: "x",
        needs: [{ key: "ai_provider", blocking: false }],
      }),
    ).toBeNull();
    expect(runRefusal(new Error("fetch failed"))).toBeNull();
    expect(runRefusal(null)).toBeNull();
  });
});
