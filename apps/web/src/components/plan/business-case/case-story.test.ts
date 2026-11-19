import { describe, expect, it } from "bun:test";
import {
  emptyBusinessCase,
  type BusinessCase,
  type BusinessCaseCard,
  type BusinessCaseCardKey,
} from "@decocms/shared/business-case";
import { caseStory } from "./case-story.ts";

const MONEY = {
  kind: "money",
  base: 104000,
  deltaPp: 1.5,
  value: 243,
  monthlyValue: 379080,
  ceilingMonthly: 4295160,
} as const;

const AB_TEST = {
  kind: "abTest",
  baseline: 0.59,
  mdePp: 1.77,
  nPerGroup: 12000,
  weeks: 3,
  measurable: true,
} as const;

function filled(extra: Partial<BusinessCaseCard> = {}): BusinessCaseCard {
  return { state: "filled", summary: "s", bullets: [], sources: [], ...extra };
}

function makeCase(
  status: BusinessCase["status"],
  cards: Partial<Record<BusinessCaseCardKey, BusinessCaseCard>> = {},
): BusinessCase {
  const value = emptyBusinessCase({
    title: "Mostrar o frete na PDP",
    objective: "Conversão de 1,8% para 2,1%",
    request: "frete na PDP",
  });
  return { ...value, status, cards: { ...value.cards, ...cards } };
}

const ALL_FILLED: Partial<Record<BusinessCaseCardKey, BusinessCaseCard>> = {
  problem: filled(),
  scope: filled(),
  money: filled({ calc: MONEY }),
  competitors: filled(),
  measurement: filled(),
  abTest: filled({ calc: AB_TEST }),
  effort: filled({
    metrics: [
      { label: "Front-end", value: 3, unit: "days" },
      { label: "Back-end", value: 2, unit: "days" },
      { label: "Pessoas", value: 2, unit: "count" },
    ],
  }),
  risks: filled(),
  unknowns: filled({ bullets: ["Custo da API de frete", "CEP salvo"] }),
};

describe("caseStory", () => {
  it("a ready case with every number fills the three tiles and every act", () => {
    const story = caseStory(makeCase("ready", ALL_FILLED));
    expect(story.money).toEqual(MONEY);
    expect(story.tiles).toEqual([
      {
        key: "money",
        state: "value",
        monthly: 379080,
        ceiling: 4295160,
      },
      { key: "effort", state: "value", days: 5 },
      { key: "abTest", state: "value", weeks: 3, nPerGroup: 12000 },
    ]);
    expect(story.acts.map((act) => [act.key, act.dot])).toEqual([
      ["why", "done"],
      ["what", "done"],
      ["worth", "done"],
      ["prove", "done"],
    ]);
    expect(story.acts.map((act) => act.cards)).toEqual([
      ["problem"],
      ["scope", "competitors"],
      ["money", "effort", "risks"],
      ["measurement", "abTest"],
    ]);
    expect(story.openQuestions).toEqual(["Custo da API de frete", "CEP salvo"]);
  });

  it("an old ready case without numbers shows no tiles and no thesis money", () => {
    const story = caseStory(
      makeCase("ready", {
        problem: filled(),
        money: filled({ summary: "Uns R$ 40 mil por mês" }),
        effort: filled(),
      }),
    );
    expect(story.money).toBeNull();
    expect(story.tiles).toEqual([]);
    expect(story.openQuestions).toEqual([]);
  });

  it("while building, a tile without data waits, and the asking one says so", () => {
    const story = caseStory(
      makeCase("building", {
        problem: filled(),
        scope: filled(),
        money: {
          state: "asking",
          question: "Qual é a margem por pedido?",
          bullets: [],
          sources: [],
        },
      }),
    );
    expect(story.tiles).toEqual([
      { key: "money", state: "asking" },
      { key: "effort", state: "later" },
      { key: "abTest", state: "later" },
    ]);
    expect(story.acts.map((act) => act.dot)).toEqual([
      "done",
      "open",
      "asking",
      "open",
    ]);
  });

  it("an A/B test that cannot be measured says so instead of a week count", () => {
    const story = caseStory(
      makeCase("ready", {
        abTest: filled({
          calc: { ...AB_TEST, weeks: null, nPerGroup: null, measurable: false },
        }),
      }),
    );
    expect(story.tiles).toEqual([{ key: "abTest", state: "unmeasurable" }]);
    const long = caseStory(
      makeCase("ready", {
        abTest: filled({ calc: { ...AB_TEST, weeks: 12, measurable: false } }),
      }),
    );
    expect(long.tiles).toEqual([{ key: "abTest", state: "unmeasurable" }]);
  });

  it("effort without days metrics has no tile", () => {
    const story = caseStory(
      makeCase("ready", {
        effort: filled({
          metrics: [{ label: "Pessoas", value: 2, unit: "count" }],
        }),
      }),
    );
    expect(story.tiles).toEqual([]);
  });
});
