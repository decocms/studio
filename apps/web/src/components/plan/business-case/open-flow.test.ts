import { describe, expect, it } from "bun:test";
import { startOpenFlow } from "./open-flow.ts";

describe("startOpenFlow", () => {
  const questions = ["How many orders?", "Which page?"];

  it("starts at the first question when nothing was answered", () => {
    expect(startOpenFlow(questions, null)).toEqual({
      questions,
      answers: [],
      step: 0,
    });
  });

  it("resumes where the person left the same questions", () => {
    const saved = { questions: [...questions], answers: ["300"], step: 1 };
    expect(startOpenFlow(questions, saved)).toBe(saved);
  });

  it("starts over when the case's open questions changed", () => {
    const saved = {
      questions: ["How many orders?"],
      answers: ["300"],
      step: 1,
    };
    expect(startOpenFlow(questions, saved).answers).toEqual([]);
    const reworded = {
      questions: ["How many orders?", "Which pages?"],
      answers: ["300"],
      step: 1,
    };
    expect(startOpenFlow(questions, reworded).step).toBe(0);
  });
});
