/**
 * The business case as the canvas tells it: a verdict on top (the money, the
 * effort and the A/B test, only from numbers the case's math wrote) and four
 * acts below, each lit by the state of its cards.
 */

import type {
  BusinessCase,
  BusinessCaseCard,
  BusinessCaseCardKey,
  BusinessCaseMoneyCalc,
} from "@decocms/shared/business-case";

export type ActKey = "why" | "what" | "worth" | "prove";
export type DotState = "done" | "asking" | "open";
export type HeroKey = "money" | "effort" | "abTest";

/** An A/B test longer than this is not measurable (the math's limit). */
const MAX_WEEKS = 8;

export type HeroTile =
  | { key: "money"; state: "value"; monthly: number; ceiling: number | null }
  | { key: "effort"; state: "value"; days: number }
  | { key: "abTest"; state: "value"; weeks: number; nPerGroup: number | null }
  | { key: "abTest"; state: "unmeasurable" }
  | { key: HeroKey; state: "asking" | "later" };

interface CaseAct {
  key: ActKey;
  dot: DotState;
  cards: BusinessCaseCardKey[];
}

export interface CaseStory {
  /** The money math, when the case has it: the thesis quotes it. */
  money: BusinessCaseMoneyCalc | null;
  /** Tiles with nothing to show are left out once the case is ready. */
  tiles: HeroTile[];
  acts: CaseAct[];
  openQuestions: string[];
}

const ACTS: { key: ActKey; cards: BusinessCaseCardKey[] }[] = [
  { key: "why", cards: ["problem"] },
  { key: "what", cards: ["scope", "competitors"] },
  { key: "worth", cards: ["money", "effort", "risks"] },
  { key: "prove", cards: ["measurement", "abTest"] },
];

function dot(cards: BusinessCaseCard[]): DotState {
  if (cards.some((card) => card.state === "asking")) return "asking";
  return cards.every((card) => card.state === "filled") ? "done" : "open";
}

function moneyTile(card: BusinessCaseCard): HeroTile | null {
  return card.calc?.kind === "money"
    ? {
        key: "money",
        state: "value",
        monthly: card.calc.monthlyValue,
        ceiling: card.calc.ceilingMonthly,
      }
    : null;
}

function effortTile(card: BusinessCaseCard): HeroTile | null {
  const days = (card.metrics ?? []).filter((m) => m.unit === "days");
  return days.length > 0
    ? {
        key: "effort",
        state: "value",
        days: days.reduce((sum, m) => sum + m.value, 0),
      }
    : null;
}

function abTestTile(card: BusinessCaseCard): HeroTile | null {
  const calc = card.calc;
  if (calc?.kind !== "abTest") return null;
  return calc.measurable && calc.weeks !== null && calc.weeks <= MAX_WEEKS
    ? {
        key: "abTest",
        state: "value",
        weeks: calc.weeks,
        nPerGroup: calc.nPerGroup,
      }
    : { key: "abTest", state: "unmeasurable" };
}

export function caseStory(value: BusinessCase): CaseStory {
  const { cards } = value;
  const tiles: HeroTile[] = [];
  for (const [key, tile] of [
    ["money", moneyTile(cards.money)],
    ["effort", effortTile(cards.effort)],
    ["abTest", abTestTile(cards.abTest)],
  ] as const) {
    if (tile) tiles.push(tile);
    else if (cards[key].state === "asking")
      tiles.push({ key, state: "asking" });
    else if (value.status !== "ready") tiles.push({ key, state: "later" });
  }

  return {
    money: cards.money.calc?.kind === "money" ? cards.money.calc : null,
    tiles,
    acts: ACTS.map((act) => ({
      ...act,
      dot: dot(act.cards.map((key) => cards[key])),
    })),
    openQuestions:
      cards.unknowns.state === "filled" ? cards.unknowns.bullets : [],
  };
}
