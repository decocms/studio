import { describe, expect, it } from "bun:test";
import {
  guideAnswers,
  guideReducer,
  startGuide,
  type NextStep,
} from "./guide-state.ts";

const ask = (text: string, reaction: string | null = null): NextStep => ({
  reaction,
  question: { text, options: ["A", "B"] },
  title: "Improve search",
});
const done: NextStep = { reaction: null, question: null, title: null };

describe("guide state", () => {
  it("goes straight to building when the idea already says enough", () => {
    const state = guideReducer(startGuide("  A fit guide on the PDP  "), {
      type: "resolved",
      step: 0,
      result: done,
    });
    expect(state.idea).toBe("A fit guide on the PDP");
    expect(state.view).toEqual({ phase: "building", guided: true });
    expect(guideAnswers(state)).toEqual([]);
  });

  it("asks, records the answer, then reacts on the next question", () => {
    let state = startGuide("Improve search");
    state = guideReducer(state, {
      type: "resolved",
      step: 0,
      result: ask("What bothers you?"),
    });
    expect(state.view.phase).toBe("asking");
    expect(state.title).toBe("Improve search");

    state = guideReducer(state, {
      type: "answered",
      step: 0,
      answer: " Empty results ",
    });
    expect(state.step).toBe(1);
    expect(state.view).toEqual({ phase: "thinking" });
    expect(state.answers).toEqual([
      { question: "What bothers you?", answer: "Empty results" },
    ]);

    state = guideReducer(state, {
      type: "resolved",
      step: 1,
      result: ask("Which device?", "Good one."),
    });
    expect(state.view).toMatchObject({
      phase: "asking",
      reaction: "Good one.",
    });
  });

  it("records a skipped question as an empty answer", () => {
    let state = guideReducer(startGuide("Improve search"), {
      type: "resolved",
      step: 0,
      result: ask("Which device?"),
    });
    state = guideReducer(state, { type: "answered", step: 0, answer: "" });
    state = guideReducer(state, { type: "resolved", step: 1, result: done });
    expect(guideAnswers(state)).toEqual([
      { question: "Which device?", answer: "" },
    ]);
  });

  it("drops a reply from a step the person already left", () => {
    let state = guideReducer(startGuide("Improve search"), {
      type: "resolved",
      step: 0,
      result: ask("What bothers you?"),
    });
    state = guideReducer(state, { type: "answered", step: 0, answer: "X" });
    const late = guideReducer(state, {
      type: "resolved",
      step: 0,
      result: ask("Stale question"),
    });
    expect(late).toBe(state);
    // A double submit of the same step does not record twice.
    expect(
      guideReducer(state, { type: "answered", step: 0, answer: "X" }),
    ).toBe(state);
  });

  it("hands the idea to the agent as-is when the model fails first", () => {
    const state = guideReducer(startGuide("Improve search"), {
      type: "failed",
      step: 0,
    });
    expect(state.view).toEqual({ phase: "building", guided: false });
    expect(guideAnswers(state)).toBeUndefined();
  });

  it("keeps the answers when the model fails later", () => {
    let state = guideReducer(startGuide("Improve search"), {
      type: "resolved",
      step: 0,
      result: ask("What bothers you?"),
    });
    state = guideReducer(state, { type: "answered", step: 0, answer: "X" });
    state = guideReducer(state, { type: "failed", step: 1 });
    expect(guideAnswers(state)).toEqual([
      { question: "What bothers you?", answer: "X" },
    ]);
  });

  describe("going back", () => {
    /** Two questions answered, the third on screen. */
    function twoAnswered() {
      let state = guideReducer(startGuide("Improve search"), {
        type: "resolved",
        step: 0,
        result: ask("What bothers you?"),
      });
      state = guideReducer(state, { type: "answered", step: 0, answer: "A" });
      state = guideReducer(state, {
        type: "resolved",
        step: 1,
        result: ask("Which device?"),
      });
      state = guideReducer(state, {
        type: "answered",
        step: 1,
        answer: "Mobile",
      });
      return guideReducer(state, {
        type: "resolved",
        step: 2,
        result: ask("How often?", "Got it."),
      });
    }

    it("re-asks the last question with its options and answer", () => {
      const state = guideReducer(twoAnswered(), { type: "back", step: 2 });
      expect(state.step).toBe(3);
      expect(state.answers).toEqual([
        { question: "What bothers you?", answer: "A" },
      ]);
      expect(state.asked).toEqual([
        { text: "What bothers you?", options: ["A", "B"] },
      ]);
      expect(state.view).toEqual({
        phase: "asking",
        question: { text: "Which device?", options: ["A", "B"] },
        reaction: null,
        answer: "Mobile",
      });
    });

    it("goes back while the next question is still loading", () => {
      let state = guideReducer(startGuide("Improve search"), {
        type: "resolved",
        step: 0,
        result: ask("What bothers you?"),
      });
      state = guideReducer(state, { type: "answered", step: 0, answer: "B" });
      expect(state.view.phase).toBe("thinking");
      state = guideReducer(state, { type: "back", step: 1 });
      expect(state.answers).toEqual([]);
      expect(state.view).toMatchObject({ phase: "asking", answer: "B" });
      // The reply for the step the person left does not replace the screen.
      expect(
        guideReducer(state, {
          type: "resolved",
          step: 1,
          result: ask("Stale question"),
        }),
      ).toBe(state);
    });

    it("replaces the answer when the question is answered again", () => {
      let state = guideReducer(twoAnswered(), { type: "back", step: 2 });
      state = guideReducer(state, {
        type: "answered",
        step: 3,
        answer: "Desktop",
      });
      expect(state.answers).toEqual([
        { question: "What bothers you?", answer: "A" },
        { question: "Which device?", answer: "Desktop" },
      ]);
      expect(state.asked).toHaveLength(2);
    });

    it("has nowhere to go before the first answer", () => {
      const state = guideReducer(startGuide("Improve search"), {
        type: "resolved",
        step: 0,
        result: ask("What bothers you?"),
      });
      expect(guideReducer(state, { type: "back", step: 0 })).toBe(state);
    });

    it("goes back from the last beat to the last question", () => {
      let state = guideReducer(twoAnswered(), {
        type: "answered",
        step: 2,
        answer: "",
      });
      state = guideReducer(state, { type: "resolved", step: 3, result: done });
      expect(state.view.phase).toBe("building");
      state = guideReducer(state, { type: "back", step: 3 });
      expect(state.view).toMatchObject({
        phase: "asking",
        question: { text: "How often?" },
        answer: "",
      });
    });
  });
});
