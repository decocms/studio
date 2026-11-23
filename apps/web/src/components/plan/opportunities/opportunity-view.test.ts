import { describe, expect, it } from "bun:test";
import {
  StoreViewSchema,
  type StoreOpportunity,
  type StoreOpportunityHypothesis,
  type StoreView,
} from "./diagnosis-schema.ts";
import { storeViewFixture, storeViewWithGapsFixture } from "./fixtures.ts";
import {
  cardState,
  dataBadge,
  formatMoney,
  hypothesesTally,
  hypothesisLine,
  readyHypothesis,
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
      topMonthly: 2_600_000,
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

  it("has no date without pages", () => {
    expect(viewScope({ ...view, pages: [] })).toEqual({
      whole: false,
      pages: [],
      analysedAt: null,
    });
  });
});
