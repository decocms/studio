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
