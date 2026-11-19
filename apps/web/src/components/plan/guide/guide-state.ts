/**
 * The Plan page's guided intro as a pure state machine: thinking → asking →
 * thinking → … → building. The fast model picks each question; the agent
 * only starts once the intro reaches `building`.
 *
 * Every step has a number, so a model reply that arrives after the person
 * moved on (answered, or went back) is dropped instead of overwriting the
 * screen they are on.
 */

import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import type { GuideAnswer } from "../business-case-prompt.ts";

export type NextStep = StudioToolOutput<"PLAN_CASE_NEXT_QUESTION">;
type GuideQuestion = NonNullable<NextStep["question"]>;

export type GuideView =
  | { phase: "thinking" }
  | { phase: "asking"; question: GuideQuestion; reaction: string | null }
  /** `guided`: the model said it had enough. False when it failed and the
   *  agent gets the idea as it is. */
  | { phase: "building"; guided: boolean };

export interface GuideState {
  step: number;
  idea: string;
  answers: GuideAnswer[];
  /** The case title the model suggested, once it has one. */
  title: string | null;
  view: GuideView;
}

export type GuideAction =
  | { type: "answered"; step: number; answer: string }
  | { type: "resolved"; step: number; result: NextStep }
  | { type: "failed"; step: number };

export function startGuide(idea: string): GuideState {
  return {
    step: 0,
    idea: idea.trim(),
    answers: [],
    title: null,
    view: { phase: "thinking" },
  };
}

export function guideReducer(
  state: GuideState,
  action: GuideAction,
): GuideState {
  if (action.step !== state.step) return state;
  switch (action.type) {
    case "answered": {
      if (state.view.phase !== "asking") return state;
      return {
        ...state,
        step: state.step + 1,
        answers: [
          ...state.answers,
          { question: state.view.question.text, answer: action.answer.trim() },
        ],
        view: { phase: "thinking" },
      };
    }
    case "resolved": {
      if (state.view.phase !== "thinking") return state;
      const { question, reaction, title } = action.result;
      return {
        ...state,
        title: title ?? state.title,
        view: question
          ? { phase: "asking", question, reaction }
          : { phase: "building", guided: true },
      };
    }
    case "failed": {
      if (state.view.phase !== "thinking") return state;
      return { ...state, view: { phase: "building", guided: false } };
    }
  }
}

/**
 * What the agent's prompt says about the intro: the answers when there are
 * any or the model ran to the end; nothing when it failed before asking, so
 * the agent asks as it always did.
 */
export function guideAnswers(state: GuideState): GuideAnswer[] | undefined {
  const guided = state.view.phase === "building" && state.view.guided;
  return guided || state.answers.length > 0 ? state.answers : undefined;
}
