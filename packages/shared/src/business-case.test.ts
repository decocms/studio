import { describe, expect, it } from "bun:test";
import {
  BUSINESS_CASE_LIMITS,
  businessCaseMountPath,
  businessCasePath,
  emptyBusinessCase,
  matchBusinessCasePath,
  parseBusinessCase,
} from "./business-case";

const NOW = new Date("2026-11-18T12:00:00.000Z");

function sample() {
  return emptyBusinessCase({
    title: "Melhorar a busca",
    objective: "Vender mais no celular",
    request: "quero mexer na busca",
    area: "search",
    now: NOW,
  });
}

describe("business case paths", () => {
  it("names one file per chat under plans/cases", () => {
    const path = businessCasePath("0b7c-41a2");
    expect(path).toBe("plans/cases/0b7c-41a2.json");
    expect(matchBusinessCasePath(path)).toBe("0b7c-41a2");
    expect(businessCaseMountPath(path)).toBe(
      "/app/org/home/plans/cases/0b7c-41a2.json",
    );
  });

  it("rejects other files, nesting and hidden names", () => {
    for (const path of [
      "plans/2026-11-18-busca.md",
      "plans/cases/a.md",
      "plans/cases/nested/a.json",
      "plans/cases/.hidden.json",
      "plans/cases/../x.json",
      "decks/cases/a.json",
      "",
    ]) {
      expect(matchBusinessCasePath(path)).toBeNull();
    }
  });
});

describe("parseBusinessCase", () => {
  it("reads what emptyBusinessCase writes", () => {
    const value = sample();
    expect(parseBusinessCase(JSON.stringify(value))).toEqual(value);
    expect(value.objective).toBe("Vender mais no celular");
    expect(value.updatedAt).toBe(NOW.toISOString());
  });

  it("returns null for text that is not JSON or not a case", () => {
    expect(parseBusinessCase("")).toBeNull();
    expect(parseBusinessCase("{")).toBeNull();
    expect(parseBusinessCase("[]")).toBeNull();
    expect(parseBusinessCase(JSON.stringify({ version: 1 }))).toBeNull();
  });

  it("rejects an unknown version, area, state or a missing card", () => {
    const value = sample();
    expect(parseBusinessCase(JSON.stringify({ ...value, version: 2 }))).toBe(
      null,
    );
    expect(
      parseBusinessCase(
        JSON.stringify({ ...value, request: { text: "x", area: "blog" } }),
      ),
    ).toBeNull();
    expect(
      parseBusinessCase(
        JSON.stringify({
          ...value,
          cards: {
            ...value.cards,
            risks: { ...value.cards.risks, state: "?" },
          },
        }),
      ),
    ).toBeNull();
    const { risks: _risks, ...cards } = value.cards;
    expect(parseBusinessCase(JSON.stringify({ ...value, cards }))).toBeNull();
  });

  it("rejects oversized text and too many bullets", () => {
    const value = sample();
    const long = "x".repeat(BUSINESS_CASE_LIMITS.text + 1);
    expect(
      parseBusinessCase(
        JSON.stringify({
          ...value,
          cards: {
            ...value.cards,
            problem: { ...value.cards.problem, summary: long },
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseBusinessCase(
        JSON.stringify({
          ...value,
          cards: {
            ...value.cards,
            risks: {
              ...value.cards.risks,
              bullets: Array(BUSINESS_CASE_LIMITS.items + 1).fill("b"),
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it("cuts emptyBusinessCase inputs to the limits", () => {
    const value = emptyBusinessCase({
      title: "t".repeat(500),
      objective: null,
      request: "r".repeat(5000),
    });
    expect(value.title).toHaveLength(BUSINESS_CASE_LIMITS.title);
    expect(value.request.text).toHaveLength(BUSINESS_CASE_LIMITS.text);
    expect(value.request.area).toBe("other");
    expect(parseBusinessCase(JSON.stringify(value))).not.toBeNull();
  });
});

describe("card figures", () => {
  const withCard = (
    key: keyof ReturnType<typeof sample>["cards"],
    extra: Record<string, unknown>,
  ) => {
    const value = sample();
    return JSON.stringify({
      ...value,
      cards: {
        ...value.cards,
        [key]: { ...value.cards[key], state: "filled", ...extra },
      },
    });
  };
  const money = {
    kind: "money",
    base: 104000,
    baseLabel: "carrinhos por mês",
    deltaPp: 1.5,
    value: 73,
    valueLabel: "receita por pedido a mais",
    gapPp: 17,
    monthlyValue: 113880,
    ceilingMonthly: 1290640,
  };
  const abTest = {
    kind: "abTest",
    baseline: 0.59,
    mdePp: 1.77,
    nPerGroup: 12000,
    weeks: 3,
    measurable: true,
  };
  const metric = { label: "Nossa loja", value: 41, unit: "percent" };

  it("reads a case written before figures existed", () => {
    expect(parseBusinessCase(JSON.stringify(sample()))).not.toBeNull();
  });

  it("reads metrics on problem and effort, and each calc on its own card", () => {
    expect(
      parseBusinessCase(withCard("problem", { metrics: [metric] })),
    ).not.toBeNull();
    expect(
      parseBusinessCase(
        withCard("effort", {
          metrics: [{ label: "Front-end", value: 3, unit: "days" }],
        }),
      ),
    ).not.toBeNull();
    expect(
      parseBusinessCase(withCard("money", { calc: money })),
    ).not.toBeNull();
    expect(
      parseBusinessCase(withCard("abTest", { calc: abTest })),
    ).not.toBeNull();
    expect(
      parseBusinessCase(withCard("scope", { question: "Em qual página?" })),
    ).not.toBeNull();
  });

  it("rejects figures on the wrong card", () => {
    expect(
      parseBusinessCase(withCard("risks", { metrics: [metric] })),
    ).toBeNull();
    expect(parseBusinessCase(withCard("money", { calc: abTest }))).toBeNull();
    expect(parseBusinessCase(withCard("effort", { calc: money }))).toBeNull();
  });

  it("rejects too many metrics, an unknown unit, a non-number and long text", () => {
    const five = Array(BUSINESS_CASE_LIMITS.metrics + 1).fill(metric);
    expect(
      parseBusinessCase(withCard("problem", { metrics: five })),
    ).toBeNull();
    expect(
      parseBusinessCase(
        withCard("problem", { metrics: [{ ...metric, unit: "miles" }] }),
      ),
    ).toBeNull();
    expect(
      parseBusinessCase(
        withCard("problem", { metrics: [{ ...metric, value: "41" }] }),
      ),
    ).toBeNull();
    expect(
      parseBusinessCase(
        withCard("problem", {
          metrics: [
            { ...metric, label: "x".repeat(BUSINESS_CASE_LIMITS.label + 1) },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseBusinessCase(
        withCard("scope", {
          question: "x".repeat(BUSINESS_CASE_LIMITS.question + 1),
        }),
      ),
    ).toBeNull();
  });
});
