import { describe, expect, it } from "bun:test";
import {
  acceptDirection,
  buildDirectionQuestion,
  MIN_DIRECTION_PROBABILITY,
} from "./plan-goal-direction";

describe("buildDirectionQuestion", () => {
  it("asks one yes-or-no question about the quote and its source", () => {
    const input = buildDirectionQuestion(
      "O foco de 2027 é fazer o app vender mais que o site",
      "Grain",
    );
    expect(input.state).toEqual({
      quote: "O foco de 2027 é fazer o app vender mais que o site",
      source: "Grain",
    });
    expect(input.questions.direction.type).toBe("boolean");
  });
});

describe("acceptDirection", () => {
  const answer = (probability: number) => ({
    direction: { type: "boolean", probability },
  });

  it("accepts a direction Jev is sure enough of", () => {
    expect(MIN_DIRECTION_PROBABILITY).toBe(0.6);
    expect(acceptDirection(answer(0.6))).toBe(true);
    expect(acceptDirection(answer(0.93))).toBe(true);
  });

  it("rejects a guess or an answer that does not fit the question", () => {
    expect(acceptDirection(answer(0.59))).toBe(false);
    expect(acceptDirection(answer(Number.NaN))).toBe(false);
    expect(acceptDirection(answer(1.2))).toBe(false);
    expect(
      acceptDirection({ direction: { type: "choice", choice: "yes" } }),
    ).toBe(false);
    expect(acceptDirection({})).toBe(false);
  });
});
