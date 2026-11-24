import { describe, expect, it } from "bun:test";
import {
  GetOpportunitySchema,
  type Lifecycle,
  type OpportunityHypothesis,
  StoreViewSchema,
  type StoreOpportunity,
  type StoreOpportunityHypothesis,
  type StorePage,
  type StoreView,
} from "./diagnosis-schema.ts";
import { DiagnosisEngineError } from "./diagnosis-state.ts";
import {
  opportunityDetailFixture,
  storeViewFixture,
  storeViewWithGapsFixture,
} from "./fixtures.ts";
import {
  canApprove,
  cardState,
  confidenceLevel,
  dataBadge,
  detailFailure,
  detailHypotheses,
  hypothesisActions,
  formatCount,
  formatMoney,
  formatPercent,
  hypothesesTally,
  hypothesisLine,
  parseOpportunityId,
  readyHypothesis,
  safeHref,
  sectionPhase,
  summaryNumbers,
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

  it("is no_sources when a finished run found nothing and named gaps", () => {
    const gaps = StoreViewSchema.parse(storeViewWithGapsFixture);
    expect(sectionPhase(gaps)).toEqual({ phase: "no_sources" });
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
